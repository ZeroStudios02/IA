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

// Motor de IA: 'gemini' (con clave), 'pollinations' (gratuito, sin clave) o 'demo'
const PROVIDER = (process.env.AI_PROVIDER || (API_KEY ? 'gemini' : 'demo')).toLowerCase();
const FREE_AI_URL = process.env.FREE_AI_URL || 'https://text.pollinations.ai/';
const FREE_AI_MODEL = process.env.FREE_AI_MODEL || 'openai';
const FREE_AI_KEY = (process.env.FREE_AI_KEY || '').trim();
const DEMO = PROVIDER === 'demo';

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'Eres Arena, el asistente de IA de Arena.ai. Tienes una personalidad propia: cercana, curiosa y muy útil. ' +
  'Hablas español con naturalidad y calidez, con un toque de humor cuando viene bien. Eres clara y directa: ' +
  'explicas las cosas paso a paso, con ejemplos cuando ayudan, y usas emojis con moderación. ' +
  'Te presentas como Arena (nunca como Gemini, Grok ni ningún otro modelo) y hablas en primera persona. ' +
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
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));

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
    model: PROVIDER === 'gemini' ? MODEL : FREE_AI_MODEL,
    models: AVAILABLE_MODELS,
  });
});

/* --------------------------------- Chat ---------------------------------- */

app.post('/api/chat', rateLimit, async (req, res) => {
  const { messages, persona, model } = req.body || {};

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
  const modelId = typeof model === 'string' && MODEL_ID_RE.test(model) ? model : MODEL;

  const controller = new AbortController();
  // Solo abortamos si el cliente se desconecta antes de terminar
  res.on('close', () => {
    if (!responseFinished) controller.abort();
  });

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

  /* ---------------------- MOTOR GRATUITO (SIN CLAVE) --------------------- */
  if (PROVIDER === 'pollinations') {
    try {
      const chatMessages = [{ role: 'system', content: customPersona || SYSTEM_PROMPT }];
      for (const c of contents) {
        chatMessages.push({
          role: c.role === 'model' ? 'assistant' : 'user',
          content: c.parts[0].text,
        });
      }

      const headers = { 'Content-Type': 'application/json' };
      if (FREE_AI_KEY) headers['Authorization'] = `Bearer ${FREE_AI_KEY}`;

      const upstream = await fetch(FREE_AI_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: chatMessages, model: FREE_AI_MODEL }),
        signal: controller.signal,
      });

      if (!upstream.ok) throw new Error(`HTTP ${upstream.status} del motor gratuito`);

      const text = (await upstream.text()).trim();
      if (!text) throw new Error('El motor gratuito devolvió una respuesta vacía.');

      // Emitimos en streaming para mantener la experiencia de chat en vivo
      for (const token of text.split(/(?=\s)/)) {
        if (res.writableEnded) break;
        send({ delta: token });
        await sleep(12);
      }
      return finish();
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      if (aborted) {
        send({ error: 'Generación cancelada.' });
        return finish();
      }

      // Modo de reserva: la web nunca se queda sin respuesta
      const fallback =
        '⚠️ El motor gratuito no está disponible en este momento (tiene límites por IP compartida).\n\n' +
        'Para usar tu IA sin límites, añade una clave de Gemini en **Render → Environment**:\n' +
        '`GEMINI_API_KEY` = tu clave de Google AI Studio (empieza por `AIza...`).\n\n' +
        'Puedes generarla gratis en https://aistudio.google.com/apikey';
      for (const token of fallback.split(/(?=\s)/)) {
        if (res.writableEnded) break;
        send({ delta: token });
        await sleep(10);
      }
      return finish();
    }
  }

  /* ------------------------------ MODO GEMINI ---------------------------- */
  const body = {
    contents,
    systemInstruction: { parts: [{ text: customPersona || SYSTEM_PROMPT }] },
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
      : PROVIDER === 'pollinations'
        ? `gratuito (${FREE_AI_MODEL})`
        : 'DEMO (sin clave)';
  console.log(`✅ IA escuchando en http://0.0.0.0:${PORT}`);
  console.log(`   Motor: ${motorLabel}`);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
