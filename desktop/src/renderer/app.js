/* Codai Pro renderer. Talks to the main process only through window.codai (preload). */
(function () {
  'use strict';

  const api = window.codai;
  const { render: renderMarkdown, escapeHtml } = window.CodaiMarkdown;

  const els = {
    app: document.getElementById('app'),
    list: document.getElementById('conv-list'),
    search: document.getElementById('search'),
    title: document.getElementById('chat-title'),
    status: document.getElementById('status'),
    statusText: document.getElementById('status-text'),
    notice: document.getElementById('notice'),
    engineCard: document.getElementById('engine-card'),
    ecTitle: document.getElementById('ec-title'),
    ecMessage: document.getElementById('ec-message'),
    ecHint: document.getElementById('ec-hint'),
    ecDetail: document.getElementById('ec-detail'),
    ecRetry: document.getElementById('ec-retry'),
    ecLogs: document.getElementById('ec-logs'),
    thread: document.getElementById('thread'),
    welcome: document.getElementById('welcome'),
    messages: document.getElementById('messages'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    stop: document.getElementById('stop'),
    newChat: document.getElementById('new-chat'),
    toggleSidebar: document.getElementById('toggle-sidebar'),
    expandSidebar: document.getElementById('expand-sidebar'),
    openSettings: document.getElementById('open-settings'),
    openLogs: document.getElementById('open-logs'),
    settingsModal: document.getElementById('settings-modal'),
    closeSettings: document.getElementById('close-settings'),
    saveSettings: document.getElementById('save-settings'),
    deleteAll: document.getElementById('delete-all'),
    setTheme: document.getElementById('set-theme'),
    setPrompt: document.getElementById('set-prompt'),
    setTemp: document.getElementById('set-temp'),
    setTempOut: document.getElementById('set-temp-out'),
    setTokens: document.getElementById('set-tokens'),
    setTokensOut: document.getElementById('set-tokens-out'),
  };

  const state = {
    data: { conversations: [], settings: {} },
    activeId: null,
    generating: null,
    runtimeReady: false,
    engineOffline: false,
    query: '',
  };

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  function activeConversation() {
    return state.data.conversations.find((c) => c.id === state.activeId) || null;
  }

  // Merge the sanitized result back into the existing object instead of replacing it, so
  // references taken before an await (for example the conversation being generated into)
  // still point at live data.
  function persist() {
    return api.data.save(state.data).then((saved) => {
      state.data.conversations = saved.conversations;
      state.data.settings = saved.settings;
    }).catch((error) => showNotice(`Could not save: ${error.message}`, 'error'));
  }

  // ---------- Notices and status ----------
  let noticeTimer = null;
  function showNotice(message, kind = '') {
    els.notice.textContent = message;
    els.notice.className = `notice ${kind}`.trim();
    clearTimeout(noticeTimer);
    if (kind !== 'error') {
      noticeTimer = setTimeout(() => els.notice.classList.add('hidden'), 4000);
    }
  }
  function hideNotice() {
    els.notice.classList.add('hidden');
  }

  // A startup problem is shown as a friendly card, with the raw error one click away.
  function showEngineError(info) {
    const payload = typeof info === 'string' ? { message: info } : (info || {});
    state.engineOffline = true;
    els.ecTitle.textContent = payload.title || "Codai Pro couldn't start";
    els.ecMessage.textContent = payload.message || 'The local AI engine did not start.';
    els.ecHint.textContent = payload.hint || '';
    els.ecHint.classList.toggle('hidden', !payload.hint);
    els.ecDetail.textContent = payload.detail || payload.message || '';
    els.ecRetry.disabled = false;
    els.ecRetry.textContent = 'Try again';
    els.engineCard.classList.remove('hidden');
    hideNotice();
  }

  function hideEngineError() {
    state.engineOffline = false;
    els.engineCard.classList.add('hidden');
  }

  els.ecRetry.addEventListener('click', async () => {
    els.ecRetry.disabled = true;
    els.ecRetry.textContent = 'Starting...';
    state.engineOffline = false;
    setStatus('Starting...', '');
    refreshSendState();
    try {
      const result = await api.runtime.restart();
      if (result && result.error) {
        showEngineError(result.error);
      }
    } catch (error) {
      showEngineError({
        title: "Codai Pro couldn't start",
        message: 'The engine did not start.',
        hint: 'Open the logs to see what happened, then try again.',
        detail: error.message,
      });
    } finally {
      els.ecRetry.disabled = false;
      els.ecRetry.textContent = 'Try again';
      refreshSendState();
    }
  });

  els.ecLogs.addEventListener('click', () => api.app.openLogs());

  const PHASE_TEXT = {
    initializing: 'Starting...',
    analyzing_hardware: 'Checking your computer...',
    downloading: 'Downloading the AI model (one time)...',
    loading_model: 'Loading the AI model...',
    binding_port: 'Almost ready...',
    ready: 'Ready',
    crashed: 'Engine offline',
    shutting_down: 'Shutting down...',
  };

  function setStatus(text, variant) {
    els.statusText.textContent = text;
    els.status.className = `status ${variant || ''}`.trim();
  }

  // ---------- Sidebar ----------
  function groupFor(ts) {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = 86_400_000;
    if (ts >= startToday) return 'Today';
    if (ts >= startToday - day) return 'Yesterday';
    if (ts >= startToday - 7 * day) return 'Previous 7 days';
    return 'Older';
  }

  function renderList() {
    const query = state.query.trim().toLowerCase();
    const matches = state.data.conversations
      .filter((c) => !query || c.title.toLowerCase().includes(query)
        || c.messages.some((m) => m.content.toLowerCase().includes(query)))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    els.list.innerHTML = '';
    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-search';
      empty.textContent = query ? 'No chats match your search.' : 'No chats yet.';
      els.list.appendChild(empty);
      return;
    }

    const groups = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];
    for (const label of groups) {
      const items = matches.filter((c) => groupFor(c.updatedAt) === label);
      if (items.length === 0) continue;
      const heading = document.createElement('div');
      heading.className = 'conv-group-label';
      heading.textContent = label;
      els.list.appendChild(heading);
      for (const conv of items) els.list.appendChild(convItem(conv));
    }
  }

  function convItem(conv) {
    const row = document.createElement('div');
    row.className = `conv-item${conv.id === state.activeId ? ' active' : ''}`;

    const open = document.createElement('button');
    open.className = 'conv-open';
    open.textContent = conv.title;
    open.title = conv.title;
    open.addEventListener('click', () => openConversation(conv.id));

    const actions = document.createElement('div');
    actions.className = 'conv-actions';
    actions.appendChild(miniButton('Rename', 'Rename chat', () => renameConversation(conv.id)));
    actions.appendChild(miniButton('Delete', 'Delete chat', () => deleteConversation(conv.id)));

    row.append(open, actions);
    return row;
  }

  function miniButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'mini-btn';
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  async function renameConversation(id) {
    const conv = state.data.conversations.find((c) => c.id === id);
    if (!conv) return;
    const next = window.prompt('Rename chat', conv.title);
    if (next === null) return;
    const title = next.trim().slice(0, 200);
    if (!title) return;
    conv.title = title;
    await persist();
    renderList();
    renderTitle();
  }

  async function deleteConversation(id) {
    const conv = state.data.conversations.find((c) => c.id === id);
    if (!conv) return;
    const confirmed = await api.dialog.confirm(`Delete "${conv.title}"? This cannot be undone.`);
    if (!confirmed) return;
    state.data.conversations = state.data.conversations.filter((c) => c.id !== id);
    if (state.activeId === id) {
      state.activeId = null;
      renderMessages();
    }
    await persist();
    renderList();
    renderTitle();
  }

  // ---------- Conversations ----------
  function newConversation() {
    if (state.generating) return;
    state.activeId = null;
    renderMessages();
    renderList();
    renderTitle();
    els.input.focus();
  }

  function openConversation(id) {
    if (state.generating) return;
    state.activeId = id;
    renderMessages();
    renderList();
    renderTitle();
    els.input.focus();
  }

  function renderTitle() {
    const conv = activeConversation();
    els.title.textContent = conv ? conv.title : 'Codai Pro';
    document.title = conv ? `${conv.title} - Codai Pro` : 'Codai Pro';
  }

  // ---------- Messages ----------
  function renderMessages() {
    const conv = activeConversation();
    els.messages.innerHTML = '';
    if (!conv || conv.messages.length === 0) {
      els.welcome.classList.remove('hidden');
      els.messages.classList.add('hidden');
      return;
    }
    els.welcome.classList.add('hidden');
    els.messages.classList.remove('hidden');
    conv.messages.forEach((message, index) => els.messages.appendChild(messageNode(message, index)));
    scrollToBottom(true);
  }

  function messageNode(message, index) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${message.role}`;
    wrap.dataset.index = String(index);

    const column = document.createElement('div');
    column.className = 'bubble';

    if (message.role === 'user') {
      column.textContent = message.content;
    } else if (message.status === 'error') {
      const note = document.createElement('div');
      note.className = 'msg-meta error';
      note.textContent = message.error || 'The response failed.';
      column.appendChild(note);
      column.appendChild(actionsFor(message, index, true));
    } else {
      column.innerHTML = renderMarkdown(message.content);
      if (message.status === 'stopped') {
        const note = document.createElement('div');
        note.className = 'msg-meta stopped';
        note.textContent = 'Stopped. Partial response kept.';
        column.appendChild(note);
      }
      column.appendChild(actionsFor(message, index));
    }

    column.addEventListener('click', onCodeCopy);
    wrap.appendChild(column);
    return wrap;
  }

  function actionsFor(message, index, failed = false) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    if (!failed) {
      bar.appendChild(miniButton('Copy', 'Copy response', () => copyText(message.content)));
    }
    if (index === activeConversation().messages.length - 1 && !state.generating) {
      bar.appendChild(miniButton('Regenerate', 'Regenerate response', regenerate));
    }
    return bar;
  }

  function onCodeCopy(event) {
    const btn = event.target.closest('[data-copy]');
    if (!btn) return;
    const source = btn.closest('.code-block').querySelector('.copy-source');
    copyText(source.value, btn);
  }

  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      if (!btn) return;
      const original = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }).catch(() => showNotice('Could not copy to the clipboard.', 'error'));
  }

  function scrollToBottom(force = false) {
    const nearBottom = els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < 160;
    if (force || nearBottom) els.thread.scrollTop = els.thread.scrollHeight;
  }

  function buildHistory(conv, upToIndex) {
    const system = { role: 'system', content: state.data.settings.systemPrompt };
    const history = conv.messages.slice(0, upToIndex)
      .filter((m) => m.content && (m.role === 'user' || m.status === 'complete'))
      .slice(-12)
      .map(({ role, content }) => ({ role, content }));
    return [system, ...history];
  }

  // ---------- Sending and streaming ----------
  async function sendPrompt(text) {
    if (state.generating || !state.runtimeReady) return;
    const prompt = text.trim();
    if (!prompt) return;

    let conv = activeConversation();
    if (!conv) {
      conv = {
        id: uid(),
        title: prompt.replace(/\s+/g, ' ').slice(0, 60),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      state.data.conversations.unshift(conv);
      state.activeId = conv.id;
    }

    conv.messages.push({ id: uid(), role: 'user', content: prompt, status: 'complete', createdAt: Date.now() });
    conv.updatedAt = Date.now();
    const convId = conv.id;
    await persist();
    // persist() replaces the saved objects; re-read the conversation before continuing.
    conv = state.data.conversations.find((c) => c.id === convId);
    if (!conv) return;
    els.input.value = '';
    autoSize();
    renderTitle();
    renderList();
    renderMessages();
    await generateReply(conv, conv.messages.length - 1);
  }

  async function regenerate() {
    const active = activeConversation();
    if (!active || state.generating) return;
    const last = active.messages[active.messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const convId = active.id;
    active.messages.pop();
    await persist();
    const conv = state.data.conversations.find((c) => c.id === convId);
    if (!conv) return;
    const prompt = conv.messages[conv.messages.length - 1];
    if (!prompt || prompt.role !== 'user') return;
    renderMessages();
    await generateReply(conv, conv.messages.length - 1);
  }

  async function generateReply(conv, promptIndex) {
    const requestId = uid();
    const assistant = { id: uid(), role: 'assistant', content: '', status: 'streaming', createdAt: Date.now() };
    const history = buildHistory(conv, promptIndex + 1);
    const { temperature, maxTokens } = state.data.settings;

    state.generating = { id: requestId };
    setBusy(true);

    const node = document.createElement('div');
    node.className = 'msg assistant';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = '<div class="typing" aria-label="Generating"><span></span><span></span><span></span></div>';
    node.appendChild(bubble);
    els.messages.appendChild(node);
    scrollToBottom(true);

    let text = '';
    let firstToken = true;
    let lastPaint = 0;
    // Repaint at most every ~80ms. Rendering partial markdown (rather than raw text) means
    // code fences and lists look right while they stream instead of showing stray backticks.
    const paint = (force) => {
      const now = performance.now();
      if (!force && now - lastPaint < 80) return;
      lastPaint = now;
      bubble.innerHTML = renderMarkdown(text);
      bubble.classList.add('cursor');
      scrollToBottom();
    };
    const offDelta = api.chat.onDelta(({ id, delta }) => {
      if (id !== requestId) return;
      if (firstToken) {
        firstToken = false;
        bubble.classList.add('cursor');
      }
      text += delta;
      paint(false);
    });
    const paintTimer = setInterval(() => paint(false), 100);

    let result;
    try {
      result = await api.chat.send({
        id: requestId,
        messages: history,
        options: { temperature, maxTokens },
      });
    } catch (error) {
      result = { status: 'error', text: '', error: error.message };
    } finally {
      offDelta();
      clearInterval(paintTimer);
      state.generating = null;
    }

    assistant.content = (result.text || text).trim();
    assistant.status = result.status === 'complete' ? 'complete' : (result.status === 'stopped' ? 'stopped' : 'error');
    assistant.error = result.error || undefined;

    if (assistant.status === 'error' && !assistant.content) {
      // Keep the failed turn in the conversation so the error is visible and Retry stays available.
      assistant.content = assistant.error || 'The response failed.';
    }

    conv.messages.push(assistant);
    conv.updatedAt = Date.now();
    await persist();
    setBusy(false);
    renderMessages();
    renderList();

    if (assistant.status === 'error') {
      showNotice(assistant.error || 'The response was interrupted.', 'error');
    } else {
      hideNotice();
    }
  }

  function setBusy(busy) {
    els.stop.classList.toggle('hidden', !busy);
    els.send.classList.toggle('hidden', busy);
    els.newChat.disabled = busy;
    if (busy) {
      setStatus('Generating...', 'busy');
    } else {
      refreshSendState();
      setStatus(state.runtimeReady ? 'Ready' : 'Starting...', state.runtimeReady ? 'ready' : '');
    }
  }

  function refreshSendState() {
    // Send stays available so the user can retry; an empty box simply does nothing until typed into.
    els.send.disabled = !state.runtimeReady || state.generating !== null;
    els.welcome.classList.toggle('is-disabled', !state.runtimeReady);
    if (state.runtimeReady) {
      els.input.placeholder = 'Message Codai Pro...';
    } else if (state.engineOffline) {
      els.input.placeholder = 'The engine is offline. Fix the problem above, then try again.';
    } else {
      els.input.placeholder = 'Waiting for the AI engine to start...';
    }
  }

  function stopGeneration() {
    if (state.generating) api.chat.stop(state.generating.id);
  }

  // ---------- Composer ----------
  function autoSize() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 220)}px`;
  }

  els.input.addEventListener('input', () => {
    autoSize();
    refreshSendState();
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!els.send.disabled) sendPrompt(els.input.value);
    }
  });

  els.send.addEventListener('click', () => sendPrompt(els.input.value));
  els.stop.addEventListener('click', stopGeneration);
  els.newChat.addEventListener('click', newConversation);

  els.welcome.addEventListener('click', (event) => {
    const card = event.target.closest('.suggestion');
    if (!card || !state.runtimeReady) return;
    sendPrompt(card.dataset.prompt);
  });

  // ---------- Sidebar toggle ----------
  function setSidebar(collapsed) {
    els.app.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem('codai.sidebarCollapsed', collapsed ? '1' : '0');
  }
  els.toggleSidebar.addEventListener('click', () => setSidebar(!els.app.classList.contains('sidebar-collapsed')));
  els.expandSidebar.addEventListener('click', () => setSidebar(false));
  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    renderList();
  });

  // ---------- Settings ----------
  function openSettings() {
    const s = state.data.settings;
    els.setTheme.value = s.theme;
    els.setPrompt.value = s.systemPrompt;
    els.setTemp.value = s.temperature;
    els.setTempOut.textContent = Number(s.temperature).toFixed(1);
    els.setTokens.value = s.maxTokens;
    els.setTokensOut.textContent = s.maxTokens;
    els.settingsModal.classList.remove('hidden');
    els.setTheme.focus();
  }
  function closeSettings() {
    els.settingsModal.classList.add('hidden');
    els.input.focus();
  }
  els.openSettings.addEventListener('click', openSettings);
  els.closeSettings.addEventListener('click', closeSettings);
  els.settingsModal.addEventListener('click', (event) => {
    if (event.target === els.settingsModal) closeSettings();
  });
  els.setTemp.addEventListener('input', () => { els.setTempOut.textContent = Number(els.setTemp.value).toFixed(1); });
  els.setTokens.addEventListener('input', () => { els.setTokensOut.textContent = els.setTokens.value; });

  els.saveSettings.addEventListener('click', async () => {
    const patch = {
      theme: els.setTheme.value,
      systemPrompt: els.setPrompt.value,
      temperature: Number(els.setTemp.value),
      maxTokens: Number(els.setTokens.value),
    };
    state.data.settings = await api.settings.update(patch);
    applyTheme();
    closeSettings();
    showNotice('Settings saved.');
  });

  els.deleteAll.addEventListener('click', async () => {
    const confirmed = await api.dialog.confirm('Delete all chats? This cannot be undone.');
    if (!confirmed) return;
    state.data.conversations = [];
    state.activeId = null;
    await persist();
    renderList();
    renderMessages();
    renderTitle();
    closeSettings();
  });

  els.openLogs.addEventListener('click', () => api.app.openLogs());

  function applyTheme() {
    const pref = state.data.settings.theme || 'system';
    const resolved = pref === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : pref;
    document.documentElement.setAttribute('data-theme', resolved);
  }
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

  // ---------- Keyboard shortcuts ----------
  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) {
      if (event.key === 'Escape') {
        if (!els.settingsModal.classList.contains('hidden')) closeSettings();
        else if (state.generating) stopGeneration();
      }
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'n') { event.preventDefault(); newConversation(); }
    if (key === 'k') { event.preventDefault(); els.search.focus(); els.search.select(); }
    if (key === 'b') { event.preventDefault(); setSidebar(!els.app.classList.contains('sidebar-collapsed')); }
    if (event.key === ',') { event.preventDefault(); openSettings(); }
  });

  // ---------- Runtime events ----------
  api.runtime.onPhase(({ phase }) => {
    if (!state.runtimeReady) setStatus(PHASE_TEXT[phase] || 'Starting...', '');
  });

  api.runtime.onReady(() => {
    state.runtimeReady = true;
    hideEngineError();
    hideNotice();
    setStatus('Ready', 'ready');
    refreshSendState();
  });

  api.runtime.onError((payload) => {
    state.runtimeReady = false;
    setStatus('Engine offline', 'error');
    showEngineError(payload);
    refreshSendState();
  });

  // ---------- Boot ----------
  async function boot() {
    setSidebar(localStorage.getItem('codai.sidebarCollapsed') === '1');
    state.data = await api.data.load();
    applyTheme();
    renderList();
    renderTitle();
    renderMessages();
    refreshSendState();

    const runtime = await api.runtime.info();
    if (runtime.ready) {
      state.runtimeReady = true;
      hideEngineError();
      setStatus('Ready', 'ready');
      refreshSendState();
    } else if (runtime.error) {
      state.runtimeReady = false;
      setStatus('Engine offline', 'error');
      showEngineError(runtime.error);
      refreshSendState();
    } else {
      setStatus('Starting...', '');
    }
    els.input.focus();
  }

  boot().catch((error) => showNotice(`Could not start the app: ${error.message}`, 'error'));
})();
