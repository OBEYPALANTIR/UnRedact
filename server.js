import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_CHARS = 200_000;
const MAX_REQUESTS_PER_MINUTE = 10;

export function createApp({
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  apiBaseUrl,
} = {}) {
  const app = express();
  const ai = apiKey ? new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: 110_000, ...(apiBaseUrl ? { baseUrl: apiBaseUrl } : {}) },
  }) : null;
  const requestTimes = [];
  let active = false;

  // This is a local app. Reject DNS rebinding and cross-origin browser requests.
  app.use((req, res, next) => {
    const port = req.socket.localPort;
    const authorities = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
    if (!authorities.has(req.headers.host) ||
        (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ error: { message: 'Only same-origin local requests are allowed' } });
    }
    next();
  });

  app.post('/api/analyze', express.json({ limit: '30mb' }), async (req, res) => {
    const { base64, prompt } = req.body ?? {};
    if (typeof base64 !== 'string' || typeof prompt !== 'string' || !prompt.trim() ||
        prompt.length > MAX_PROMPT_CHARS || base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 ||
        base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      return res.status(400).json({ error: { message: 'Expected a PDF up to 20 MB and a prompt up to 200,000 characters' } });
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      return res.status(400).json({ error: { message: 'Invalid PDF data' } });
    }
    if (!ai) {
      return res.status(503).json({ error: { message: 'Set GEMINI_API_KEY on the local server to enable analysis' } });
    }
    const now = Date.now();
    while (requestTimes.length && requestTimes[0] <= now - 60_000) requestTimes.shift();
    if (active || requestTimes.length >= MAX_REQUESTS_PER_MINUTE) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: { message: 'Analysis limit reached; wait before retrying' } });
    }
    requestTimes.push(now);
    active = true;
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          { inlineData: { data: base64, mimeType: 'application/pdf' } },
          { text: prompt },
        ],
        config: {
          abortSignal: controller.signal,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              reconstructedText: { type: Type.STRING },
              redactions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    type: { type: Type.STRING }, text: { type: Type.STRING },
                    score: { type: Type.NUMBER }, method: { type: Type.STRING },
                    alternatives: { type: Type.ARRAY, items: { type: Type.STRING } },
                    explanation: { type: Type.STRING },
                  },
                },
              },
            },
          },
        },
      });
      const result = JSON.parse(response.text || '{}');
      if (typeof result.reconstructedText !== 'string' || !Array.isArray(result.redactions)) {
        throw new Error('Invalid analysis response');
      }
      res.json(result);
    } catch {
      if (!res.destroyed) {
        res.status(502).json({ error: { message: 'Analysis failed; check the server model and API access, then retry' } });
      }
    } finally {
      res.off('close', onClose);
      active = false;
    }
  });

  // Preserve cross-references for both development and the local production build.
  app.get('/api/epstein/v2/persons', async (req, res) => {
    const { q, per_page: perPage = '5' } = req.query;
    if (typeof q !== 'string' || q.length > 100 || typeof perPage !== 'string' ||
        !/^(?:[1-9]|1[0-9]|20)$/.test(perPage)) {
      return res.status(400).json({ error: { message: 'Invalid person query' } });
    }
    const upstream = new URL('https://epsteinexposed.com/api/v2/persons');
    upstream.searchParams.set('q', q);
    upstream.searchParams.set('per_page', perPage);
    try {
      const response = await fetch(upstream, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return res.sendStatus(response.status);
      res.json(await response.json());
    } catch {
      res.status(502).json({ error: { message: 'Cross-reference service unavailable' } });
    }
  });
  app.use('/api', (req, res) => res.sendStatus(404));
  // Avoid returning request bodies or upstream details in parser errors.
  app.use((err, req, res, next) => {
    res.status(err.status === 413 ? 413 : 400).json({ error: { message: 'Invalid request body' } });
  });
  return app;
}

export async function startServer({ port = Number(process.env.PORT || 3000), production = process.env.NODE_ENV === 'production', ...options } = {}) {
  const app = createApp(options);
  let vite;
  if (production) {
    app.use(express.static(path.join(directory, 'dist')));
  } else {
    const { createServer } = await import('vite');
    vite = await createServer({
      server: { middlewareMode: true, host: '127.0.0.1' },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  }).catch(async (error) => {
    await vite?.close();
    throw error;
  });
  server.on('close', () => { void vite?.close(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const file of ['.env.local', '.env']) {
    try { process.loadEnvFile(path.join(directory, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  startServer().then((server) => {
    console.log(`UnRedact running locally at http://127.0.0.1:${server.address().port}`);
  }).catch(() => {
    console.error('Could not start the local UnRedact server');
    process.exitCode = 1;
  });
}
