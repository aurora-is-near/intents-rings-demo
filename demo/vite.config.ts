import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Aurora API key is injected by the dev-server proxy, never bundled.
 * A VITE_-prefixed key would ship to every visitor's browser; this keeps the
 * prototype honest about secret handling even though it is only a demo.
 */
/**
 * Cookies set by anything else ever served on localhost are sent to :5174 too —
 * localhost cookies are not scoped by port. Forwarding them upstream both leaks
 * the tester's unrelated session tokens to a third party and, once they add up,
 * gets the request rejected by Cloudflare with 431 Request Header Fields Too
 * Large. The API is authenticated by the Authorization header alone, so drop
 * every browser-session header on the way out.
 */
function stripBrowserHeaders(req: { removeHeader: (n: string) => void }) {
  for (const h of ['cookie', 'authorization', 'referer', 'origin']) req.removeHeader(h);
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const ringsNetwork = env.RINGS_NETWORK === 'devnet' ? 'devnet' : 'mainnet';
  // Same override the production proxy uses, so dev and prod hit the same RPC.
  // The public endpoint is fine from a laptop and unreliable from a datacenter.
  const rpcOverride = (env.SOLANA_RPC_URL || '').trim().startsWith('https://')
    ? env.SOLANA_RPC_URL.trim() : '';
  return {
    define: { __RINGS_NETWORK__: JSON.stringify(ringsNetwork) },
    plugins: [react()],
    server: {
      port: 5174,
      proxy: {
        '/api/aurora': {
          target: 'https://intents-connect-api.aurora.dev',
          changeOrigin: true,
          rewrite: p => p.replace(/^\/api\/aurora/, ''),
          configure: proxy => {
            proxy.on('proxyReq', req => {
              stripBrowserHeaders(req);
              // The API is inconsistent about which auth header it accepts:
              //   GET  /executions/{w}/intermediary  → Bearer OK, x-api-key OK
              //   POST /executions/{w}/steps         → Bearer OK
              //   POST /executions/{w}  (bridge-in)  → Bearer 401, x-api-key 200
              // Verified 2026-11-04. Send both so every endpoint authenticates.
              if (env.AURORA_API_KEY) {
                req.setHeader('Authorization', `Bearer ${env.AURORA_API_KEY}`);
                req.setHeader('x-api-key', env.AURORA_API_KEY);
              }
            });
          },
        },
        // Read-only: the intermediary's SOL balance, shown for information only.
        // It is NOT a precondition — Intents Connect covers destination gas, and
        // the bridge-in deposit lands before the steps run. Always mainnet — that
        // is where Intents settles, whatever the Rings network is.
        '/api/solana-mainnet': {
          target: rpcOverride || 'https://api.mainnet-beta.solana.com',
          changeOrigin: true,
          rewrite: () => '/',
          configure: proxy => { proxy.on('proxyReq', stripBrowserHeaders); },
        },
        // The Rings leg. Mainnet since 2026-10-30; RINGS_NETWORK=devnet moves it
        // back. The program ids are identical on both, so only the RPC changes.
        '/api/solana-rings': {
          target: rpcOverride || (ringsNetwork === 'devnet'
            ? 'https://api.devnet.solana.com'
            : 'https://api.mainnet-beta.solana.com'),
          changeOrigin: true,
          rewrite: () => '/',
          configure: proxy => { proxy.on('proxyReq', stripBrowserHeaders); },
        },
      },
    },
  };
});
