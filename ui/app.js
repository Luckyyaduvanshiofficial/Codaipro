/**
 * Codai Pro - Modular Offline Architecture
 * Engineered for low-end CPU systems with latency compensation, safe generation stopping, and high-performance rendering.
 */

// ----------------------------------------------------
// STATE MANAGEMENT & CONSTANTS
// ----------------------------------------------------

const State = {
    systemPrompt: "You are Codai Pro. Be brief, direct, and local.",
    isGenerating: false,
    hasStartedChat: false,
    abortController: null,
    userIsReading: false,
    engineStatus: "unknown",
    startupPhase: "initializing",
    lastRequestId: null,
    backendPort: 8080,
    conversation: [],
    maxHistoryMessages: 4,
    maxHistoryChars: 1200,
    get backendUrl() {
        return window.location.protocol === "file:" ? `http://127.0.0.1:${this.backendPort}` : window.location.origin;
    },
    get engineUrl() {
        return `http://127.0.0.1:${this.backendPort + 1}/`;
    }
};

const FRONTEND_ERROR_COOLDOWN_MS = 4000;
const FrontendErrorState = {
    lastSignature: "",
    lastSentAt: 0,
};

function isEnvelope(payload) {
    return Boolean(payload)
        && typeof payload === "object"
        && typeof payload.status === "string"
        && typeof payload.request_id === "string"
        && Object.prototype.hasOwnProperty.call(payload, "data")
        && Object.prototype.hasOwnProperty.call(payload, "error");
}

async function readEnvelope(response) {
    const payload = await response.json();
    if (!isEnvelope(payload)) {
        throw new Error("Invalid response envelope");
    }
    State.lastRequestId = payload.request_id;
    return payload;
}

function extractErrorMessage(payload, fallback) {
    if (payload?.error?.message) return payload.error.message;
    if (typeof payload?.data?.message === "string") return payload.data.message;
    return fallback;
}

function extractAssistantText(payload) {
    const choice = payload?.choices?.[0];
    return (
        choice?.message?.content
        || choice?.text
        || choice?.content
        || payload?.output_text
        || ""
    );
}

function extractStreamText(payload) {
    const choice = payload?.choices?.[0];
    return (
        choice?.delta?.content
        || choice?.message?.content
        || choice?.text
        || choice?.content
        || payload?.output_text
        || ""
    );
}

function rememberTurn(role, content) {
    if (!content) return;
    State.conversation.push({ role, content: String(content) });
    if (State.conversation.length > State.maxHistoryMessages) {
        State.conversation = State.conversation.slice(-State.maxHistoryMessages);
    }
}

function buildMessageHistory(promptText) {
    const history = [];
    let charCount = promptText.length + State.systemPrompt.length;

    for (let i = State.conversation.length - 1; i >= 0; i--) {
        const turn = State.conversation[i];
        const turnLength = turn.content.length;
        if (history.length >= State.maxHistoryMessages) break;
        if (charCount + turnLength > State.maxHistoryChars) break;
        history.unshift(turn);
        charCount += turnLength;
    }

    return [
        { role: "system", content: State.systemPrompt },
        ...history,
        { role: "user", content: promptText }
    ];
}

function forwardFrontendError(kind, details) {
    const signature = `${kind}:${details.message || "unknown"}:${details.stack || ""}`;
    const now = Date.now();
    const isDuplicate = signature === FrontendErrorState.lastSignature;
    const isCoolingDown = now - FrontendErrorState.lastSentAt < FRONTEND_ERROR_COOLDOWN_MS;

    if (isDuplicate && isCoolingDown) {
        return;
    }

    FrontendErrorState.lastSignature = signature;
    FrontendErrorState.lastSentAt = now;

    fetch(`${State.backendUrl}/frontend-error`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            kind,
            ...details,
        }),
    }).catch(error => console.error("Could not forward error to proxy:", error));
}

// Requirement 15: Cross-Tab Session Isolation Lock
const SESSION_LOCK_ID = "codai_tab_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
State.lockTimer = setInterval(() => {
    const time = parseInt(localStorage.getItem('codai_tab_time') || "0");
    const active = localStorage.getItem('codai_active_tab');
    if (!active || active === SESSION_LOCK_ID || (Date.now() - time) > 7000) {
        localStorage.setItem('codai_active_tab', SESSION_LOCK_ID);
        localStorage.setItem('codai_tab_time', Date.now().toString());
        const m = document.getElementById("tab-lock-modal");
        if (m) m.remove();
    } else {
        if (!document.getElementById("tab-lock-modal")) {
            const m = document.createElement("div");
            m.id = "tab-lock-modal";
            m.className = "tab-lock-modal";
            m.innerHTML = "<div>⚠️<br><br>Another Codai tab is actively communicating with the runtime.<br><span style='font-size:1rem;color:#888;'>Please close this tab or the other to prevent queue collision.</span></div>";
            document.body.appendChild(m);
        }
    }
}, 2500);

// Global Error Catching
window.onerror = function(message, source, lineno, colno, error) {
    console.error("Global JS Error:", message, source, lineno, colno, error);
    forwardFrontendError("window.onerror", {
        message: `JS Error: ${message}`,
        source,
        lineno,
        colno,
        stack: error ? error.stack : "",
    });
};
window.addEventListener('unhandledrejection', function(event) {
    console.error("Unhandled Promise Rejection:", event.reason);
    forwardFrontendError("unhandledrejection", {
        message: `Promise Rejection: ${event.reason?.message || event.reason}`,
        stack: event.reason?.stack || "",
    });
});

// Engine status → UI mapping
const STATUS_MAP = {
    starting:       { text: "Initializing AI Engine...",     variant: "warning" },
    loading_model:  { text: "Loading model into memory...",  variant: "warning" },
    binding_port:   { text: "Connecting interface...",       variant: "warning" },
    running:        { text: "CPU Mode Active",               variant: "default" },
    restarting:     { text: "Engine restarting...",           variant: "warning" },
    crashed:        { text: "Engine crashed — recovering...", variant: "offline" },
    stopped:        { text: "Generation stopped",            variant: "default" },
    shutting_down:  { text: "Shutting down...",              variant: "warning" },
    unknown:        { text: "Connecting...",                 variant: "warning" },
};

// Startup phase → human readable
const PHASE_MAP = {
    initializing:      "Initializing system...",
    analyzing_hardware:"Analyzing hardware...",
    loading_model:     "Loading AI model...",
    binding_port:      "Binding network port...",
    ready:             "System ready",
    shutting_down:     "Shutting down...",
    crashed:           "System error",
};

// ----------------------------------------------------
// SYSTEM BRIDGE — Real-time backend health polling
// Polls llama-server /health endpoint (works with file:// protocol)
// Future-proof: can be swapped to WebSocket or system_info.json API
// ----------------------------------------------------
const SystemBridge = {
    _pollTimer: null,
    _consecutiveErrors: 0,
    _maxErrors: 10,
    _pollInterval: 6000,

    els: {
        notification: null,
        infoBar: null,
    },

    init() {
        this.els.notification = document.getElementById('system-notification');
        this.els.infoBar = document.getElementById('system-info-bar');
        this.startPolling();
    },

    startPolling() {
        this._poll();
        this._pollTimer = setInterval(() => this._poll(), this._pollInterval);
    },

    stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    },

    async _poll() {
        try {
            const response = await fetch(`${State.backendUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(3000)
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const envelope = await readEnvelope(response);
            const data = envelope.data || {};

            if (Number.isFinite(Number(data.proxy_port))) {
                State.backendPort = Number(data.proxy_port);
            }
            const engineLink = document.getElementById('engine-ui-link');
            if (engineLink) {
                engineLink.href = State.engineUrl;
            }
            this._consecutiveErrors = 0;
            State.startupPhase = data.phase || State.startupPhase;

            if (data.debug && !this._devLoggerActive) {
                this._devLoggerActive = true;
                console.info("[SYSTEM] Debug mode detected. Logs available at /logs");
            }

            const displayStatus = data.engine === 'running'
                ? 'running'
                : (data.engine_display || (data.phase === 'crashed' ? 'crashed' : 'starting'));

            requestAnimationFrame(() => this._applyState(displayStatus));

            if (this.els.infoBar) {
                const queueSuffix = data.queue ? ` • Queue: ${data.queue}` : '';
                const nextInfo = `${PHASE_MAP[data.phase] || 'System active'} • Uptime: ${data.uptime || 'n/a'}${queueSuffix}`;
                if (this.els.infoBar.innerText !== nextInfo) {
                    this.els.infoBar.innerText = nextInfo;
                }
            }

            if (data.engine === 'running') {
                this._hideNotification();
                this._setInputEnabled(true);
            }
        } catch (err) {
            this._handlePollError(err);
        }
    },

    _handlePollError(err) {
        if (err) console.error("SystemBridge Polling Error:", err.message || err);

        this._consecutiveErrors++;
        if (this._consecutiveErrors >= this._maxErrors && State.engineStatus !== 'crashed') {
            State.engineStatus = 'crashed';
            requestAnimationFrame(() => {
                this._updateStatus('crashed');
                this._showNotification('Backend not reachable', 'error');
                this._setInputEnabled(false);
            });
        }
    },

    _applyState(newStatus) {
        const prevStatus = State.engineStatus;
        State.engineStatus = newStatus;

        if (!State.isGenerating) {
            this._updateStatus(newStatus);
        }

        if (prevStatus !== newStatus) {
            this._handleTransition(prevStatus, newStatus);
        }
    },

    _updateStatus(status) {
        const mapped = STATUS_MAP[status] || STATUS_MAP.unknown;
        UI.updateStatus(mapped.text, mapped.variant);
    },

    _handleTransition(prev, next) {
        if (next === 'crashed') {
            this._showNotification('Engine crashed — attempting recovery...', 'error');
            this._setInputEnabled(false);
            if (State.isGenerating && State.abortController) {
                State.abortController.abort();
            }
        }

        if (next === 'running' && (prev === 'crashed' || prev === 'loading_model' || prev === 'unknown' || prev === 'starting')) {
            this._hideNotification();
            this._setInputEnabled(true);
        }
    },

    _showNotification(message, type = 'default', showSpinner = false) {
        if (!this.els.notification) return;
        const spinner = showSpinner ? '<div class="notif-spinner"></div>' : '';
        this.els.notification.innerHTML = `${spinner}<span>${message}</span>`;
        this.els.notification.className = `system-notification ${type}`;
    },

    _hideNotification() {
        if (!this.els.notification) return;
        this.els.notification.className = 'system-notification hidden';
    },

    _setInputEnabled(enabled) {
        const inputBox = document.getElementById('input-box');
        if (!inputBox) return;
        inputBox.classList.toggle('disabled', !enabled);
    }
};

// ----------------------------------------------------
// UI RENDERING MODULE
// ----------------------------------------------------
const UI = {
    els: {
        chatArea: document.getElementById('chat-area'),
        msgsContainer: document.getElementById('messages-container'),
        emptyState: document.getElementById('empty-state'),
        input: document.getElementById('prompt-input'),
        btnSend: document.getElementById('send-button'),
        btnStop: document.getElementById('stop-button'),
        inputBox: document.getElementById('input-box'),
        charLimitWarning: document.getElementById('char-limit'),
        sysStatus: document.getElementById('system-status'),
        sysStatusText: document.getElementById('status-text-label')
    },

    init() {
        this.setupEventListeners();
        if (window.location.protocol !== "file:") {
            const currentPort = Number(window.location.port);
            if (Number.isFinite(currentPort) && currentPort > 0) {
                State.backendPort = currentPort;
            }
        }
        const engineLink = document.getElementById('engine-ui-link');
        if (engineLink) {
            engineLink.href = State.engineUrl;
        }
        this.els.input.focus();
    },

    setupEventListeners() {
        // Input Focus & Elevation
        this.els.input.addEventListener('focus', () => this.els.inputBox.classList.add('focused'));
        this.els.input.addEventListener('blur', () => this.els.inputBox.classList.remove('focused'));

        this.els.input.addEventListener('input', () => {
            this.els.input.style.height = 'auto'; // Recalculate size
            this.els.input.style.height = Math.min(this.els.input.scrollHeight, 250) + 'px';
            
            const textL = this.els.input.value.trim().length;
            this.els.btnSend.disabled = textL === 0 || State.isGenerating;
            
            if (textL > 1500 && !this.els.charLimitWarning.classList.contains('visible')) {
                this.els.charLimitWarning.textContent = "Processing large input on CPU...";
                this.els.charLimitWarning.classList.add('visible');
            } else if (textL <= 1500) {
                this.els.charLimitWarning.classList.remove('visible');
            }
        });

        // Advanced UX: Paste Detection
        this.els.input.addEventListener('paste', (e) => {
            const pastedText = (e.clipboardData || window.clipboardData).getData('text');
            if (pastedText && pastedText.length > 800) {
                this.els.charLimitWarning.textContent = "Code detected (large input, CPU processing may take time)";
                this.els.charLimitWarning.classList.add('visible');
            }
        });

        this.els.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!this.els.btnSend.disabled) API.handleSend();
            }
        });

        this.els.btnSend.addEventListener('click', () => API.handleSend());
        this.els.btnStop.addEventListener('click', () => API.stopGeneration());

        // Smart Scrolling safeguards
        this.els.chatArea.addEventListener('scroll', () => {
            const distanceToBottom = this.els.chatArea.scrollHeight - this.els.chatArea.scrollTop - this.els.chatArea.clientHeight;
            State.userIsReading = distanceToBottom > 150;
        });

        // Event Delegation for micro-interaction ripples
        document.body.addEventListener('click', (e) => {
            const rippleBtn = e.target.closest('.ripple');
            if (rippleBtn) this.createRipple(e, rippleBtn);
        });
    },

    createRipple(e, button) {
        const circle = document.createElement('span');
        const diameter = Math.max(button.clientWidth, button.clientHeight);
        const radius = diameter / 2;
        const rect = button.getBoundingClientRect();
        
        circle.style.width = circle.style.height = `${diameter}px`;
        circle.style.left = `${e.clientX - rect.left - radius}px`;
        circle.style.top = `${e.clientY - rect.top - radius}px`;
        circle.classList.add('ripple-span');

        const existing = button.querySelector('.ripple-span');
        if (existing) existing.remove();
        button.appendChild(circle);
    },

    toggleIOState(isGenerating) {
        State.isGenerating = isGenerating;
        if (isGenerating) {
            this.els.btnSend.classList.add('hidden');
            this.els.btnStop.classList.remove('hidden');
            this.updateStatus("Generating...", "streaming");
        } else {
            this.els.btnSend.classList.remove('hidden');
            this.els.btnStop.classList.add('hidden');
            this.els.input.dispatchEvent(new Event('input')); // Recalculate disable state
        }
    },

    hideEmptyState() {
        if (!State.hasStartedChat) {
            State.hasStartedChat = true;
            this.els.emptyState.classList.add('hidden');
            setTimeout(() => { this.els.emptyState.style.display = 'none'; }, 400); // Wait for transition
        }
    },

    createBubble(isUser) {
        const row = document.createElement('div');
        row.className = `message-row ${isUser ? 'message-user' : 'message-ai'}`;
        
        const bubble = document.createElement('div');
        bubble.className = `bubble ${isUser ? 'bubble-user' : 'bubble-ai'}`;
        
        row.appendChild(bubble);
        this.els.msgsContainer.appendChild(row);
        this.scrollBottom();
        
        return { row, bubble };
    },

    appendUser(text) {
        const { bubble } = this.createBubble(true);
        // Secure ingestion directly into textContent
        bubble.textContent = text;
        bubble.style.whiteSpace = "pre-wrap";
    },

    clearTimers() {
        return;
    },

    renderError(msg, originalPrompt) {
        const { bubble } = this.createBubble(false);
        // Keep error handling minimal and fast.
        bubble.innerHTML = `
            <div class="error-card">
                <div class="error-text">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                    System Error: ${this.escapeInline(msg)}
                </div>
                <div class="error-actions">
                    <button class="retry-btn ripple" onclick="this.parentElement.parentElement.remove()" style="border-color: var(--text-tertiary); color: var(--text-tertiary);">Dismiss</button>
                </div>
            </div>
        `;
        this.scrollBottom();
    },

    escapeInline(str) {
        return str.replace(/[&<>'"]/g, tag => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[tag] || tag));
    },

    updateStatus(message, stateVariant = "default") {
        this.els.sysStatusText.textContent = message;
        this.els.sysStatus.className = 'status-indicator';
        if (stateVariant === "offline") this.els.sysStatus.classList.add('offline');
        if (stateVariant === "streaming") this.els.sysStatus.classList.add('streaming');
        // 'stopped' naturally falls back to default style
    },

    // New function for system messages (as per instruction)
    showSystemMessage(message, type = 'default') {
        SystemBridge._showNotification(message, type);
    },

    scrollBottom() {
        if (!State.userIsReading) {
            this.els.chatArea.scrollTop = this.els.chatArea.scrollHeight;
        }
    }
};

// ----------------------------------------------------
// API ENGINE (LOW-LATENCY SINGLE-SHOT MODE)
// ----------------------------------------------------
const API = {
    async handleSend() {
        const promptText = UI.els.input.value.trim();
        if (!promptText || State.isGenerating) return;

        UI.clearTimers();
        UI.els.input.value = '';
        UI.els.charLimitWarning.classList.remove('visible');
        UI.hideEmptyState();
        UI.appendUser(promptText);

        UI.toggleIOState(true);
        UI.updateStatus("Generating...", "streaming");

        State.abortController = new AbortController();
        const startTime = performance.now();
        let finalBubbleReference = null;
        const completionBudget = promptText.length <= 20 ? 128 : promptText.length <= 120 ? 160 : 224;
        const requestMessages = buildMessageHistory(promptText);
        let streamedText = "";

        try {
            const response = await fetch(`${State.backendUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: State.abortController.signal,
                body: JSON.stringify({
                    messages: requestMessages,
                    temperature: 0.1,
                    max_tokens: completionBudget,
                    stream: true
                })
            });

            if (!response.ok) {
                const envelope = await readEnvelope(response);
                const errText = extractErrorMessage(
                    envelope,
                    `Backend not reachable (HTTP ${response.status})`
                );
                UI.showSystemMessage(errText, 'error');
                UI.renderError(errText, promptText);
                return;
            }

            const { bubble: answerBubble } = UI.createBubble(false);
            finalBubbleReference = answerBubble;
            streamedText = await this.consumeStream(response, answerBubble);
            const aiCompleteText = streamedText.trim();
            if (!aiCompleteText) {
                throw new Error("Model returned malformed or empty output.");
            }

            rememberTurn("user", promptText);
            rememberTurn("assistant", aiCompleteText);
            this.finalizeResponse(aiCompleteText, startTime, finalBubbleReference, false);
        } catch (err) {
            UI.clearTimers();

            if (err.name === 'AbortError') {
                if (finalBubbleReference?.parentElement) {
                    finalBubbleReference.parentElement.remove();
                }
                UI.updateStatus('Stopped', 'default');
                return;
            }

            console.error("Critical Engine Error:", err);
            const errMsg = err.message?.includes('timeout')
                ? 'Response took too long and timed out due to CPU constraints.'
                : (err.message || 'Model returned malformed or unexpected output.');

            if (finalBubbleReference?.parentElement) {
                finalBubbleReference.parentElement.remove();
            }

            UI.renderError(errMsg, promptText);
            UI.showSystemMessage(errMsg, 'error');
            if (State.engineStatus !== 'crashed') {
                UI.updateStatus('Engine Offline', 'offline');
            }
        } finally {
            UI.clearTimers();
            UI.toggleIOState(false);
            State.abortController = null;
            UI.els.input.focus();
        }
    },

    stopGeneration() {
        UI.clearTimers();
        if (State.abortController) {
            State.abortController.abort();
        }
        UI.updateStatus("Stopped", "default");
    },

    async consumeStream(response, bubbleElem) {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error("Streaming response body is unavailable.");
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let completeReceived = false;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let boundaryIndex = buffer.indexOf("\n\n");
            while (boundaryIndex !== -1) {
                const rawEvent = buffer.slice(0, boundaryIndex);
                buffer = buffer.slice(boundaryIndex + 2);
                this.processStreamEvent(rawEvent, bubbleElem, {
                    append: chunk => {
                        if (!chunk) return;
                        fullText += chunk;
                        bubbleElem.textContent = fullText;
                        bubbleElem.style.whiteSpace = "pre-wrap";
                        UI.scrollBottom();
                    },
                    markComplete: () => {
                        completeReceived = true;
                    }
                });
                boundaryIndex = buffer.indexOf("\n\n");
            }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
            this.processStreamEvent(buffer.trim(), bubbleElem, {
                append: chunk => {
                    if (!chunk) return;
                    fullText += chunk;
                    bubbleElem.textContent = fullText;
                    bubbleElem.style.whiteSpace = "pre-wrap";
                    UI.scrollBottom();
                },
                markComplete: () => {
                    completeReceived = true;
                }
            });
        }

        if (!completeReceived && !fullText.trim()) {
            throw new Error("Stream ended without returning any text.");
        }

        return fullText;
    },

    processStreamEvent(rawEvent, bubbleElem, handlers) {
        const dataLines = rawEvent
            .split("\n")
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trim());

        if (dataLines.length === 0) return;

        const payloadText = dataLines.join("\n");
        let envelope;
        try {
            envelope = JSON.parse(payloadText);
        } catch {
            return;
        }

        if (envelope.status === "complete") {
            handlers.markComplete();
            return;
        }

        if (envelope.status !== "streaming") {
            return;
        }

        const chunk = extractStreamText(envelope.data);
        handlers.append(chunk);
    },

    finalizeResponse(text, startTime, bubbleElem, wasAborted) {
        if (!text) return;
        
        const timeSecs = ((performance.now() - startTime) / 1000).toFixed(1);
        
        // Fast path for plain responses; keep markdown parsing only when needed.
        const needsMarkdown = /```|`[^`\n]+`|\*\*[^*]+\*\*|^[ \t]*[-*]\s/m.test(text);
        if (needsMarkdown) {
            text = Markdown.applyCodeFallback(text);
            bubbleElem.innerHTML = Markdown.parse(text);
        } else {
            bubbleElem.textContent = text;
            bubbleElem.style.whiteSpace = "pre-wrap";
        }
        
        const meta = document.createElement('div');
        meta.className = `ai-meta-footer ${wasAborted ? 'stopped' : ''}`;

        if (wasAborted) {
            meta.textContent = "Generation stopped by user";
        } else {
            meta.textContent = `Local CPU • ${timeSecs}s`;
        }

        bubbleElem.appendChild(meta);
        UI.scrollBottom();
        
        if (!wasAborted) UI.updateStatus("CPU Mode Active", "default");
    }
};

// ----------------------------------------------------
// STRICT SECURE MARKDOWN COMPILER
// ----------------------------------------------------
const Markdown = {
    escapeStrict(str) {
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#39;');
    },

    applyCodeFallback(text) {
        if (text.includes('```')) return text; 
        const codeRegex = /^(import |def |class |function |const |let |var |if \(|for \(|while \(|#include|<html|<div|<\?php)/m;
        if (codeRegex.test(text)) {
            return "```\n" + text.trim() + "\n```";
        }
        return text;
    },

    parse(rawText) {
        if (!rawText) return '';
        
        let blocks = [];
        // Phase 1: Sub out all code blocks to avoid them getting double-escaped or malformed
        let structure = rawText.replace(/```([\s\S]*?)```/g, (match, block) => {
            blocks.push(block);
            return `__CODE_BLOCK_${blocks.length - 1}__`;
        });

        // Phase 2: Escape everything else entirely for 100% XSS immunity
        structure = this.escapeStrict(structure);

        // Phase 3: Build HTML structurally (Inline syntax)
        structure = structure.replace(/`([^`\n]+)`/g, (m, p1) => `<code>${p1}</code>`);
        structure = structure.replace(/\*\*([^*]+)\*\*/g, (m, p1) => `<strong>${p1}</strong>`);

        // Phase 4: Lists & Paragraphs
        structure = structure.split('\n\n').map(p => {
            if (p.trim().startsWith('- ') || p.trim().startsWith('* ')) {
                const items = p.trim().split('\n')
                    .filter(i => i.trim().length > 0)
                    .map(item => `<li>${item.replace(/^[-*]\s/, '')}</li>`)
                    .join('');
                return `<ul>${items}</ul>`;
            }
            return `<p>${p.replace(/\n/g, '<br>')}</p>`;
        }).join('');

        // Phase 5: Re-insert cleanly built code blocks
        blocks.forEach((block, i) => {
            let lines = block.trim().split('\n');
            let lang = lines[0].trim().match(/^[a-z0-9+#-]+$/i) ? lines.shift() : 'CODE';
            // Secure code contents natively
            let safeCode = this.escapeStrict(lines.join('\n'));
            let encodedCode = encodeURIComponent(safeCode);
            
            const header = `
                <div class="code-header">
                    <span>${lang.toUpperCase()}</span>
                    <div class="code-actions">
                        <button class="code-btn ripple" onclick="window.copySnippet('${encodedCode}', this)" title="Copy">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy
                        </button>
                    </div>
                </div>`;
            
            structure = structure.replace(`__CODE_BLOCK_${i}__`, `${header}<pre class="has-header"><code>${safeCode}</code></pre>`);
        });
        
        return `<div class="markdown-body">${structure}</div>`;
    },

    cleanCodeFormat(encodedCode) {
        let text = decodeURIComponent(encodedCode);
        // Reverse HTML escape specifically for clipboard extraction
        text = text.replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'");
        // Trim leading and trailing spacing, normalize Windows breaks
        return text.replace(/\r\n/g, '\n').trim();
    },

    copyAllCode() {}
};

// ----------------------------------------------------
// GLOBAL HOOKS (DOM interactions & Fallbacks)
// ----------------------------------------------------
window.useSuggestion = (text) => {
    if (State.isGenerating) return;
    UI.els.input.value = text;
    UI.els.input.dispatchEvent(new Event('input', { bubbles: true }));
    UI.els.input.focus();
    API.handleSend();
};

window.copySnippet = (encodedCode, btn) => {
    const cleanText = Markdown.cleanCodeFormat(encodedCode);
    navigator.clipboard.writeText(cleanText).then(() => {
        const oh = btn.innerHTML;
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12" stroke="#10a37f" stroke-width="2.5"></polyline></svg> <span style="color:#10a37f">Copied</span>`;
        setTimeout(() => { btn.innerHTML = oh; }, 2000);
    });
};

// Application Boot
document.addEventListener("DOMContentLoaded", () => {
    UI.init();
    SystemBridge.init();
});
