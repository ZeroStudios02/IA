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
  const LS_MEMORY = 'ia.memory.v1';
  let attachments = []; // {kind:'image', dataURL} | {kind:'file', name, text}
  let memory = [];
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
  const ICON_EDIT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
  const ICON_CHAT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  const SUGGESTIONS = [
    { icon: '✍️', label: 'Escríbeme un correo profesional', prompt: 'Escríbeme un correo profesional para pedir una reunión con mi equipo la próxima semana.' },
    { icon: '💡', label: 'Explícame algo fácil', prompt: 'Explícame la fotosíntesis como si tuviera 10 años.' },
    { icon: '👨‍💻', label: 'Ayúdame con código', prompt: 'Créame una página web sencilla con HTML y CSS para una cafetería.' },
    { icon: '🗺️', label: 'Plan de viaje', prompt: 'Hazme un plan de viaje de 3 días por Granada, en España.' },
    { icon: '📰', label: 'Noticias de hoy', prompt: 'Dame un resumen de las noticias más importantes de hoy en el mundo.' },
  ];

  /* -------------------------------- Estado -------------------------------- */

  let conversations = [];
  let activeId = null;
  let streaming = false;
  let controller = null;
  let stickBottom = true;

  let settings = { name: 'Arena', persona: '', model: 'gemini-2.5-flash' };
  try {
    settings = { ...settings, ...(JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') || {}) };
  } catch {
    /* valores por defecto */
  }

  let webSearch = true;
  try {
    webSearch = localStorage.getItem('ia.web.v1') !== '0';
  } catch {
    /* activada por defecto */
  }

  let convFilter = '';
  let theme = 'dark';
  try {
    theme = localStorage.getItem('ia.theme.v1') || 'dark';
  } catch {
    /* tema oscuro por defecto */
  }

  try {
    memory = JSON.parse(localStorage.getItem(LS_MEMORY) || '[]') || [];
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

    const filtered = conversations.filter((conv) => {
      if (!convFilter) return true;
      if ((conv.title || '').toLowerCase().includes(convFilter)) return true;
      return (conv.messages || []).some((m) =>
        (m.content || '').toLowerCase().includes(convFilter)
      );
    });

    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-list';
      empty.textContent = conversations.length
        ? `Sin resultados para “${convFilter}”.`
        : 'Aún no hay conversaciones. ¡Empieza una nueva!';
      list.appendChild(empty);
      return;
    }

    for (const conv of filtered) {
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

  function applyTheme(next) {
    theme = next;
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('ia.theme.v1', next);
    } catch {
      /* sin almacenamiento */
    }
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

  function buildMessage(msg, { withActions = false, index = null } = {}) {
    const el = document.createElement('div');
    el.className = 'msg ' + msg.role;

    if (msg.role === 'user') {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (Array.isArray(msg.images) && msg.images.length) {
        const grid = document.createElement('div');
        grid.className = 'msg-thumbs';
        msg.images.forEach((src) => {
          const img = document.createElement('img');
          img.src = src;
          img.alt = 'Imagen adjuntada';
          img.addEventListener('click', () => window.open(src, '_blank'));
          grid.appendChild(img);
        });
        bubble.appendChild(grid);
      }
      if (Array.isArray(msg.files) && msg.files.length) {
        const filesEl = document.createElement('div');
        filesEl.className = 'msg-files';
        msg.files.forEach((f) => {
          const tag = document.createElement('span');
          tag.className = 'file-tag';
          tag.textContent = '📄 ' + f.name;
          filesEl.appendChild(tag);
        });
        bubble.appendChild(filesEl);
      }
      const texto = document.createElement('div');
      texto.textContent = msg.content;
      bubble.appendChild(texto);
      el.appendChild(bubble);

      if (index !== null) {
        el.dataset.index = String(index);
        const actions = document.createElement('div');
        actions.className = 'user-actions';
        actions.innerHTML = `<button class="action-btn" data-edit="${index}" type="button" title="Editar mensaje" aria-label="Editar mensaje">${ICON_EDIT}</button>`;
        el.appendChild(actions);
      }
      return el;
    }

    el.innerHTML = `
      <div class="avatar" aria-hidden="true">✦</div>
      <div class="msg-body">
        ${msg.searched ? '<div class="search-chip">🔍 Búsqueda en tiempo real</div>' : ''}
        <div class="msg-content md"></div>
      </div>`;
    $('.msg-content', el).innerHTML = mdToHtml(msg.content);

    if (msg.image) {
      const wrap = document.createElement('div');
      wrap.className = 'generated-image';
      const img = document.createElement('img');
      img.src = msg.image;
      img.alt = 'Imagen generada';
      img.addEventListener('click', () => window.open(msg.image, '_blank'));
      wrap.appendChild(img);
      const actions = document.createElement('div');
      actions.className = 'image-actions';
      actions.innerHTML =
        '<button class="action-btn" type="button" data-download="1" title="Descargar">⬇ Descargar</button>';
      actions.querySelector('[data-download]').addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = msg.image;
        a.download = 'arena-imagen.jpg';
        a.click();
      });
      wrap.appendChild(actions);
      $('.msg-body', el).appendChild(wrap);
    }

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
        buildMessage(msg, { withActions: msg.role === 'assistant' && isLast, index })
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

    const quick = document.createElement('div');
    quick.className = 'quick-actions';
    quick.innerHTML = `
      <button class="quick-btn" type="button" data-quick="Explícamelo más simple, con un lenguaje fácil">↺ Más simple</button>
      <button class="quick-btn" type="button" data-quick="Dame un ejemplo práctico de lo que acabas de explicar">💡 Un ejemplo</button>
      <button class="quick-btn" type="button" data-quick="Resúmelo en 3 puntos clave">📋 Resumir</button>`;
    stream.bodyEl.appendChild(quick);

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

  /* ------------------------------ Adjuntos ------------------------------ */

  function renderAttachments() {
    const strip = $('#attachStrip');
    if (!strip) return;
    strip.hidden = attachments.length === 0;
    strip.innerHTML = '';
    attachments.forEach((att, i) => {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      if (att.kind === 'image') {
        chip.innerHTML = `<img src="${att.dataURL}" alt=""><span>Imagen</span>`;
      } else {
        chip.innerHTML = `<span class="attach-file">📄</span><span>${att.name}</span>`;
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attach-remove';
      remove.title = 'Quitar';
      remove.setAttribute('aria-label', 'Quitar adjunto');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        attachments.splice(i, 1);
        renderAttachments();
      });
      chip.appendChild(remove);
      strip.appendChild(chip);
    });
  }

  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const max = 1024;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  const TEXT_TYPES = /\.(txt|md|json|csv|js|ts|py|html|css|xml|yml|yaml|log|svg)$/i;

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    for (const file of files.slice(0, 4)) {
      if (file.type.startsWith('image/')) {
        if (attachments.filter((a) => a.kind === 'image').length >= 3) {
          alert('Máximo 3 imágenes por mensaje.');
          continue;
        }
        try {
          attachments.push({ kind: 'image', dataURL: await resizeImage(file) });
        } catch {
          alert(`No se pudo leer la imagen ${file.name}.`);
        }
      } else if (TEXT_TYPES.test(file.name)) {
        const text = await file.text();
        if (text.length > 60000) {
          alert(`${file.name} es demasiado grande (máx. 60 KB de texto).`);
          continue;
        }
        attachments.push({ kind: 'file', name: file.name, text });
      } else {
        alert(`${file.name}: formato no compatible. Sube imágenes, .txt, .md, .json, .csv, .js, .py…`);
      }
    }
    renderAttachments();
    const inputEl = $('#input');
    if (inputEl) inputEl.focus();
  }

  /* ------------------------------- Memoria ------------------------------- */

  function saveMemory() {
    try {
      localStorage.setItem(LS_MEMORY, JSON.stringify(memory));
    } catch {
      /* sin espacio */
    }
  }

  function captureMemory(text) {
    const nuevos = [];
    const patrones = [
      /\brecuerda\s+que\s+(.{3,200})/i,
      /\bme\s+llamo\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]{1,30})/i,
      /\bmi\s+nombre\s+es\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]{1,30})/i,
      /\btrabajo\s+de\s+([\wáéíóúñ\s]{3,40})/i,
      /\bvivo\s+en\s+([\wáéíóúñ\s]{3,40})/i,
    ];
    for (const re of patrones) {
      const m = text.match(re);
      if (m) {
        const fact = m[0].trim().replace(/[.!?]+$/, '');
        if (fact.length >= 3 && !memory.some((x) => x.toLowerCase() === fact.toLowerCase())) {
          nuevos.push(fact);
        }
      }
    }
    if (nuevos.length) {
      memory = [...nuevos, ...memory].slice(0, 50);
      saveMemory();
    }
    return nuevos.length;
  }

  /* ------------------------- Generación de imágenes ------------------------- */

  const IMG_RE =
    /\b(genera|generar|crea|crear|dibuja|dibujar|hazme|haz|píntame|pintame|diseña|disena)\s+(?:una\s+|un\s+|el\s+|la\s+)?(imagen|foto|fotografia|fotografía|dibujo|ilustracion|ilustración|logo|portada|fondo|wallpaper|paisaje|personaje)\b/i;

  function wantsImage(text) {
    return IMG_RE.test(text) && !/\b(imagen|foto)\b.*\b(analizar|describir|explicar)\b/i.test(text);
  }

  // Cooldown del generador gratuito (1 imagen cada 45 s)
  let imageCooldownUntil = 0;
  function imageCooldownLeft() {
    return Math.max(0, Math.ceil((imageCooldownUntil - Date.now()) / 1000));
  }
  function setImageCooldown(seconds) {
    imageCooldownUntil = Date.now() + seconds * 1000;
    setTimeout(() => {
      const btn = $('#attachBtn');
      if (btn) btn.title = 'Adjuntar imagen o archivo';
    }, seconds * 1000);
  }

  async function generateImage(conv, prompt) {
    const userMsg = { role: 'user', content: prompt, ts: Date.now() };
    conv.messages.push(userMsg);
    if (conv.title === 'Nueva conversación') {
      conv.title = prompt.length > 42 ? prompt.slice(0, 42).trimEnd() + '…' : prompt;
    }
    save();
    renderSidebar();
    updateTitle();

    $$('.msg-actions').forEach((el) => el.remove());
    const welcome = $('.welcome');
    if (welcome) welcome.remove();

    messagesEl.appendChild(buildMessage(userMsg, { index: conv.messages.length - 1 }));

    const assistant = { role: 'assistant', content: '', image: null, ts: Date.now() };
    conv.messages.push(assistant);

    const holder = document.createElement('div');
    holder.className = 'msg assistant';
    holder.innerHTML =
      '<div class="avatar" aria-hidden="true">✦</div>' +
      '<div class="msg-body"><div class="image-wait">🎨 Generando imagen<span class="dots"><i></i><i></i><i></i></span></div></div>';
    messagesEl.appendChild(holder);
    scrollToBottom(true);
    setStreaming(true);

    try {
      const response = await fetch('/api/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ratio: 'square' }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 429 && data.retryAfter) {
        setImageCooldown(Number(data.retryAfter) || 45);
        throw new Error(data.error || 'El generador está en enfriamiento.');
      }
      if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo generar la imagen.');
      setImageCooldown(45);
      assistant.image = data.image;
      assistant.content = '';
    } catch (error) {
      assistant.content = '⚠️ ' + (error.message || 'No se pudo generar la imagen.');
    } finally {
      setStreaming(false);
      save();
      renderSidebar();
      renderMessages();
      scrollToBottom(true);
    }
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
          search: webSearch,
          memory,
          images: attachments.filter((a) => a.kind === 'image').map((a) => a.dataURL),
          files: attachments
            .filter((a) => a.kind === 'file')
            .map((a) => ({ name: a.name, text: a.text })),
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

            if (event.note === 'reserva' && !stream.reserveChip) {
              stream.reserveChip = document.createElement('div');
              stream.reserveChip.className = 'search-chip reserve-chip';
              stream.reserveChip.textContent = '⚡ Motor de reserva';
              stream.bodyEl.insertBefore(stream.reserveChip, stream.contentEl);
            }

            if (event.searched) {
              assistant.searched = true;
              if (!stream.searchChip) {
                stream.searchChip = document.createElement('div');
                stream.searchChip.className = 'search-chip';
                stream.searchChip.textContent = '🔍 Búsqueda en tiempo real';
                stream.bodyEl.insertBefore(stream.searchChip, stream.contentEl);
              }
            }

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
    if (streaming) return;
    if (!text && attachments.length === 0) return;

    const conv = ensureConv();
    closeSidebarMobile();

    // ¿Quiere generar una imagen?
    if (text && attachments.length === 0 && wantsImage(text)) {
      captureMemory(text);
      const left = imageCooldownLeft();
      if (left > 0) {
        conv.messages.push({
          role: 'user',
          content: text,
          ts: Date.now(),
        });
        conv.messages.push({
          role: 'assistant',
          content: `⏳ El generador gratuito solo permite **1 imagen cada 45 segundos**. Vuelve a intentarlo en ${left} s.`,
          ts: Date.now(),
        });
        save();
        renderSidebar();
        renderMessages();
        scrollToBottom(true);
        return;
      }
      await generateImage(conv, text);
      return;
    }

    captureMemory(text);

    conv.messages.push({
      role: 'user',
      content: text,
      ts: Date.now(),
      images: attachments.filter((a) => a.kind === 'image').map((a) => a.dataURL),
      files: attachments.filter((a) => a.kind === 'file').map((a) => ({ name: a.name })),
    });
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

    messagesEl.appendChild(
      buildMessage(conv.messages[conv.messages.length - 1], { index: conv.messages.length - 1 })
    );
    scrollToBottom(true);

    attachments = [];
    renderAttachments();

    await requestReply(conv);
  }

  function startEdit(index) {
    const conv = activeConv();
    if (!conv || streaming) return;
    const msg = conv.messages[index];
    if (!msg || msg.role !== 'user') return;

    const msgEl = messagesEl.querySelector(`.msg.user[data-index="${index}"]`);
    if (!msgEl) return;

    const editor = document.createElement('div');
    editor.className = 'edit-box';
    editor.innerHTML = `
      <textarea aria-label="Editar mensaje"></textarea>
      <div class="edit-actions">
        <button class="btn-ghost small" type="button" data-edit-cancel>Cancelar</button>
        <button class="btn-primary small" type="button" data-edit-save>Guardar y enviar</button>
      </div>`;

    msgEl.innerHTML = '';
    msgEl.appendChild(editor);

    const textarea = editor.querySelector('textarea');
    textarea.value = msg.content;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 220) + 'px';

    editor.querySelector('[data-edit-cancel]').addEventListener('click', () => renderMessages());
    editor.querySelector('[data-edit-save]').addEventListener('click', () => {
      const value = textarea.value.trim();
      if (!value) return;
      msg.content = value;
      conv.messages = conv.messages.slice(0, index + 1);
      save();
      renderSidebar();
      renderMessages();
      requestReply(conv);
    });
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
    if (!value.trim() && attachments.length === 0) return;
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

    // Tema claro / oscuro
    $('#themeBtn').addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    });

    // Buscador de chats
    const convSearch = $('#convSearch');
    convSearch.addEventListener('input', () => {
      convFilter = convSearch.value.trim().toLowerCase();
      renderSidebar();
    });

    // Dictado por voz (Web Speech API)
    // Adjuntar archivos e imágenes
    const fileInput = $('#fileInput');
    const attachBtn = $('#attachBtn');
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        handleFiles(fileInput.files);
        fileInput.value = '';
      });
    }

    // Arrastrar y soltar sobre la zona de escritura
    const composerEl = $('#composer');
    if (composerEl) {
      ['dragenter', 'dragover'].forEach((ev) =>
        composerEl.addEventListener(ev, (e) => {
          if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
            composerEl.classList.add('dragging');
          }
        })
      );
      ['dragleave', 'drop'].forEach((ev) =>
        composerEl.addEventListener(ev, (e) => {
          e.preventDefault();
          composerEl.classList.remove('dragging');
          if (ev === 'drop' && e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
        })
      );
    }

    // Pegar imagen desde el portapapeles
    const inputEl = $('#input');
    if (inputEl) {
      inputEl.addEventListener('paste', (e) => {
        const items = Array.from(e.clipboardData?.items || []);
        const imageItems = items.filter((i) => i.type.startsWith('image/'));
        if (!imageItems.length) return;
        e.preventDefault();
        handleFiles(imageItems.map((i) => i.getAsFile()).filter(Boolean));
      });
    }

    const micBtn = $('#micBtn');
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      let recognition = null;
      let listening = false;

      micBtn.addEventListener('click', () => {
        if (listening) {
          recognition.stop();
          return;
        }
        recognition = new SpeechRecognition();
        recognition.lang = 'es-ES';
        recognition.interimResults = true;
        recognition.continuous = false;

        let finalText = '';
        recognition.onresult = (event) => {
          let interim = '';
          for (const result of event.results) {
            if (result.isFinal) finalText += result[0].transcript;
            else interim += result[0].transcript;
          }
          inputEl.value = (inputEl.value.replace(/\s+$/, '') + ' ' + finalText + interim).trim();
          inputEl.dispatchEvent(new Event('input'));
        };
        recognition.onend = () => {
          listening = false;
          micBtn.classList.remove('listening');
        };
        recognition.onerror = () => {
          listening = false;
          micBtn.classList.remove('listening');
        };
        recognition.start();
        listening = true;
        micBtn.classList.add('listening');
      });
    } else {
      micBtn.hidden = true;
    }

    // Atajos de teclado
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSidebarMobile();
        convSearch.focus();
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        newChat();
      }
    });

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
      if (event.key === 'Escape') {
        closeSidebarMobile();
        $('#settingsModal').hidden = true;
        $('#newsModal').hidden = true;
      }
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

      const editBtn = event.target.closest('[data-edit]');
      if (editBtn) {
        startEdit(Number(editBtn.dataset.edit));
        return;
      }

      const quickBtn = event.target.closest('[data-quick]');
      if (quickBtn) {
        send(quickBtn.dataset.quick);
        return;
      }

      const chip = event.target.closest('.chip');
      if (chip && chip.dataset.prompt) send(chip.dataset.prompt);
    });

    // Búsqueda web: activar/desactivar
    const webBtn = $('#webBtn');
    const setWebActive = (on) => {
      webSearch = on;
      webBtn.classList.toggle('active', on);
      webBtn.title = on ? 'Búsqueda web activada' : 'Búsqueda web desactivada';
      try {
        localStorage.setItem('ia.web.v1', on ? '1' : '0');
      } catch {
        /* sin almacenamiento */
      }
    };
    webBtn.addEventListener('click', () => setWebActive(!webSearch));
    setWebActive(webSearch);

    // Noticias de hoy
    const newsModal = $('#newsModal');
    let newsLoaded = false;

    const loadNews = async () => {
      const list = $('#newsList');
      const meta = $('#newsMeta');
      if (newsLoaded) return;

      list.innerHTML = '<p class="news-empty">Cargando titulares…</p>';
      meta.textContent = '';

      try {
        const response = await fetch('/api/news', { cache: 'no-store' });
        const data = await response.json();
        list.innerHTML = '';

        if (!data.ok || !data.items || !data.items.length) {
          list.innerHTML = '<p class="news-empty">No se pudieron cargar las noticias. Inténtalo de nuevo.</p>';
          return;
        }

        const bySource = new Map();
        for (const item of data.items) {
          if (!bySource.has(item.source)) bySource.set(item.source, []);
          bySource.get(item.source).push(item);
        }

        for (const [source, items] of bySource) {
          const group = document.createElement('section');
          group.className = 'news-group';
          group.innerHTML = '<h3></h3>';
          group.querySelector('h3').textContent = source;

          const wrap = document.createElement('div');
          wrap.className = 'news-items';

          for (const item of items.slice(0, 5)) {
            const link = document.createElement('a');
            link.className = 'news-item';
            link.href = item.link;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.innerHTML = '<span class="news-title"></span><span class="news-date"></span>';
            link.querySelector('.news-title').textContent = item.title;
            if (item.date) {
              const date = new Date(item.date);
              if (!Number.isNaN(date.getTime())) {
                link.querySelector('.news-date').textContent = date.toLocaleDateString('es-ES', {
                  day: 'numeric',
                  month: 'short',
                });
              }
            }
            wrap.appendChild(link);
          }

          group.appendChild(wrap);
          list.appendChild(group);
        }

        newsLoaded = true;
        meta.textContent = 'Titulares actualizados · los enlaces se abren en una pestaña nueva';
      } catch {
        list.innerHTML = '<p class="news-empty">Error de conexión al cargar las noticias.</p>';
      }
    };

    $('#newsBtn').addEventListener('click', () => {
      newsModal.hidden = false;
      loadNews();
    });
    $('#newsClose').addEventListener('click', () => {
      newsModal.hidden = true;
    });
    newsModal.addEventListener('click', (event) => {
      if (event.target === newsModal) newsModal.hidden = true;
    });

    // Ajustes: nombre, personalidad y modelo de tu IA
    const settingsModal = $('#settingsModal');

    const openSettings = () => {
      $('#setName').value = settings.name || 'IA';
      $('#setModel').value = settings.model || $('#setModel').value || '';
      $('#setPersona').value = settings.persona || '';
      const memoryEl = $('#setMemory');
      if (memoryEl) memoryEl.value = memory.join('\n');
      settingsModal.hidden = false;
    };
    const closeSettings = () => {
      settingsModal.hidden = true;
    };

    $('#settingsBtn').addEventListener('click', openSettings);
    $('#modelPill').addEventListener('click', openSettings);
    $('#settingsClose').addEventListener('click', closeSettings);
    settingsModal.addEventListener('click', (event) => {
      if (event.target === settingsModal) closeSettings();
    });

    $('#settingsSave').addEventListener('click', () => {
      settings.name = ($('#setName').value || 'IA').trim().slice(0, 24) || 'IA';
      settings.model = $('#setModel').value || '';
      settings.persona = ($('#setPersona').value || '').slice(0, 2000);
      const memoryEl = $('#setMemory');
      if (memoryEl) {
        memory = memoryEl.value
          .split('\n')
          .map((l) => l.trim().slice(0, 300))
          .filter(Boolean)
          .slice(0, 50);
        saveMemory();
      }
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
      settings = { name: 'Arena', persona: '', model: 'gemini-2.5-flash' };
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

  // Nombre legible de un modelo: 'nvidia/nemotron-3-ultra-550b-a55b:free' → 'Nemotron 3 Ultra 550B'
  function modelLabel(id) {
    if (!id) return 'Arena';
    if (/^gemini-/i.test(id)) return id.replace(/^gemini-/i, 'Gemini ').replace(/-/g, ' ');
    const clean = id.replace(/:free$/, '').split('/').pop();
    const known = {
      'nemotron-3-ultra-550b-a55b': 'Nemotron 3 Ultra 550B',
      'nemotron-3.5-super-vl': 'Nemotron 3.5 Super VL',
      'nemotron-3.5-lightning': 'Nemotron 3.5 Lightning',
      'nemotron-3-nano-omni-30b-a3b-reasoning': 'Nemotron Nano Omni 30B',
      'gemma-4-26b-a4b-it': 'Gemma 4 26B',
      'gemma-4-31b-it': 'Gemma 4 31B',
      'ling-3.2-flash': 'Ling 3.2 Flash',
      'ernie-5.5-flash-preview': 'Ernie 5.5 Flash',
      'lfm-3-1.7b': 'LFM 3 1.7B',
      'particle-1': 'Particle 1',
      'flint-v1.0': 'Flint 1.0',
      'dots-3-note-preview': 'Dots 3 Note',
    };
    if (known[clean]) return known[clean];
    return clean.replace(/-/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  async function loadHealth() {
    const chip = $('#modeChip');
    const label = $('#modeText');
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      const data = await response.json();

      const name = settings.name || 'IA';
      const pillText = $('#modelPillText');

      // Rellena el selector con los modelos del motor activo
      const select = $('#setModel');
      if (select && Array.isArray(data.models) && data.models.length) {
        select.innerHTML = data.models
          .map((m) => `<option value="${m}">${modelLabel(m)}</option>`)
          .join('');
        const preferido = settings.model;
        select.value = data.models.includes(preferido) ? preferido : data.model;
        settings.model = select.value;
      }

      if (data.mode === 'openrouter') {
        pillText.textContent = modelLabel(data.model);
        chip.classList.add('live');
        label.textContent = `OpenRouter · ${modelLabel(data.model)}`;
        document.title = `${name} · Tu asistente de IA`;
      } else if (data.mode === 'gemini') {
        pillText.textContent = modelLabel(data.model);
        chip.classList.add('live');
        label.textContent = `Gemini · ${modelLabel(data.model)}`;
        document.title = `${name} · Gemini`;
      } else if (data.mode === 'pollinations') {
        pillText.textContent = 'Arena';
        chip.classList.add('live');
        label.textContent = 'Motor gratuito · sin API key';
        document.title = `${name} · Tu asistente de IA`;
      } else {
        pillText.textContent = 'Demo';
        chip.classList.add('demo');
        label.textContent = 'Modo demo · sin motor';
        document.title = `${name} · Modo demo`;
      }
    } catch {
      label.textContent = 'Sin conexión con el servidor';
    }
  }

  /* ---------------------------------- Inicio -------------------------------- */

  function init() {
    applyTheme(theme);
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
