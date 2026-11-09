# Production server

In development, the Vite dev server proxies `/api/*` and injects the Aurora API
key. `vite build` emits static files and no server, so that proxy disappears.
This process takes its place.

It does four things:

1. serves the built files from `dist/`
2. holds `AURORA_API_KEY` and attaches it to upstream Aurora calls
3. strips browser-session headers before anything leaves
4. refuses to relay anything the app itself does not call

## Run it

```bash
npm run serve
```

That builds and starts on `:8080`. To start without rebuilding, `npm start`.

## Deploying to Vercel

Vercel is serverless, so `server/index.mjs` has nowhere to run. Vercel serves
`dist/` statically and runs `api/[...path].mjs` for the API routes instead. Both
import the allowlist from `server/proxy.mjs`, so there is one definition of what
may be relayed.

`vercel.json` sets the build and the rewrites. Set the project root to `demo/`.

### Environment variables on Vercel

Set these in **Project Settings → Environment Variables**, for Production and
Preview both.

| Variable | Value | Scope | Secret? |
|---|---|---|---|
| `AURORA_API_KEY` | your Aurora key | runtime | **yes** — never expose |
| `VITE_REOWN_PROJECT_ID` | your Reown project id | **build** | no, it is a public client id |
| `RINGS_NETWORK` | `mainnet` (or `devnet`) | **build and runtime** | no |
| `ALLOWED_ORIGIN` | `https://your-domain.vercel.app` | runtime | no |

Three things are easy to get wrong here.

**`VITE_REOWN_PROJECT_ID` is needed at build time, not runtime.** Vite inlines
`VITE_`-prefixed variables into the bundle during `vite build`. Add it after a
build and the deployed app will have an empty project id and no wallet modal
until you redeploy.

**`RINGS_NETWORK` is needed at both.** The build inlines it for the UI copy, and
the function reads it to pick the Solana RPC. Set it in one place only and the
page can claim one network while the lookups hit the other.

**Never prefix the Aurora key with `VITE_`.** If API calls 401 in production,
the cause is a missing or misscoped `AURORA_API_KEY` on the function, not a
missing prefix. Adding one would publish the key to every visitor.

`PORT` is not used on Vercel; it only applies to the standalone server.

### After deploying

Set `ALLOWED_ORIGIN` to the real domain once you know it. Until then any origin
can call your proxy and spend your Aurora quota.

The in-memory rate limiter does almost nothing on Vercel, since each invocation
may be a fresh instance. Use Vercel's own firewall / rate limiting for a public
deployment.

## Environment (standalone server)

| Variable | Required | Notes |
|---|---|---|
| `AURORA_API_KEY` | yes | The process exits if unset, rather than starting and 401ing every call. Never `VITE_`-prefixed — that would inline it into the bundle. |
| `PORT` | no | Defaults to 8080. |
| `RINGS_NETWORK` | no | `mainnet` (default) or `devnet`. |
| `ALLOWED_ORIGIN` | **in production** | e.g. `https://rings.example.com`. Unset means any origin may call the proxy. |

`VITE_REOWN_PROJECT_ID` is a public client identifier and belongs in the build,
not here.

## Why the allowlist exists

A proxy that forwards any path with your key attached is an open relay for that
key: anyone who finds the URL can spend your quota. The allowlist in
`index.mjs` is the whole defence, so it is written as exact path shapes with
per-route methods rather than a prefix match.

Wallet segments are pinned to the EVM address shape, so the path cannot be bent
to reach other upstream routes. The Solana RPC endpoints carry no key but are
still restricted to `getBalance` and `getAccountInfo` — an open RPC relay is
someone else's bandwidth bill.

**If you add an API call to `src/api.ts`, add its route here too**, or it will
404 in production while working fine in development. That asymmetry is
deliberate: the dev proxy is permissive so you can explore, and this is the
list of what you actually shipped.

## What this is not

A rate limiter keyed on remote IP, in process memory. It stops a casual scraper
if the URL leaks; it is not a substitute for a real gateway, and it resets on
deploy. Behind a load balancer, `req.socket.remoteAddress` is the balancer, so
put proper limiting in front of this before it carries meaningful traffic.

## Deploying elsewhere

Any Node host works — there are no dependencies beyond Node 18+ (it uses the
built-in `fetch`). Build, then run `node server/index.mjs` with the environment
set. `GET /healthz` returns `{ ok: true }` for a load-balancer check.

For a platform that only does static hosting (plain S3, GitHub Pages), this
server has nowhere to run — you would need a function or a small container
alongside it. Static-only hosting cannot keep the key secret.
