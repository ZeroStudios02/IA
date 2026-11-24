# IA — Servidor de chat con Google Gemini

Aplicación web completa tipo **Grok / Gemini**: un chat de inteligencia artificial con interfaz moderna, historial de conversaciones, streaming de texto en tiempo real y motor **Google Gemini**. Preparada para desplegarse en **Render** en un clic.

---

## ✨ Características

- 💬 Chat en tiempo real con **streaming** (SSE) de las respuestas
- 🧠 Motor **Google Gemini** (`gemini-2.5-flash` por defecto, configurable)
- 🗂️ Historial de conversaciones guardado en el navegador (`localStorage`)
- ✏️ Títulos automáticos, eliminar y regenerar respuestas
- 📋 Copiar mensajes y bloques de código con un clic
- 🎨 Interfaz oscura estilo asistente moderno, totalmente responsive
- 🧩 Renderizado de **Markdown** propio (código, listas, tablas, citas…)
- 🔒 La API key vive **solo en el servidor**: nunca llega al navegador
- 🧪 **Modo demo** automático si no hay API key (para probar la web)
- 🎭 **IA personalizada**: nombre, personalidad (instrucción de sistema) y modelo configurables desde la interfaz
- 🌍 **Búsqueda web en tiempo real**: noticias actualizadas (Google News, Bing News), Wikipedia y Hacker News
- 📰 **Panel de noticias de hoy** con titulares de BBC, El País, El Mundo, IGN, Marca y Xataka
- ✏️ **Edición de mensajes**, sugerencias rápidas y regeneración
- 🎙️ **Dictado por voz** (Web Speech API) y buscador de chats
- 🌗 **Tema claro/oscuro** con selector de modelo estilo ChatGPT
- 🚦 Rate limit básico por IP para evitar abusos

---

## 🧱 Stack

| Capa | Tecnología |
|---|---|
| Backend | Node.js 18+ / Express |
| Frontend | HTML + CSS + JavaScript vanilla (sin frameworks) |
| IA | Google Gemini API (`streamGenerateContent`) |
| Despliegue | Render (Web Service, plan gratuito) |

---

## 📁 Estructura

```
ia/
├── server.js          # Servidor Express + proxy con Gemini (streaming)
├── package.json
├── render.yaml        # Blueprint de despliegue en Render
├── .env.example       # Plantilla de variables de entorno
└── public/
    ├── index.html     # Interfaz del chat
    ├── style.css      # Estilos (tema oscuro responsive)
    └── app.js         # Lógica del cliente (streaming, markdown, historial)
```

---

## 🎭 Personaliza tu IA

Desde la barra lateral → **Personalizar IA** puedes definir, sin tocar código:

- **Nombre** de tu asistente (aparece en el logo, la bienvenida y el título)
- **Personalidad**: instrucción de sistema que define tono, estilo y rol
- **Modelo**: Gemini 2.5 Flash, 2.5 Pro o 2.0 Flash

Los ajustes se guardan en el navegador y se envían al servidor en cada mensaje,
que los aplica como instrucción de sistema. ✨

## 🧠 Motores de IA disponibles

| Motor | Variable | Clave necesaria | Notas |
|---|---|---|---|
| **Gemini** (recomendado) | `GEMINI_API_KEY` | Sí | Máxima calidad |
| **Gratuito sin clave** | `AI_PROVIDER=pollinations` | No | Ideal para empezar |
| **Demo** | por defecto sin clave | No | Respuestas simuladas |

> El motor gratuito es un servicio comunitario con límites de uso; para producción estable, usa Gemini.

## 🔑 Obtener tu API key de Gemini (gratis)

1. Entra en [Google AI Studio](https://aistudio.google.com/apikey).
2. Inicia sesión con tu cuenta de Google.
3. Pulsa **Create API key** y copia la clave.

> La clave es gratuita con cuotas generosas para uso personal.

---

## 🚀 Desplegar en Render

### Opción A — Blueprint (recomendada)

1. Sube esta carpeta a un repositorio de GitHub.
2. En Render: **New → Blueprint**, conecta el repo y selecciona `render.yaml`.
3. Al crear el servicio, Render pedirá el valor de `GEMINI_API_KEY`. Pega tu clave.
4. ¡Listo! Render instalará, desplegará y hará health-check a `/api/health`.

### Opción B — Manual

1. Crea un **Web Service** en Render conectado a tu repo.
2. Configura:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Node Version:** `20` (o añade `NODE_VERSION=20.18.0` en Environment)
3. En **Environment**, añade:
   - `GEMINI_API_KEY` = tu clave de Gemini
   - `GEMINI_MODEL` = `gemini-2.5-flash` (opcional)
4. Guarda y espera el despliegue.

> ⚠️ Si el servicio ya existe (como tu servicio **IA**), solo tienes que conectar el repositorio en **Settings → Repository** y añadir las variables de entorno.

---

## ⚙️ Variables de entorno

| Variable | Obligatoria | Por defecto | Descripción |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ | — | Clave de Google AI Studio |
| `GEMINI_MODEL` | — | `gemini-2.5-flash` | Modelo de Gemini a usar |
| `GEMINI_BASE_URL` | — | API oficial | Endpoint alternativo (compatibilidad) |
| `SYSTEM_PROMPT` | — | Asistente "IA" en español | Personalidad del asistente |
| `TEMPERATURE` | — | `0.8` | Creatividad (0–2) |
| `MAX_OUTPUT_TOKENS` | — | `4096` | Longitud máxima de respuesta |
| `RATE_LIMIT_PER_MIN` | — | `30` | Peticiones por minuto e IP |
| `PORT` | — | `3000` | Puerto (Render lo asigna solo) |

> 💡 Sin `GEMINI_API_KEY`, la web funciona en **modo demo** para que puedas probarla.

---

## 💻 Desarrollo local

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar tu clave (opcional)
cp .env.example .env
# edita .env con tu GEMINI_API_KEY

# 3. Arrancar
npm start
# con recarga automática: npm run dev
```

Abre `http://localhost:3000`. Para cargar el `.env` automáticamente puedes usar
`node --env-file=.env server.js` (Node 20+) o instalar `dotenv`.

---

## 🔒 Seguridad

- La API key se guarda **solo en las variables de entorno de Render**, nunca en el código ni en el cliente.
- El frontend habla únicamente con `/api/chat`; el servidor hace de intermediario con Gemini.
- Se valida y recorta el historial enviado (máx. 40 mensajes / 100 000 caracteres).
- Rate limit por IP para limitar el abuso del endpoint.

---

## 🧭 Ideas para siguientes pasos

- [ ] Subida de imágenes (multimodal con Gemini)
- [ ] Exportar/importar conversaciones en JSON
- [ ] Selector de modelo en la interfaz
- [ ] Cuentas de usuario (Supabase / Auth0)
- [ ] Selector de tema claro/oscuro
- [ ] Búsqueda dentro del historial

---

Hecho con ❤️ para desplegar en Render.
