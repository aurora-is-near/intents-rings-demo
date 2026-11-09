/**
 * The proxy rules, shared by both deployment shapes:
 *
 *   server/index.mjs      a long-lived Node process (container, VM, Fly, Railway)
 *   api/[...path].mjs     a Vercel serverless function
 *
 * Both import from here so the allowlist has ONE definition. Two copies would
 * drift, and the copy that drifts is the one guarding the API key.
 */

const AURORA_UPSTREAM = 'https://intents-connect-api.aurora.dev';
const SOLANA_MAINNET = 'https://api.mainnet-beta.solana.com';
const SOLANA_DEVNET = 'https://api.devnet.solana.com';

export const MAX_BODY = 256 * 1024; // the API's own body limit

export const ringsNetwork = () =>
  process.env.RINGS_NETWORK === 'devnet' ? 'devnet' : 'mainnet';

/**
 * api.mainnet-beta.solana.com is a courtesy endpoint, not a production one: it
 * rate-limits hard and blocks whole datacenter ranges, so the same call that
 * works from a laptop can 403 or 429 from a serverless function. Set
 * SOLANA_RPC_URL to a real provider (Helius, Triton, QuickNode) in any
 * deployment. The URL carries an API key, so it is a server-side secret and
 * must never be VITE_-prefixed.
 */
const rpcOverride = () => {
  const u = (process.env.SOLANA_RPC_URL || '').trim();
  return u.startsWith('https://') ? u : '';
};

export const ringsRpcUrl = () =>
  rpcOverride() || (ringsNetwork() === 'devnet' ? SOLANA_DEVNET : SOLANA_MAINNET);

/** The Intents leg always settles on mainnet, whatever RINGS_NETWORK says. */
export const mainnetRpcUrl = () =>
  ringsNetwork() === 'devnet' ? SOLANA_MAINNET : (rpcOverride() || SOLANA_MAINNET);

/**
 * Host only — an override URL carries an API key in its path or query, so the
 * full URL must never be returned to a caller.
 */
export const rpcHost = () => {
  try { return new URL(ringsRpcUrl()).host; } catch { return 'invalid'; }
};

const EVM = '0x[0-9a-fA-F]{40}';
const UUID = '[0-9a-fA-F-]{36}';

/**
 * Exactly the endpoints src/api.ts calls, and nothing else.
 *
 * A proxy that forwards any path with the key attached is an open relay for
 * that key. Wallet segments are pinned to the EVM address shape so a path
 * cannot be bent toward other upstream routes, and every entry names its
 * methods.
 *
 * ADD A CALL TO src/api.ts -> ADD ITS ROUTE HERE, or it works in dev and 404s
 * in production.
 */
export const AURORA_ROUTES = [
  { re: new RegExp(`^/api/v1/executions/${EVM}$`), methods: ['GET', 'POST'] },
  { re: new RegExp(`^/api/v1/executions/${EVM}/intermediary$`), methods: ['GET'] },
  { re: new RegExp(`^/api/v1/executions/${EVM}/steps$`), methods: ['POST'] },
  { re: new RegExp(`^/api/v1/executions/${EVM}/submit$`), methods: ['POST'] },
  { re: new RegExp(`^/api/v1/executions/${EVM}/${UUID}$`), methods: ['DELETE'] },
  { re: /^\/api\/v1\/executions\/deposit\/submit$/, methods: ['POST'] },
];

/** Read-only JSON-RPC methods the app uses. Nothing else is relayed. */
export const RPC_METHODS = new Set(['getBalance', 'getAccountInfo']);

export function auroraRouteAllowed(pathname, method) {
  const route = AURORA_ROUTES.find(r => r.re.test(pathname));
  return !!route && route.methods.includes(method);
}

/**
 * Browser-session headers are never forwarded. Beyond the privacy leak, cookies
 * on localhost are not scoped by port, so unrelated tokens pile up and
 * Cloudflare rejects the request with 431. Upstream authenticates on the key
 * attached here, nothing else.
 */
export function outboundHeaders(extra = {}) {
  return { 'content-type': 'application/json', accept: 'application/json', ...extra };
}

/** Both headers: /executions/{wallet} takes only x-api-key and 401s on Bearer. */
export function auroraAuthHeaders(key) {
  return outboundHeaders({ 'x-api-key': key, authorization: `Bearer ${key}` });
}

export function originAllowed(origin, allowed) {
  if (!allowed) return true;
  // Same-origin requests from the served page send no Origin header.
  return !origin || origin === allowed;
}

/**
 * Relay one Aurora call. Returns { status, body } — the caller writes it,
 * because Node's http and Vercel's handler differ in how they respond.
 */
export async function relayAurora({ pathname, search = '', method, body, apiKey }) {
  if (!auroraRouteAllowed(pathname, method)) {
    return { status: 404, body: JSON.stringify({ error: 'Not a proxied endpoint.' }) };
  }
  const upstream = await fetch(`${AURORA_UPSTREAM}${pathname}${search}`, {
    method,
    headers: auroraAuthHeaders(apiKey),
    body: body && body.length ? body : undefined,
  });
  return { status: upstream.status, body: await upstream.text() };
}

/** Relay one Solana JSON-RPC read, after checking the method. */
export async function relayRpc({ body, target }) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body).toString('utf8')); } catch {
    return { status: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
  }
  if (!RPC_METHODS.has(parsed?.method)) {
    return { status: 403, body: JSON.stringify({ error: `RPC method not allowed: ${parsed?.method}` }) };
  }
  const upstream = await fetch(target, { method: 'POST', headers: outboundHeaders(), body });
  return { status: upstream.status, body: await upstream.text() };
}

/** Which upstream a given /api/* path maps to, or null. */
export function classify(pathname) {
  if (pathname.startsWith('/api/aurora/')) {
    return { kind: 'aurora', inner: pathname.replace('/api/aurora', '') };
  }
  if (pathname === '/api/solana-mainnet') return { kind: 'rpc', target: mainnetRpcUrl() };
  if (pathname === '/api/solana-rings') return { kind: 'rpc', target: ringsRpcUrl() };
  return null;
}
