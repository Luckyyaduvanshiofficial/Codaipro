/**
 * Codai Pro - Modular Offline Architecture
 * Engineered for low-end CPU systems with latency compensation, safe generation stopping, and high-performance rendering.
 */

// ----------------------------------------------------
// STATE MANAGEMENT & CONSTANTS
// ----------------------------------------------------
const State = {
    chatHistory: [{ role: "system", content: "You are Codai Pro, an exceptionally precise offline AI coding assistant. Run securely and locally." }],
    isGenerating: false,
    hasStartedChat: false,
    abortController: null,
    maxHistory: 12,
    userIsReading: false,
    activeTimers: [],
    engineStatus: "unknown",
    startupPhase: "initializing",
    backendPort: 8080
};

const TYPING_MESSAGES = [
    { time: 0, text: "Waking up Local CPU Engine..." },
    { time: 1000, text: "Analyzing code context..." },
    { time: 3500, text: "Generating response natively..." },
    { time: 10000, text: "Response is taking longer due to hardware limits..." }
];

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
// SYSTEM BRIDGE — Real-time backend polling
// ----------------------------------------------------
const SystemBridge = {
    _pollTimer: null,
    _lastUpdate: null,
    _consecutiveErrors: 0,
    _maxErrors: 5,
    _pollInterval: 2000,

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
        this._poll();  // immediate first poll
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
            const response = await fetch('../logs/system_info.json?t=' + Date.now(), {
                cache: 'no-store'
            });

            if (!response.ok) {
                this._handlePollError();
                return;
            }

            let data;
            try {
                data = await response.json();
            } catch (parseErr) {
                // Partial/corrupt read — skip this cycle (atomic writes should prevent this)
                return;
            }

            this._consecutiveErrors = 0;

            // Change detection — skip DOM updates if nothing changed
            if (data.last_update && data.last_update === this._lastUpdate) {
                return;
            }
            this._lastUpdate = data.last_update;

            // Update backend port if it changed
            if (data.port) {
                State.backendPort = data.port;
            }

            requestAnimationFrame(() => this._applyState(data));

        } catch (err) {
            this._handlePollError();
        }
    },

    _handlePollError() {
        this._consecutiveErrors++;
        if (this._consecutiveErrors >= this._maxErrors && State.engineStatus !== 'crashed') {
            State.engineStatus = 'crashed';
            requestAnimationFrame(() => {
                this._updateStatus('crashed');
                this._showNotification('Backend not responding. Is the server running?', 'error');
                this._setInputEnabled(false);
            });
        }
    },

    _applyState(data) {
        const prevStatus = State.engineStatus;
        const newStatus = data.engine_status || 'unknown';
        State.engineStatus = newStatus;
        State.startupPhase = data.startup_phase || 'initializing';

        // 1. Update system info bar
        this._updateInfoBar(data);

        // 2. Skip status indicator update if user is mid-stream
        if (!State.isGenerating) {
            this._updateStatus(newStatus);
        }

        // 3. Handle state transitions
        if (prevStatus !== newStatus) {
            this._handleTransition(prevStatus, newStatus);
        }
    },

    _updateInfoBar(data) {
        if (!this.els.infoBar) return;
        const model = (data.model_name || 'unknown').replace('.gguf', '').replace(/-/g, ' ');
        const shortModel = model.length > 24 ? model.substring(0, 24) + '…' : model;
        this.els.infoBar.textContent = `${shortModel} • ${data.threads || '?'} threads • ${data.context_size || '?'} ctx`;
    },

    _updateStatus(status) {
        const mapped = STATUS_MAP[status] || STATUS_MAP.unknown;
        UI.updateStatus(mapped.text, mapped.variant);
    },

    _handleTransition(prev, next) {
        // Crash detection
        if (next === 'crashed') {
            this._showNotification('Engine crashed — attempting recovery...', 'error');
            this._setInputEnabled(false);
            // If streaming, abort the fetch
            if (State.isGenerating && State.abortController) {
                State.abortController.abort();
            }
        }

        // Restart visibility
        if (next === 'restarting') {
            this._showNotification('Engine restarting...', 'warning', true);
            this._setInputEnabled(false);
        }

        // Recovery: re-enable input
        if (next === 'running' && (prev === 'crashed' || prev === 'restarting' || prev === 'starting' || prev === 'unknown')) {
            this._hideNotification();
            this._setInputEnabled(true);
        }

        // Startup phases
        if (next === 'starting' || next === 'unknown') {
            const phaseText = PHASE_MAP[State.startupPhase] || 'Starting...';
            this._showNotification(phaseText, 'warning', true);
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
        if (enabled) {
            inputBox.classList.remove('disabled');
        } else {
            inputBox.classList.add('disabled');
        }
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
            this.updateStatus("Streaming response...", "streaming");
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

    startTypingIndicator() {
        UI.clearTimers(); // Memory safety 
        const { row, bubble } = this.createBubble(false);
        row.id = 'active-indicator';
        
        bubble.innerHTML = `
            <div class="dynamic-indicator">
                <div class="loading-spinner"></div>
                <span class="indicator-text" id="indicator-text">Initializing Request...</span>
            </div>
        `;
        
        const textNode = bubble.querySelector('#indicator-text');
        
        TYPING_MESSAGES.forEach(msg => {
            const timer = setTimeout(() => {
                if (textNode) textNode.textContent = msg.text;
            }, msg.time);
            State.activeTimers.push(timer);
        });
        
        return bubble;
    },

    removeTypingIndicator() {
        UI.clearTimers();
        const row = document.getElementById('active-indicator');
        if (row) row.remove();
    },

    clearTimers() {
        State.activeTimers.forEach(clearTimeout);
        State.activeTimers = [];
    },

    renderError(msg, originalPrompt) {
        const { bubble } = this.createBubble(false);
        // Double escaping logic prevents XSS injection via URL or prompts
        const safePrompt = encodeURIComponent(originalPrompt); 
        
        bubble.innerHTML = `
            <div class="error-card">
                <div class="error-text">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                    System Error: ${this.escapeInline(msg)}
                </div>
                <div class="error-actions">
                    <button class="retry-btn ripple" onclick="window.retryPrompt('${safePrompt}')">Retry Sequence</button>
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

    scrollBottom() {
        if (!State.userIsReading) {
            this.els.chatArea.scrollTo({ top: this.els.chatArea.scrollHeight, behavior: 'smooth' });
        }
    }
};

// ----------------------------------------------------
// API & STREAMING ENGINE (CRITICAL CPU OPTIMIZATION)
// ----------------------------------------------------
const API = {
    async handleSend() {
        const text = UI.els.input.value.trim();
        if (!text || State.isGenerating) return;

        UI.toggleIOState(true);
        UI.els.input.value = '';
        UI.els.charLimitWarning.classList.remove('visible');
        
        UI.hideEmptyState();
        UI.appendUser(text);

        State.chatHistory.push({ role: "user", content: text });
        if (State.chatHistory.length > State.maxHistory) {
            State.chatHistory.splice(1, 2);
        }

        await new Promise(r => setTimeout(r, 100)); // Natural interaction delay
        UI.startTypingIndicator();
        
        State.abortController = new AbortController();
        const startTime = performance.now();
        let aiCompleteText = "";
        let finalBubbleReference = null;

        try {
            const response = await fetch(`http://127.0.0.1:${State.backendPort}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: State.abortController.signal,
                body: JSON.stringify({
                    messages: State.chatHistory,
                    temperature: 0.1,
                    stream: true
                })
            });

            UI.removeTypingIndicator();

            if (!response.ok) throw new Error(response.status === 404 ? 'invalid_endpoint' : 'offline');

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            
            const { bubble: answerBubble } = UI.createBubble(false);
            finalBubbleReference = answerBubble;
            
            const streamBox = document.createElement('div');
            streamBox.className = "streaming-text";
            
            // UX Polish: Blinking cursor
            const cursor = document.createElement('span');
            cursor.className = 'cursor-blink';
            
            answerBubble.appendChild(streamBox);
            answerBubble.appendChild(cursor);
            
            let accumulatedVisibleStr = "";
            let streamBufferTime = performance.now();

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.substring(6).trim();
                        if (dataStr === '[DONE]') continue;

                        try {
                            const data = JSON.parse(dataStr);
                            const token = data.choices[0].delta?.content;
                            if (token) {
                                aiCompleteText += token;
                                accumulatedVisibleStr += token;
                                
                                const now = performance.now();
                                if (now - streamBufferTime > 35) { // 35ms batch rendering
                                    streamBox.textContent = accumulatedVisibleStr;
                                    streamBufferTime = now;
                                    UI.scrollBottom();
                                }
                            }
                        } catch (e) { /* Suppress */ }
                    }
                }
            }
            
            cursor.remove();
            streamBox.textContent = accumulatedVisibleStr; // final flush
            API.finalizeResponse(aiCompleteText, startTime, finalBubbleReference, false);

        } catch (err) {
            UI.removeTypingIndicator();
            
            if (err.name === 'AbortError') {
                if (aiCompleteText.trim().length > 0) {
                    API.finalizeResponse(aiCompleteText, startTime, finalBubbleReference, true);
                } else {
                    State.chatHistory.pop(); 
                    if(finalBubbleReference) finalBubbleReference.parentElement.remove();
                    UI.updateStatus('Stopped', 'default');
                }
            } else {
                console.error("Critical Engine Error:", err);
                let errMsg = 'Model returned malformed or unexpected output.';
                if (err.message === 'invalid_endpoint' || err.message === 'offline' || err.message.includes('fetch')) {
                    errMsg = `Local AI engine not running on port ${State.backendPort}. Start the backend server.`;
                } else if (err.message.includes('timeout')) {
                    errMsg = 'Response took too long and timed out due to CPU constraints.';
                }
                UI.renderError(errMsg, text);
                State.chatHistory.pop();
                // Don't override status if SystemBridge already shows crash
                if (State.engineStatus !== 'crashed') {
                    UI.updateStatus('Engine Offline', 'offline');
                }
            }
        } finally {
            UI.toggleIOState(false);
            UI.els.input.focus();
        }
    },

    stopGeneration() {
        if (State.abortController) {
            State.abortController.abort();
            UI.updateStatus("Stopped", "default");
        }
    },

    finalizeResponse(text, startTime, bubbleElem, wasAborted) {
        if (!text) return;

        State.chatHistory.push({ role: "assistant", content: text });
        
        const timeSecs = ((performance.now() - startTime) / 1000).toFixed(1);
        
        // Safety Fallback for unformatted models
        text = Markdown.applyCodeFallback(text);
        
        // Strict, Safe Markdown Rendering
        bubbleElem.innerHTML = Markdown.parse(text);
        
        // Construction of meta-footer
        const meta = document.createElement('div');
        meta.className = `ai-meta-footer ${wasAborted ? 'stopped' : ''}`;
        
        if (wasAborted) {
            meta.innerHTML = `<svg viewBox="0 0 24 24" fill="none" class="meta-icon" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12"></rect></svg> <span style="font-weight: 500;">⏹ Generation stopped by user</span>`;
        } else {
            const perfTier = timeSecs < 3.0 ? "Fast" : "Slow (CPU)";
            meta.innerHTML = `<svg viewBox="0 0 24 24" fill="none" class="meta-icon" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Local CPU • ${timeSecs}s (${perfTier})`;
        }

        // Feature: Copy All Code
        if (text.includes('```')) {
            const multiCopyBtn = document.createElement('button');
            multiCopyBtn.className = "copy-all-btn ripple";
            multiCopyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy All Code`;
            multiCopyBtn.onclick = () => Markdown.copyAllCode(bubbleElem, multiCopyBtn);
            meta.appendChild(multiCopyBtn);
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
                        <button class="code-btn ripple" onclick="window.explainCode(this)" title="Explain code">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> Explain
                        </button>
                        <button class="code-btn ripple" onclick="window.optimizeCode(this)" title="Optimize code">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg> Optimize
                        </button>
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

    copyAllCode(bubbleElem, btn) {
        const blocks = Array.from(bubbleElem.querySelectorAll('pre code'));
        if (blocks.length === 0) return;
        
        const combinedString = blocks.map((b, i) => `// --- Block ${i+1} ---\n${b.innerText.trim()}`).join('\n\n');
        
        navigator.clipboard.writeText(combinedString).then(() => {
            const originalHtml = btn.innerHTML;
            btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12" stroke="#10a37f" stroke-width="2.5"></polyline></svg> Copied All!`;
            setTimeout(() => { btn.innerHTML = originalHtml; }, 2000);
        });
    }
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

window.retryPrompt = (encodedText) => {
    UI.els.input.value = decodeURIComponent(encodedText);
    UI.els.input.dispatchEvent(new Event('input'));
    document.querySelector('.error-card').parentElement.remove();
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

window.explainCode = (btn) => {
    const codeText = btn.parentElement.parentElement.nextElementSibling.innerText.trim();
    window.useSuggestion("Please explain this code snippet in detail:\n\n```\n" + codeText + "\n```");
};

window.optimizeCode = (btn) => {
    const codeText = btn.parentElement.parentElement.nextElementSibling.innerText.trim();
    window.useSuggestion("Please optimize this code for performance and explain your changes:\n\n```\n" + codeText + "\n```");
};

// Application Boot
document.addEventListener("DOMContentLoaded", () => {
    UI.init();
    SystemBridge.init();
});
