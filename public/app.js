/* ============================================================
   IA — Cliente del chat
   - Historial persistente en localStorage
   - Streaming SSE en tiempo real
   - Renderizado de Markdown propio (sin dependencias externas)
   ============================================================ */

(() => {
  'use strict';

  /* ------------------------------ Constantes ------------------------------ */

  const LS_CONVS = 'ia.conversations.v1';
  const LS_ACTIVE = 'ia.active.v1';
  const LS_SETTINGS = 'ia.settings.v1';

  const ICON_COPY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const ICON_REFRESH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
  const ICON_TRASH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
  const ICON_CHAT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  const SUGGESTIONS = [
    { icon: '✍️', label: 'Escríbeme un correo profesional', prompt: 'Escríbeme un correo profesional para pedir una reunión con mi equipo la próxima semana.' },
    { icon: '💡', label: 'Explícame algo fácil', prompt: 'Explícame la fotosíntesis como si tuviera 10 años.' },
    { icon: '👨‍💻', label: 'Ayúdame con código', prompt: 'Créame una página web sencilla con HTML y CSS para una cafetería.' },
    { icon: '🗺️', label: 'Plan de viaje', prompt: 'Hazme un plan de viaje de 3 días por Granada, en España.' },
  ];

  /* -------------------------------- Estado -------------------------------- */

  let conversations = [];
  let activeId = null;
  let streaming = false;
  let controller = null;
  let stickBottom = true;

  let settings = { name: 'IA', persona: '', model: 'gemini-2.5-flash' };
  try {
    settings = { ...settings, ...(JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') || {}) };
  } catch {
    /* valores por defecto */
  }

  try {
    conversations = JSON.parse(localStorage.getItem(LS_CONVS) || '[]') || [];
  } catch {
    conversations = [];
  }
  activeId = localStorage.getItem(LS_ACTIVE) || null;

  /* ------------------------------- Utilidades ------------------------------ */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(str = '') {
    return String(str).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[ch]);
  }

  function inlineMd(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return s;
  }

  /**
   * Renderizador de Markdown ligero (sin dependencias).
   * Soporta: código, encabezados, listas, citas, tablas, hr, negritas,
   * cursivas, enlaces y párrafos.
   */
  function mdToHtml(md = '') {
    if (!md) return '';

    // 1) Extraemos los bloques de código para protegerlos del parser
    const codeBlocks = [];
    let text = String(md).replace(
      /```([\w+-]*)[ \t]*\r?\n?([\s\S]*?)```/g,
      (match, lang, code) => {
        codeBlocks.push({ lang: (lang || '').trim(), code });
        return `\u0000B${codeBlocks.length - 1}\u0000`;
      }
    );

    // 2) Parser línea a línea
    const lines = text.split(/\r?\n/);
    let html = '';
    let para = [];
    let list = null; // { type: 'ul' | 'ol', items: [] }
    let quote = [];
    let table = [];

    const flushPara = () => {
      if (para.length) {
        html += `<p>${inlineMd(para.join(' '))}</p>`;
        para = [];
      }
    };
    const flushList = () => {
      if (list) {
        html += `<${list.type}>` + list.items.map((it) => `<li>${inlineMd(it)}</li>`).join('') + `</${list.type}>`;
        list = null;
      }
    };
    const flushQuote = () => {
      if (quote.length) {
        html += `<blockquote>${inlineMd(quote.join(' '))}</blockquote>`;
        quote = [];
      }
    };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
      if (rows.length) {
        const cells = (row) =>
          row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const head = cells(rows[0]);
        const body = rows.slice(1).map(cells);
        html += '<table><thead><tr>' + head.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead>';
        if (body.length) {
          html += '<tbody>' + body.map((r) => '<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>').join('') + '</tbody>';
        }
        html += '</table>';
      }
      table = [];
    };
    const flushAll = () => {
      flushPara();
      flushList();
      flushQuote();
      flushTable();
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      const t = line.trim();

      if (/^\u0000B\d+\u0000$/.test(t)) {
        flushAll();
        html += t;
        continue;
      }

      if (!t) {
        flushAll();
        continue;
      }

      // Fila de tabla
      if (t.startsWith('|') && t.endsWith('|') && t.length > 2) {
        flushPara();
        flushList();
        flushQuote();
        table.push(t);
        continue;
      }
      flushTable();

      // Encabezados
      const heading = t.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushPara();
        flushList();
        flushQuote();
        const level = heading[1].length;
        html += `<h${level}>${inlineMd(heading[2])}</h${level}>`;
        continue;
      }

      // Línea horizontal
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) {
        flushPara();
        flushList();
        flushQuote();
        html += '<hr>';
        continue;
      }

      // Cita
      if (t.startsWith('>')) {
        flushPara();
        flushList();
        quote.push(t.replace(/^>\s?/, ''));
        continue;
      }

      // Listas
      const ul = t.match(/^[-*+]\s+(.*)$/);
      const ol = t.match(/^\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        flushQuote();
        const type = ul ? 'ul' : 'ol';
        if (!list || list.type !== type) {
          flushList();
          list = { type, items: [] };
        }
        list.items.push((ul || ol)[1]);
        continue;
      }

      // Texto normal
      flushList();
      flushQuote();
      para.push(t);
    }

    flushAll();

    // 3) Restauramos los bloques de código
    html = html.replace(/\u0000B(\d+)\u0000/g, (match, index) => {
      const { lang, code } = codeBlocks[Number(index)];
      return (
        `<div class="code-block"><div class="code-head"><span>${escapeHtml(lang || 'texto')}</span>` +
        `<button class="copy-btn" data-copy-code type="button">Copiar</button></div>` +
        `<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre></div>`
      );
    });

    return html;
  }

  /* ------------------------------ Referencias ------------------------------ */

  const messagesEl = $('#messages');
  const inputEl = $('#input');
  const sendBtn = $('#sendBtn');
  const stopBtn = $('#stopBtn');
  const sidebarEl = $('#sidebar');
  const backdropEl = $('#backdrop');

  /* ------------------------------- Persistencia ---------------------------- */

  function save() {
    try {
      localStorage.setItem(LS_CONVS, JSON.stringify(conversations));
      if (activeId) localStorage.setItem(LS_ACTIVE, activeId);
      else localStorage.removeItem(LS_ACTIVE);
    } catch {
      /* almacenamiento lleno o bloqueado: seguimos sin persistir */
    }
  }

  function activeConv() {
    return conversations.find((c) => c.id === activeId) || null;
  }

  function ensureConv() {
    let conv = activeConv();
    if (!conv) {
      conv = {
        id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: 'Nueva conversación',
        createdAt: Date.now(),
        messages: [],
      };
      conversations.unshift(conv);
      activeId = conv.id;
      save();
    }
    return conv;
  }

  /* --------------------------------- Vistas -------------------------------- */

  function renderSidebar() {
    const list = $('#convList');
    list.innerHTML = '';

    if (!conversations.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-list';
      empty.textContent = 'Aún no hay conversaciones. ¡Empieza una nueva!';
      list.appendChild(empty);
      return;
    }

    for (const conv of conversations) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'conv-item' + (conv.id === activeId ? ' active' : '');
      item.innerHTML = `${ICON_CHAT}<span class="conv-title"></span><span class="conv-del" title="Eliminar conversación">${ICON_TRASH}</span>`;
      item.querySelector('.conv-title').textContent = conv.title || 'Nueva conversación';
      item.addEventListener('click', (event) => {
        if (event.target.closest('.conv-del')) {
          deleteConv(conv.id);
        } else {
          switchConv(conv.id);
        }
      });
      list.appendChild(item);
    }
  }

  function applyBranding() {
    const name = (settings.name || 'IA').trim() || 'IA';
    $('.logo-name').textContent = name;
    document.title = `${name} · Tu asistente de IA`;
    const note = $('#footNote');
    if (note) note.textContent = `${name} · Tu asistente personal`;
  }

  function updateTitle() {
    const conv = activeConv();
    $('#chatTitle').textContent = conv ? conv.title || 'Nueva conversación' : 'Nueva conversación';
  }

  function buildWelcome() {
    const el = document.createElement('div');
    el.className = 'welcome';
    el.innerHTML = `
      <div class="welcome-mark" aria-hidden="true">✦</div>
      <h2>Hola, soy <span class="grad">${escapeHtml(settings.name || 'IA')}</span></h2>
      <p class="welcome-sub">¿En qué puedo ayudarte hoy?</p>
      <div class="chips">
        ${SUGGESTIONS.map(
          (s) =>
            `<button class="chip" type="button" data-prompt="${escapeHtml(s.prompt)}">` +
            `<span class="chip-ico" aria-hidden="true">${s.icon}</span><span>${escapeHtml(s.label)}</span></button>`
        ).join('')}
      </div>`;
    return el;
  }

  function buildMessage(msg, { withActions = false } = {}) {
    const el = document.createElement('div');
    el.className = 'msg ' + msg.role;

    if (msg.role === 'user') {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = msg.content;
      el.appendChild(bubble);
      return el;
    }

    el.innerHTML = `
      <div class="avatar" aria-hidden="true">✦</div>
      <div class="msg-body">
        <div class="msg-content md"></div>
      </div>`;
    $('.msg-content', el).innerHTML = mdToHtml(msg.content);

    if (withActions) {
      $('.msg-body', el).appendChild(buildActions());
    }
    return el;
  }

  function buildActions() {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `
      <button class="action-btn" data-copy-msg type="button" title="Copiar respuesta" aria-label="Copiar respuesta">${ICON_COPY}</button>
      <button class="action-btn" data-regen type="button" title="Regenerar respuesta" aria-label="Regenerar respuesta">${ICON_REFRESH}</button>`;
    return actions;
  }

  function renderMessages() {
    messagesEl.innerHTML = '';
    const conv = activeConv();

    if (!conv || !conv.messages.length) {
      messagesEl.appendChild(buildWelcome());
      return;
    }

    conv.messages.forEach((msg, index) => {
      const isLast = index === conv.messages.length - 1;
      messagesEl.appendChild(
        buildMessage(msg, { withActions: msg.role === 'assistant' && isLast })
      );
    });

    scrollToBottom(true);
  }

  function appendStreamingMessage() {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `
      <div class="avatar" aria-hidden="true">✦</div>
      <div class="msg-body">
        <div class="msg-content md"><span class="typing"><span></span><span></span><span></span></span></div>
      </div>`;
    messagesEl.appendChild(el);
    scrollToBottom(true);
    return {
      el,
      bodyEl: $('.msg-body', el),
      contentEl: $('.msg-content', el),
    };
  }

  function updateStreamingContent(contentEl, text) {
    if (!text) return;
    contentEl.innerHTML = mdToHtml(text) + '<span class="cursor"></span>';
    scrollToBottom(false);
  }

  function finalizeMessage(stream, msg) {
    stream.contentEl.innerHTML = mdToHtml(msg.content);
    stream.bodyEl.appendChild(buildActions());
    scrollToBottom(false);
  }

  /* ------------------------------- Scroll ---------------------------------- */

  messagesEl.addEventListener('scroll', () => {
    stickBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
  });

  function scrollToBottom(force = false) {
    if (force || stickBottom) {
      messagesEl.scrollTo({
        top: messagesEl.scrollHeight,
        behavior: force ? 'smooth' : 'auto',
      });
    }
  }

  /* ------------------------------- Navegación ------------------------------ */

  function switchConv(id) {
    if (id === activeId) {
      closeSidebarMobile();
      return;
    }
    if (controller) controller.abort();
    activeId = id;
    save();
    renderSidebar();
    renderMessages();
    updateTitle();
    closeSidebarMobile();
  }

  function deleteConv(id) {
    if (controller) controller.abort();
    const index = conversations.findIndex((c) => c.id === id);
    if (index === -1) return;
    conversations.splice(index, 1);
    if (activeId === id) {
      activeId = conversations[0] ? conversations[0].id : null;
    }
    save();
    renderSidebar();
    renderMessages();
    updateTitle();
  }

  function newChat() {
    if (controller) controller.abort();
    activeId = null;
    save();
    renderSidebar();
    renderMessages();
    updateTitle();
    closeSidebarMobile();
    inputEl.focus();
  }

  function openSidebarMobile() {
    sidebarEl.classList.add('open');
    backdropEl.classList.add('show');
  }

  function closeSidebarMobile() {
    sidebarEl.classList.remove('open');
    backdropEl.classList.remove('show');
  }

  /* ------------------------------- Streaming ------------------------------- */

  function setStreaming(on) {
    streaming = on;
    sendBtn.hidden = on;
    stopBtn.hidden = !on;
    sendBtn.disabled = on;
  }

  async function requestReply(conv) {
    const assistant = { role: 'assistant', content: '', ts: Date.now() };
    conv.messages.push(assistant);

    const stream = appendStreamingMessage();
    setStreaming(true);
    stickBottom = true;

    const abortController = new AbortController();
    controller = abortController;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: conv.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
          persona: settings.persona,
          model: settings.model,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        let message = `Error del servidor (${response.status}).`;
        try {
          const data = await response.json();
          if (data && data.error) message = data.error;
        } catch {
          /* sin cuerpo JSON */
        }
        throw new Error(message);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separator;
        while ((separator = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);

          for (const line of rawEvent.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            let event;
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }

            if (event.error) throw new Error(event.error);

            if (event.delta) {
              assistant.content += event.delta;
              updateStreamingContent(stream.contentEl, assistant.content);
            }
          }
        }
      }
    } catch (error) {
      if (error && error.name !== 'AbortError') {
        assistant.content +=
          (assistant.content ? '\n\n' : '') + '⚠️ ' + (error.message || 'Error de conexión.');
      }
    } finally {
      setStreaming(false);
      controller = null;

      if (!assistant.content.trim()) {
        const index = conv.messages.indexOf(assistant);
        if (index !== -1) conv.messages.splice(index, 1);
        stream.el.remove();
      } else {
        finalizeMessage(stream, assistant);
      }

      save();
      renderSidebar();
    }
  }

  async function send(rawText) {
    const text = (rawText || '').trim();
    if (!text || streaming) return;

    const conv = ensureConv();
    closeSidebarMobile();

    conv.messages.push({ role: 'user', content: text, ts: Date.now() });
    if (conv.title === 'Nueva conversación') {
      conv.title = text.length > 42 ? text.slice(0, 42).trimEnd() + '…' : text;
    }
    save();
    renderSidebar();
    updateTitle();

    // Limpiamos acciones de mensajes anteriores y la pantalla de bienvenida
    $$('.msg-actions').forEach((el) => el.remove());
    const welcome = $('.welcome');
    if (welcome) welcome.remove();

    messagesEl.appendChild(buildMessage({ role: 'user', content: text }));
    scrollToBottom(true);

    await requestReply(conv);
  }

  async function regenerate() {
    if (streaming) return;
    const conv = activeConv();
    if (!conv) return;

    let lastUserIndex = -1;
    conv.messages.forEach((m, i) => {
      if (m.role === 'user') lastUserIndex = i;
    });
    if (lastUserIndex === -1) return;

    conv.messages = conv.messages.slice(0, lastUserIndex + 1);
    save();
    renderMessages();
    await requestReply(conv);
  }

  function sendFromInput() {
    if (streaming) return;
    const value = inputEl.value;
    if (!value.trim()) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    send(value);
  }

  function stopGeneration() {
    if (controller) controller.abort();
  }

  /* ------------------------------ Portapapeles ----------------------------- */

  async function copyText(text, button) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
      }
      flashCopied(button);
    } catch {
      /* el portapapeles puede estar bloqueado: no rompemos la app */
    }
  }

  function flashCopied(button) {
    if (!button || button.dataset.copying === '1') return;
    button.dataset.copying = '1';
    const original = button.innerHTML;
    button.classList.add('copied');
    button.innerHTML = ICON_CHECK;
    setTimeout(() => {
      button.classList.remove('copied');
      button.innerHTML = original;
      delete button.dataset.copying;
    }, 1400);
  }

  /* --------------------------------- Eventos ------------------------------- */

  function bindEvents() {
    $('#newChatBtn').addEventListener('click', newChat);
    $('#menuBtn').addEventListener('click', openSidebarMobile);
    $('#sidebarClose').addEventListener('click', closeSidebarMobile);
    backdropEl.addEventListener('click', closeSidebarMobile);

    sendBtn.addEventListener('click', sendFromInput);
    stopBtn.addEventListener('click', stopGeneration);

    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    });

    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendFromInput();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSidebarMobile();
    });

    // Delegación: botones de copiar, regenerar y chips de sugerencias
    document.addEventListener('click', (event) => {
      const codeButton = event.target.closest('[data-copy-code]');
      if (codeButton) {
        const code = codeButton.closest('.code-block')?.querySelector('code');
        if (code) copyText(code.textContent, codeButton);
        return;
      }

      const messageButton = event.target.closest('[data-copy-msg]');
      if (messageButton) {
        const content = messageButton.closest('.msg-body')?.querySelector('.msg-content');
        if (content) copyText(content.innerText, messageButton);
        return;
      }

      if (event.target.closest('[data-regen]')) {
        regenerate();
        return;
      }

      const chip = event.target.closest('.chip');
      if (chip && chip.dataset.prompt) send(chip.dataset.prompt);
    });

    // Ajustes: nombre, personalidad y modelo de tu IA
    const settingsModal = $('#settingsModal');

    const openSettings = () => {
      $('#setName').value = settings.name || 'IA';
      $('#setModel').value = settings.model || 'gemini-2.5-flash';
      $('#setPersona').value = settings.persona || '';
      settingsModal.hidden = false;
    };
    const closeSettings = () => {
      settingsModal.hidden = true;
    };

    $('#settingsBtn').addEventListener('click', openSettings);
    $('#settingsClose').addEventListener('click', closeSettings);
    settingsModal.addEventListener('click', (event) => {
      if (event.target === settingsModal) closeSettings();
    });

    $('#settingsSave').addEventListener('click', () => {
      settings.name = ($('#setName').value || 'IA').trim().slice(0, 24) || 'IA';
      settings.model = $('#setModel').value || 'gemini-2.5-flash';
      settings.persona = ($('#setPersona').value || '').slice(0, 2000);
      try {
        localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
      } catch {
        /* sin almacenamiento */
      }
      applyBranding();
      renderMessages();
      closeSettings();
    });

    $('#settingsReset').addEventListener('click', () => {
      settings = { name: 'IA', persona: '', model: 'gemini-2.5-flash' };
      try {
        localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
      } catch {
        /* sin almacenamiento */
      }
      applyBranding();
      renderMessages();
      openSettings();
    });
  }

  /* ---------------------------------- Salud -------------------------------- */

  async function loadHealth() {
    const chip = $('#modeChip');
    const label = $('#modeText');
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      const data = await response.json();

      const name = settings.name || 'IA';
      if (data.mode === 'demo') {
        chip.classList.add('demo');
        label.textContent = 'Modo demo · sin motor';
        document.title = `${name} · Modo demo`;
      } else if (data.mode === 'pollinations') {
        chip.classList.add('live');
        label.textContent = 'Motor gratuito · sin API key';
        document.title = `${name} · Tu asistente de IA`;
      } else {
        chip.classList.add('live');
        label.textContent = `Gemini · ${data.model}`;
        document.title = `${name} · Gemini`;
      }
    } catch {
      label.textContent = 'Sin conexión con el servidor';
    }
  }

  /* ---------------------------------- Inicio -------------------------------- */

  function init() {
    renderSidebar();
    applyBranding();
    renderMessages();
    updateTitle();
    loadHealth();
    bindEvents();
    inputEl.focus();
  }

  init();
})();
