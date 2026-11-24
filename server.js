'use strict';

/**
 * IA — Servidor de chat con IA
 * ----------------------------------------
 * - Sirve la interfaz web (carpeta /public)
 * - Expone POST /api/chat con streaming (SSE) hacia el navegador
 * - Motores disponibles:
 *     · gemini       → API oficial de Google (requiere GEMINI_API_KEY)
 *     · pollinations → motor gratuito sin clave (AI_PROVIDER=pollinations)
 *     · demo         → respuestas simuladas para probar la web
 * - La API key vive solo en el servidor: nunca llega al cliente.
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

/* ----------------------------- Configuración ----------------------------- */

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const BASE_URL = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/+$/, '');

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o4-mini'];

const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
// Modelo gratuito con visión (para las imágenes que sube la persona)
const OPENROUTER_VISION_MODEL = 'nvidia/nemotron-3.5-super-vl:free';
const OPENROUTER_VISION_MODELS = [
  'nvidia/nemotron-3.5-super-vl:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
];

// Modelos gratuitos de OpenRouter que funcionan bien en español (el primero es el por defecto)
const OPENROUTER_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'inclusionai/ling-3.2-flash:free',
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'baidu/ernie-5.5-flash-preview:free',
  'liquid/lfm-3-1.7b:free',
  'particle-ai/particle-1:free',
  'recursive/flint-v1.0:free',
  'dots-studio/dots-3-note-preview:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3.5-lightning:free',
];

// GitHub Models (gratis con tu token de GitHub)
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const GITHUB_MODEL = process.env.GITHUB_MODEL || 'openai/gpt-4o-mini';

// Si el motor principal falla (cuota agotada, caída...) se salta durante unos minutos
// para no perder tiempo en cada mensaje; el de reserva responde al instante.
let motorPrincipalHasta = 0;
const MOTOR_CAIDO_MIN = 10;

// Motor de IA: 'openrouter' | 'gemini' | 'github' | 'pollinations' (gratuito) | 'demo'
// Si no se define AI_PROVIDER, se usa el primero que tenga clave disponible.
const PROVIDER = (
  process.env.AI_PROVIDER ||
  (API_KEY
    ? 'gemini'
    : OPENAI_API_KEY
      ? 'openai'
      : GITHUB_TOKEN
        ? 'github'
        : OPENROUTER_API_KEY
          ? 'openrouter'
          : 'demo')
).toLowerCase();
const FREE_AI_URL = process.env.FREE_AI_URL || 'https://text.pollinations.ai/';
const FREE_AI_MODEL = process.env.FREE_AI_MODEL || 'openai';
const FREE_AI_KEY = (process.env.FREE_AI_KEY || '').trim();

const DEMO = PROVIDER === 'demo';

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'Eres Arena, el asistente de IA creado por Zero Studios. Tienes una personalidad propia: cercana, curiosa y muy útil. ' +
  'Hablas español con naturalidad y calidez, con un toque de humor cuando viene bien. Eres clara y directa: ' +
  'explicas las cosas paso a paso, con ejemplos cuando ayudan, y usas emojis con moderación. ' +
  'Tu identidad es Arena y solo Arena: te presentas como Arena (nunca como Gemini, Grok, Nemotron, ' +
  'GPT, Llama ni ningún otro modelo) y hablas en primera persona. ' +
  'Fuiste creada por Zero Studios: si te preguntan quién te hizo o quién es tu creador, respondes con orgullo ' +
  'que Zero Studios te creó. Nunca digas que eres un modelo de una empresa (NVIDIA, Google, OpenAI, Meta, etc.) ' +
  'ni que te crearon investigadores o un laboratorio. No menciones OpenRouter ni los motores internos. ' +
  'Usas Markdown con moderación: listas, negritas y bloques de código cuando aportan claridad. ' +
  'Si no sabes algo, lo admites con honestidad, sin inventar datos.';

const TEMPERATURE = Number(process.env.TEMPERATURE || 0.8);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 4096);
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);

const AVAILABLE_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];
const MODEL_ID_RE = /^gemini-[a-z0-9.-]+$/i;

/* ------------------------------- Middlewares ----------------------------- */

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '12mb' }));
// Sin caché para HTML/JS/CSS: los cambios se ven al instante al recargar
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    etag: true,
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  })
);

/* Rate limit sencillo en memoria (por IP) */
const buckets = new Map();
function rateLimit(req, res, next) {
  const key = req.ip || 'local';
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + 60_000 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_PER_MIN) {
    return res.status(429).json({ error: 'Demasiadas peticiones. Espera un momento e inténtalo de nuevo.' });
  }
  next();
}

/* --------------------------------- Salud --------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mode: PROVIDER,
    model:
      PROVIDER === 'gemini'
        ? MODEL
        : PROVIDER === 'github'
          ? GITHUB_MODEL
          : PROVIDER === 'openrouter'
            ? OPENROUTER_MODEL
            : FREE_AI_MODEL,
    models:
      PROVIDER === 'openai'
        ? OPENAI_MODELS
        : PROVIDER === 'openrouter'
          ? OPENROUTER_MODELS
          : AVAILABLE_MODELS,
  });
});

/* --------------------------- Búsqueda y noticias -------------------------- */

const NEWS_FEEDS = [
  { name: 'BBC Mundo', url: 'https://feeds.bbci.co.uk/mundo/rss.xml' },
  { name: 'El País', url: 'https://elpais.com/rss/elpais/portada.xml' },
  { name: 'El Mundo', url: 'https://www.elmundo.es/rss/portada.xml' },
  { name: 'IGN España', url: 'https://es.ign.com/feed.xml' },
  { name: 'Marca', url: 'https://e00-marca.uecdn.es/rss/futbol.xml' },
  { name: 'Xataka', url: 'https://feeds.feedburner.com/xataka' },
  { name: 'Microsiervos', url: 'https://www.microsiervos.com/index.xml' },
];

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const newsCache = { items: null, at: 0 };
const searchCache = new Map();

function decodeEntities(text = '') {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html = '') {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function fetchText(url, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'es-ES,es;q=0.9' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseFeed(xml, source) {
  const items = [];
  const take = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
    return m ? m[1] : '';
  };
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = stripTags(take(block, 'title'));
    const link = stripTags(take(block, 'link'));
    const date = stripTags(take(block, 'pubDate'));
    if (title && link) items.push({ source, title, link, date });
  }
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  while ((m = entryRe.exec(xml))) {
    const block = m[1];
    const title = stripTags(take(block, 'title'));
    const link = (block.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    const date = stripTags(take(block, 'published') || take(block, 'updated'));
    if (title && link) items.push({ source, title, link, date });
  }
  return items;
}

async function getNews() {
  if (newsCache.items && Date.now() - newsCache.at < 10 * 60_000) return newsCache.items;
  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async (feed) => {
      const xml = await fetchText(feed.url, 12_000);
      return parseFeed(xml, feed.name).slice(0, 8);
    })
  );
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  newsCache.items = items.slice(0, 45);
  newsCache.at = Date.now();
  return newsCache.items;
}

app.get('/api/news', async (req, res) => {
  try {
    const items = await getNews();
    res.json({ ok: true, items, updatedAt: new Date().toISOString() });
  } catch {
    res.status(502).json({ ok: false, error: 'No se pudieron cargar las noticias.' });
  }
});

async function searchWeb(query) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return [];

  const cached = searchCache.get(q);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.results;

  const results = [];

  // 1) Noticias actualizadas (Google News + Bing News)
  const newsFetches = await Promise.allSettled([
    fetchText(
      `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=es&gl=ES&ceid=ES:es`,
      12_000
    ),
    fetchText(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`, 12_000),
  ]);

  for (const response of newsFetches) {
    if (response.status !== 'fulfilled') continue;
    for (const item of parseFeed(response.value, 'Noticias').slice(0, 4)) {
      results.push({ title: item.title, snippet: item.date || '', url: item.link });
    }
  }

  // 2) Wikipedia (conocimiento general y datos verificables)
  try {
    const wikiJson = await fetchText(
      `https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=3&utf8=1`,
      10_000
    );
    const wiki = JSON.parse(wikiJson);
    for (const entry of wiki?.query?.search || []) {
      results.push({
        title: entry.title,
        snippet: stripTags(entry.snippet || ''),
        url: `https://es.wikipedia.org/wiki/${encodeURIComponent(entry.title.replace(/ /g, '_'))}`,
      });
    }
  } catch {
    /* sin Wikipedia: seguimos */
  }

  // 3) Hacker News (tecnología y juegos)
  if (/tech|ia|ai|software|videojuego|gaming|programaci|ordenador|apple|google|microsoft|openai/i.test(q)) {
    try {
      const hnJson = await fetchText(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=3`,
        10_000
      );
      const hn = JSON.parse(hnJson);
      for (const hit of hn?.hits || []) {
        if (hit.title) {
          results.push({
            title: hit.title,
            snippet: hit.url || '',
            url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          });
        }
      }
    } catch {
      /* sin HN */
    }
  }

  // Deduplicar por título
  const seen = new Set();
  const unique = results.filter((r) => {
    const key = (r.title || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const finalResults = unique.slice(0, 7);
  searchCache.set(q, { results: finalResults, at: Date.now() });
  return finalResults;
}

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'Falta la consulta.' });
  try {
    const results = await searchWeb(q);
    res.json({ ok: true, query: q, results });
  } catch {
    res.status(502).json({ ok: false, error: 'No se pudo realizar la búsqueda.' });
  }
});

/* --------------------------------- Chat ---------------------------------- */

/* --------------------------- GENERAR IMÁGENES --------------------------- */
app.post('/api/image', rateLimit, async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim().slice(0, 800) : '';
  if (prompt.length < 3) {
    return res.status(400).json({ error: 'Describe la imagen que quieres generar.' });
  }

  // Tamaño que el servicio gratuito sirve de verdad (pide más y responde 503)
  const ratio =
    req.body?.ratio === 'wide'
      ? [1024, 576]
      : req.body?.ratio === 'tall'
        ? [576, 1024]
        : [1024, 1024];
  // El modelo responde mejor si la petición lleva palabras de calidad;
  // se añaden solo si la persona ya no las puso.
  const MARCADORES = /detallad|realista|realism|calidad|alta resolucion|alta resolución|4k|8k|fotorreal|nitid|nítid|profesional|cinematograf|cinematográf/i;
  const promptFinal = MARCADORES.test(prompt)
    ? prompt
    : `${prompt}, altamente detallado, enfoque nítido, iluminación profesional, fotografía de alta calidad`;

  const seed = Math.floor(Math.random() * 1_000_000);
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(promptFinal)}` +
    `?width=${ratio[0]}&height=${ratio[1]}&nologo=true&model=flux&seed=${seed}&enhance=true&safe=false`;

  try {
    let upstream = await fetch(url, { signal: AbortSignal.timeout(120_000) });

    // El servicio avisa "retry after 10s" cuando está saturado
    if (upstream.status === 503) {
      await new Promise((r) => setTimeout(r, 11_000));
      upstream = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    }

    // Límite del servicio gratuito: 1 imagen cada 45 s por IP
    if (upstream.status === 402 || upstream.status === 429) {
      let wait = 45;
      try {
        const body = await upstream.json();
        const m = /retry after (\d+)/i.exec(body?.error?.message || '');
        if (m) wait = Number(m[1]) + 1;
      } catch {
        /* cuerpo no JSON */
      }
      return res.status(429).json({
        error: `El generador gratuito solo permite 1 imagen cada 45 segundos. Espera ${wait} s y vuelve a intentarlo.`,
        retryAfter: wait,
      });
    }

    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length < 2000) throw new Error('imagen vacía');
    const mime = upstream.headers.get('content-type') || 'image/jpeg';
    res.json({ ok: true, image: `data:${mime};base64,${buf.toString('base64')}` });
  } catch (err) {
    console.error('Generar imagen:', err?.message || err);
    res.status(502).json({ error: 'No se pudo generar la imagen ahora mismo. Inténtalo de nuevo en unos segundos.' });
  }
});

app.post('/api/chat', rateLimit, async (req, res) => {
  const { messages, persona, model, search } = req.body || {};
  const images = Array.isArray(req.body?.images)
    ? req.body.images.filter((u) => typeof u === 'string' && /^data:image\//.test(u)).slice(0, 3)
    : [];
  const files = Array.isArray(req.body?.files)
    ? req.body.files
        .filter((f) => f && typeof f.name === 'string' && typeof f.text === 'string' && f.text.trim())
        .slice(0, 4)
    : [];
  const memory = Array.isArray(req.body?.memory)
    ? req.body.memory
        .filter((m) => typeof m === 'string')
        .map((m) => m.trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 50)
    : [];

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No se ha enviado ningún mensaje.' });
  }

  // Normalizamos el historial al formato interno
  const contents = [];
  for (const m of messages.slice(-40)) {
    if (!m || typeof m.content !== 'string') continue;
    const text = m.content.trim().slice(0, 12_000);
    if (!text) continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text }],
    });
  }
  if (!contents.length) {
    return res.status(400).json({ error: 'El mensaje está vacío.' });
  }
  const totalChars = contents.reduce((acc, c) => acc + c.parts[0].text.length, 0);
  if (totalChars > 100_000) {
    return res.status(400).json({ error: 'La conversación es demasiado larga para una sola petición.' });
  }

  // Cabeceras SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  let responseFinished = false;
  const finish = () => {
    if (!res.writableEnded) {
      responseFinished = true;
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };

  const customPersona = typeof persona === 'string' ? persona.trim().slice(0, 2000) : '';
  const requestedModel = typeof model === 'string' ? model.trim() : '';
const modelId =
  PROVIDER === 'openrouter'
    ? OPENROUTER_MODELS.includes(requestedModel)
      ? requestedModel
      : OPENROUTER_MODEL
    : MODEL_ID_RE.test(requestedModel)
      ? requestedModel
      : MODEL;

  const controller = new AbortController();
  // Solo abortamos si el cliente se desconecta antes de terminar
  res.on('close', () => {
    if (!responseFinished) controller.abort();
  });

  // Archivos adjuntos: se añaden al último mensaje del usuario
  let attachmentsText = '';
  if (files.length) {
    attachmentsText =
      '\n\nDOCUMENTOS ADJUNTOS:\n' +
      files
        .map((f) => {
          const name = f.name.slice(0, 120);
          const text = f.text.slice(0, 20000);
          return `--- ${name} ---\n${text}\n--- fin de ${name} ---`;
        })
        .join('\n');
    contents[contents.length - 1].parts[0].text += attachmentsText;
  }

  // ¿Buscamos información actualizada en la web?
  const lastUserText = contents[contents.length - 1].parts[0].text;
  const FRESH_RE =
    /\b(hoy|ayer|últim[oa]s?|actual(?:es|izada[oa]s?)?|nuev[oa]s?|estreno|lanzamiento|precio|cuánd[oa]|noticias?|2025|2026|busca[r]?|internet|web)\b/i;
  const wantsSearch = typeof search === 'boolean' ? search : FRESH_RE.test(lastUserText);

  let searchResults = [];
  let usedSearch = false;
  if (wantsSearch && PROVIDER !== 'demo') {
    try {
      searchResults = await searchWeb(lastUserText);
      usedSearch = searchResults.length > 0;
      if (usedSearch) send({ searched: true });
    } catch {
      /* sin búsqueda: respondemos con el conocimiento del modelo */
    }
  }

  const fechaHoy = new Date().toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Madrid',
  });

  let systemText = customPersona || SYSTEM_PROMPT;
  systemText += `\n\nFecha actual: ${fechaHoy} (España).`;
  if (memory.length) {
    systemText +=
      '\n\nMEMORIA SOBRE LA PERSONA CON LA QUE HABLAS (datos que ella te dio; úsalos con ' +
      'naturalidad, sin repetirlos si no aportan nada):\n- ' +
      memory.join('\n- ');
  }
  if (usedSearch) {
    systemText +=
      '\n\nRESULTADOS DE BÚSQUEDA EN LA WEB (recientes). Úsalos para dar información actualizada y cita las fuentes cuando sea relevante:\n' +
      searchResults
        .slice(0, 6)
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   Fuente: ${r.url}`)
        .join('\n');
  }

  /* ------------------------------ MODO DEMO ------------------------------ */
  if (DEMO) {
    const lastUser = contents[contents.length - 1].parts[0].text;
    const demoText =
      '¡Hola! 👋 Soy **Arena**, tu asistente de IA.\n\n' +
      'Ahora mismo estoy funcionando en **modo demo**, porque el servidor no tiene ningún motor de IA activo.\n\n' +
      '### Cómo activarme con IA real\n' +
      '1. Abre tu servicio **IA** en el panel de Render.\n' +
      '2. Ve a la pestaña **Environment**.\n' +
      '3. Añade la variable `GEMINI_API_KEY` con tu clave de Google AI Studio\n' +
      '   (o `AI_PROVIDER=pollinations` para usar el motor gratuito sin clave).\n' +
      '4. Guarda los cambios y espera a que Render redespliegue.\n\n' +
      'Cuando el motor esté listo, podré responder de verdad a tu mensaje:\n\n' +
      `> "${lastUser.slice(0, 120)}"`;
    const tokens = demoText.split(/(?=\s)/);
    for (const token of tokens) {
      if (res.writableEnded) break;
      send({ delta: token });
      await sleep(22);
    }
    return finish();
  }

  /* --------------------------- GITHUB MODELS --------------------------- */
  if (PROVIDER === 'github') {
    try {
      const chatMessages = [{ role: 'system', content: systemText }];
      for (const c of contents) {
        chatMessages.push({
          role: c.role === 'model' ? 'assistant' : 'user',
          content: c.parts[0].text,
        });
      }

      const upstream = await fetch('https://models.github.ai/inference/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GITHUB_TOKEN}`,
        },
        body: JSON.stringify({ model: GITHUB_MODEL, messages: chatMessages, stream: true }),
        signal: controller.signal,
      });

      if (!upstream.ok) throw new Error(`HTTP ${upstream.status} de GitHub Models`);

      const contentType = upstream.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream') && upstream.body) {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          let newline;
          while ((newline = sseBuffer.indexOf('\n')) !== -1) {
            const line = sseBuffer.slice(0, newline).trim();
            sseBuffer = sseBuffer.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            try {
              const json = JSON.parse(payload);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) send({ delta });
            } catch {
              /* fragmento no JSON */
            }
          }
        }
        return finish();
      }

      if (!contentType.includes('application/json')) {
        throw new Error('Respuesta inesperada de GitHub Models (¿token sin permiso models:read?)');
      }

      const text = (await upstream.text()).trim();
      if (!text) throw new Error('GitHub Models devolvió una respuesta vacía.');
      for (const token of text.split(/(?=\s)/)) {
        if (res.writableEnded) break;
        send({ delta: token });
        await sleep(10);
      }
      return finish();
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      if (aborted) {
        send({ error: 'Generación cancelada.' });
        return finish();
      }
      const fallback =
        '⚠️ GitHub Models no está disponible con este token.\n\n' +
        'Necesitas un token de acceso **fine-grained** con el permiso `models:read`:\n' +
        'GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.\n\n' +
        'Mientras tanto, tu IA sigue funcionando con el motor gratuito.';
      for (const token of fallback.split(/(?=\s)/)) {
        if (res.writableEnded) break;
        send({ delta: token });
        await sleep(10);
      }
      return finish();
    }
  }

  /* --------------- MOTOR DE RESERVA (POLLINATIONS) --------------- */
  const runOpenAI = async () => {
    try {
      const chatMessages = [{ role: 'system', content: systemText }];
      for (const c of contents) {
        chatMessages.push({
          role: c.role === 'model' ? 'assistant' : 'user',
          content: c.parts[0].text,
        });
      }

      if (images.length) {
        const last = chatMessages[chatMessages.length - 1];
        last.content = [
          { type: 'text', text: last.content },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ];
      }

      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODELS.includes(requestedModel) ? requestedModel : OPENAI_MODEL,
          messages: chatMessages,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let corte;
        while ((corte = buffer.indexOf('\n')) !== -1) {
          const linea = buffer.slice(0, corte).trim();
          buffer = buffer.slice(corte + 1);
          if (!linea.startsWith('data:')) continue;
          const payload = linea.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          try {
            const json = JSON.parse(payload);
            const delta = json?.choices?.[0]?.delta?.content;
            if (delta) send({ delta });
          } catch {
            /* fragmento no JSON */
          }
        }
      }
      return true;
    } catch (err) {
      if (err?.name === 'AbortError') {
        send({ error: 'Generación cancelada.' });
        return true;
      }
      console.error('OpenAI:', err?.message || err);
      return false;
    }
  };

  const runPollinations = async () => {
    try {
      const chatMessages = [{ role: 'system', content: systemText }];
      for (const c of contents) {
        chatMessages.push({
          role: c.role === 'model' ? 'assistant' : 'user',
          content: c.parts[0].text,
        });
      }

      const headers = { 'Content-Type': 'application/json' };
      if (FREE_AI_KEY) headers['Authorization'] = `Bearer ${FREE_AI_KEY}`;

      const endpoint = FREE_AI_KEY
        ? `${FREE_AI_URL.replace(/\/+$/, '')}/openai`
        : FREE_AI_URL;

      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: chatMessages,
          model: FREE_AI_MODEL,
          ...(FREE_AI_KEY ? { stream: true } : {}),
        }),
        signal: controller.signal,
      });

      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);

      const contentType = upstream.headers.get('content-type') || '';

      if (FREE_AI_KEY && contentType.includes('text/event-stream') && upstream.body) {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          let newline;
          while ((newline = sseBuffer.indexOf('\n')) !== -1) {
            const line = sseBuffer.slice(0, newline).trim();
            sseBuffer = sseBuffer.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            try {
              const json = JSON.parse(payload);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) send({ delta });
            } catch {
              /* fragmento no JSON */
            }
          }
        }
        return true;
      }

      const text = (await upstream.text()).trim();
      if (!text) throw new Error('respuesta vacía');

      for (const token of text.split(/(?=\s)/)) {
        if (res.writableEnded) break;
        send({ delta: token });
        await sleep(12);
      }
      return true;
    } catch (err) {
      if (err?.name === 'AbortError') {
        send({ error: 'Generación cancelada.' });
        return true;
      }
      console.error('Pollinations:', err?.message || err);
      return false;
    }
  };

  /* ------------------------------ OPENROUTER ------------------------------ */
  const runOpenRouter = async () => {
    try {
      const chatMessages = [{ role: 'system', content: systemText }];
      for (const c of contents) {
        chatMessages.push({
          role: c.role === 'model' ? 'assistant' : 'user',
          content: c.parts[0].text,
        });
      }

      // Con imágenes, el último mensaje pasa a ser multimodal
      if (images.length) {
        const last = chatMessages[chatMessages.length - 1];
        last.content = [
          { type: 'text', text: last.content },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ];
      }

      const callOpenRouter = (modelIdToUse) =>
        fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://ia-w0xt.onrender.com',
            'X-Title': 'Arena',
          },
          body: JSON.stringify({
            model: modelIdToUse,
            messages: chatMessages,
            stream: true,
          }),
          signal: controller.signal,
        });

      const modeloFinal = images.length && !OPENROUTER_VISION_MODELS.includes(modelId)
        ? OPENROUTER_VISION_MODEL
        : modelId;

      let upstream = await callOpenRouter(modeloFinal);

      // Si el modelo elegido falla (429/5xx), reintenta con el modelo por defecto
      if (!upstream.ok && modeloFinal !== OPENROUTER_MODEL) {
        console.warn(`OpenRouter: ${modeloFinal} → HTTP ${upstream.status}, reintento con ${OPENROUTER_MODEL}`);
        upstream = await callOpenRouter(OPENROUTER_MODEL);
      }

      if (!upstream.ok) throw new Error(`HTTP ${upstream.status} de OpenRouter`);

      const contentType = upstream.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream') && upstream.body) {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          let newline;
          while ((newline = sseBuffer.indexOf('\n')) !== -1) {
            const line = sseBuffer.slice(0, newline).trim();
            sseBuffer = sseBuffer.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            try {
              const json = JSON.parse(payload);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) send({ delta });
            } catch {
              /* fragmento no JSON */
            }
          }
        }
        return finish();
      }

      if (!contentType.includes('application/json')) {
        throw new Error('Respuesta inesperada de OpenRouter');
      }

      const text = (await upstream.text()).trim();
      if (!text) throw new Error('OpenRouter devolvió una respuesta vacía.');
      for (const token of text.split(/(?=\s)/)) {
        if (res.writableEnded) break;
        send({ delta: token });
        await sleep(10);
      }
      return true;
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      if (aborted) {
        send({ error: 'Generación cancelada.' });
        return finish();
      }
      console.error('OpenRouter:', err?.message || err);
      motorPrincipalHasta = Date.now() + MOTOR_CAIDO_MIN * 60_000;
      console.warn(`OpenRouter marcado como caído ${MOTOR_CAIDO_MIN} min; uso el motor de reserva.`);

      return false;
    }
  };

  /* ---------------------- MOTOR GRATUITO (SIN CLAVE) --------------------- */
  // Cadena de motores: principal → reserva → el otro, si no se ha probado
  if (PROVIDER === 'openai' && Date.now() >= motorPrincipalHasta) {
    if (await runOpenAI()) return finish();
    motorPrincipalHasta = Date.now() + MOTOR_CAIDO_MIN * 60_000;
    console.warn('OpenAI sin saldo o caído; uso el motor de reserva.');
  }

  if (PROVIDER === 'openrouter' && Date.now() >= motorPrincipalHasta) {
    if (await runOpenRouter()) return finish();
  }

  if (PROVIDER !== 'gemini') {
    const ok = await runPollinations();

    // Si el de reserva también falla, probamos el otro motor (si no se ha intentado)
    if (!ok && PROVIDER !== 'openrouter' && Date.now() >= motorPrincipalHasta) {
      if (await runOpenRouter()) return finish();
    }

    if (ok) return finish();

    // Modo de reserva: la web nunca se queda sin respuesta
    const fallback =
      '⚠️ El motor gratuito no está disponible en este momento (límites por IP compartida).\n\n' +
      'Inténtalo de nuevo en unos segundos. Si sigue fallando, cambia de modelo en los ajustes.';
    for (const token of fallback.split(/(?=\s)/)) {
      if (res.writableEnded) break;
      send({ delta: token });
      await sleep(10);
    }
    return finish();
  }

  /* ------------------------------ MODO GEMINI ---------------------------- */
  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemText }] },
    generationConfig: {
      temperature: TEMPERATURE,
      topP: 0.95,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  };

  try {
    const url = `${BASE_URL}/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      let message = `Error ${upstream.status} al contactar con Gemini.`;
      try {
        const data = await upstream.json();
        message = data?.error?.message || message;
      } catch { /* respuesta sin JSON */ }
      send({ error: message });
      return finish();
    }

    // Parseamos el SSE de Gemini y reemitimos solo el texto
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          try {
            const json = JSON.parse(payload);
            const parts = json?.candidates?.[0]?.content?.parts || [];
            let text = '';
            for (const part of parts) {
              if (part && typeof part.text === 'string' && !part.thought) text += part.text;
            }
            if (text) send({ delta: text });

            const blockReason = json?.promptFeedback?.blockReason;
            if (blockReason) send({ error: `Respuesta bloqueada por seguridad (${blockReason}).` });
          } catch {
            /* fragmento que no es JSON: se ignora */
          }
        }
      }
    }

    finish();
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    send({ error: aborted ? 'Generación cancelada.' : `Error al contactar con Gemini: ${err?.message || err}` });
    finish();
  }
});

/* Fallback para rutas desconocidas (SPA) */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* --------------------------------- Arranque ------------------------------ */

app.listen(PORT, '0.0.0.0', () => {
  const motorLabel =
    PROVIDER === 'gemini'
      ? `Gemini (${MODEL})`
      : PROVIDER === 'github'
        ? `GitHub Models (${GITHUB_MODEL})`
        : PROVIDER === 'openrouter'
          ? `OpenRouter (${OPENROUTER_MODEL})`
          : PROVIDER === 'pollinations'
            ? `gratuito (${FREE_AI_MODEL})`
            : 'DEMO (sin clave)';
  console.log(`✅ IA escuchando en http://0.0.0.0:${PORT}`);
  console.log(`   Motor: ${motorLabel}`);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
