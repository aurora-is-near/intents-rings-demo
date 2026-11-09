/**
 * Vercel serverless function covering every /api/* call.
 *
 * Vercel serves dist/ statically and runs this for the API routes, so there is
 * no long-lived process — server/index.mjs is the equivalent for hosts that do
 * run one. Both import the allowlist from ../server/proxy.mjs so there is a
 * single definition of what may be relayed.
 *
 * The API key is read from the function's environment and never reaches the
 * browser. Do NOT rename it to VITE_AURORA_API_KEY to "fix" a 401: that would
 * inline it into the bundle and publish it.
 */
import {
  classify, relayAurora, relayRpc, originAllowed, MAX_BODY, ringsNetwork, rpcHost,
} from '../server/proxy.mjs';

export const config = { runtime: 'nodejs' };

function send(res, status, body) {
  res.status(status);
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.end(body);
}

async function rawBody(req) {
  // Vercel may have parsed it already, depending on content-type.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return Buffer.from(req.body);
    if (Buffer.isBuffer(req.body)) return req.body;
    return Buffer.from(JSON.stringify(req.body));
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.AURORA_API_KEY;
    if (!apiKey) {
      // Loud and specific: this is a misconfigured deployment, not a bug.
      console.error('AURORA_API_KEY is not set in the function environment.');
      return send(res, 500, JSON.stringify({ error: 'Server is missing its API key.' }));
    }

    if (!originAllowed(req.headers.origin, process.env.ALLOWED_ORIGIN || '')) {
      return send(res, 403, JSON.stringify({ error: 'Origin not allowed.' }));
    }

    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/healthz') {
      // Host only, never the override URL: that one carries an API key.
      return send(res, 200, JSON.stringify({
        ok: true,
        ringsNetwork: ringsNetwork(),
        rpcHost: rpcHost(),
        rpcOverride: !!process.env.SOLANA_RPC_URL,
        originAllowedConfigured: !!process.env.ALLOWED_ORIGIN,
      }));
    }

    const route = classify(url.pathname);
    if (!route) return send(res, 404, JSON.stringify({ error: 'Unknown API route.' }));

    if (route.kind === 'rpc') {
      if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only.' }));
      const r = await relayRpc({ body: await rawBody(req), target: route.target });
      return send(res, r.status, r.body);
    }

    const body = ['POST', 'DELETE'].includes(req.method) ? await rawBody(req) : undefined;
    const r = await relayAurora({
      pathname: route.inner, search: url.search, method: req.method, body, apiKey,
    });
    return send(res, r.status, r.body);
  } catch (e) {
    // Never echo the error verbatim: it can carry request details.
    console.error('[api]', e?.message ?? e);
    return send(res, 500, JSON.stringify({ error: 'Internal error.' }));
  }
}
