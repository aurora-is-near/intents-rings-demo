/**
 * Long-lived Node server for the Rings demo — containers, VMs, Fly, Railway.
 *
 * On Vercel this file is not used: Vercel serves dist/ statically and runs
 * api/[...path].mjs for the API routes. Both import the allowlist from
 * ./proxy.mjs, so what may be relayed has a single definition.
 *
 * In development the Vite dev server proxies /api/* and injects the Aurora API
 * key. `vite build` emits static files and no server, so that proxy disappears.
 * Without something taking its place there are only two outcomes, both wrong:
 * every API call 401s, or someone "fixes" it by renaming the key to
 * VITE_AURORA_API_KEY — which inlines it into the bundle and ships it to every
 * visitor. This process keeps the third option available.
 *
 * No dependencies — plain node:http, so it runs anywhere Node 18+ runs.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classify, relayAurora, relayRpc, originAllowed, MAX_BODY, ringsNetwork, rpcHost,
} from './proxy.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const API_KEY = process.env.AURORA_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

if (!API_KEY) {
  console.error('AURORA_API_KEY is not set. Refusing to start: every Aurora call '
    + 'would 401, which looks like a broken app rather than a missing secret.');
  process.exit(1);
}

/* ------------------------------------------------------------- rate limiting
 * Crude per-IP window, in process memory. It stops a casual scraper if the URL
 * leaks; it is not a substitute for a real gateway, and behind a load balancer
 * remoteAddress is the balancer, not the client. */
const WINDOW_MS = 60_000;
const MAX_REQS = 120;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { n: 1, reset: now + WINDOW_MS });
    return false;
  }
  rec.n += 1;
  return rec.n > MAX_REQS;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now > rec.reset) hits.delete(ip);
}, WINDOW_MS).unref();

/* --------------------------------------------------------------- helpers */

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

const writeRelay = (res, r) => {
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(r.body);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------ static files */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png',
  '.ico': 'image/x-icon', '.map': 'application/json',
};

async function serveStatic(req, res, pathname) {
  // normalize() collapses any ../ before it can escape dist/.
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '');
  let file = join(DIST, rel || 'index.html');
  if (!file.startsWith(DIST)) return json(res, 403, { error: 'Forbidden.' });

  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, 'index.html');
  } catch {
    // Unknown path: hand back index.html so the SPA can route it.
    file = join(DIST, 'index.html');
  }

  try {
    const data = await readFile(file);
    const immutable = rel.startsWith('assets/'); // Vite content-hashes these
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Not found.' });
  }
}

/* -------------------------------------------------------------------- main */

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress ?? 'unknown';

    if (url.pathname === '/healthz') {
      return json(res, 200, { ok: true, ringsNetwork: ringsNetwork(), rpcHost: rpcHost() });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!originAllowed(req.headers.origin, ALLOWED_ORIGIN)) {
        return json(res, 403, { error: 'Origin not allowed.' });
      }
      if (rateLimited(ip)) return json(res, 429, { error: 'Too many requests.' });

      const route = classify(url.pathname);
      if (!route) return json(res, 404, { error: 'Unknown API route.' });

      if (route.kind === 'rpc') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
        return writeRelay(res, await relayRpc({ body: await readBody(req), target: route.target }));
      }

      const body = ['POST', 'DELETE'].includes(req.method) ? await readBody(req) : undefined;
      return writeRelay(res, await relayAurora({
        pathname: route.inner, search: url.search, method: req.method, body, apiKey: API_KEY,
      }));
    }

    await serveStatic(req, res, url.pathname);
  } catch (e) {
    // Never echo the error upstream verbatim: it can carry request details.
    console.error('[server]', e?.message ?? e);
    if (!res.headersSent) json(res, 500, { error: 'Internal error.' });
  }
});

server.listen(PORT, () => {
  console.log(`Rings demo on :${PORT}  (rings network: ${ringsNetwork()}, rpc: ${rpcHost()})`);
  console.log(`  static   ${DIST}`);
  console.log(`  api key  loaded, ${API_KEY.length} chars, never sent to the browser`);
  if (!ALLOWED_ORIGIN) console.log('  note     ALLOWED_ORIGIN unset — set it in production');
});
