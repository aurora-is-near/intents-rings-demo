# Rings demo — prototype page

A runbook page for delivering NEAR Intents swap output straight into a recipient's
Helius Rings **confidential balance** on Solana.

The tester connects their own EVM wallet (Reown AppKit / WalletConnect), enters a
Solana recipient, and runs the flow end to end: bridge in from Base, then deposit
into the Rings shielded pool in the same Intents Connect execution.

Styled on the live [intents.aurora.dev](https://intents.aurora.dev) design language
(light, Onest + JetBrains Mono) — `src/styles/aurora-intents.css`.

## Setup

```bash
cp .env.example .env
npm install
npm run dev     # http://localhost:5174
```

| Key | Notes |
|---|---|
| `VITE_REOWN_PROJECT_ID` | Free from [cloud.reown.com](https://cloud.reown.com). **Required** — without it the connect button renders a warning chip instead. |
| `AURORA_API_KEY` | **No `VITE_` prefix, on purpose.** See below. |
| `RINGS_NETWORK` | `mainnet` (default) or `devnet`. |
| `SOLANA_RPC_URL` | Optional. A real RPC provider, which any deployment needs — see below. |

### Why the Aurora key has no `VITE_` prefix

Anything `VITE_`-prefixed is inlined into the bundle and shipped to every visitor.
The Aurora key is a server-side credential, so the dev server proxies `/api/aurora/*`
and injects the auth headers there; the browser never sees it. `server/` does the
same job in production — see [`server/README.md`](server/README.md).

### Why `SOLANA_RPC_URL` exists

`api.mainnet-beta.solana.com` is a courtesy endpoint. It rate-limits hard and blocks
whole datacenter ranges, so the registry lookup that works from a laptop can fail
from a serverless function. Point `SOLANA_RPC_URL` at Helius, Triton or QuickNode for
anything deployed. The URL carries an API key, so it is server-side only — never
`VITE_`-prefixed.

## What works

- **Wallet connect** — Reown AppKit, Base as the default network, themed to the design system.
- **Intermediary resolution** — the ed25519 Solana address derived from the connected wallet.
  Intents Connect covers destination gas; the tester never funds it.
- **Registry check** — live, debounced, running `@heliuslabs/zolana` in the browser.
  Shows `viewTag` + `ownerHash` for a registered recipient, or an amber chip and a
  disabled action for an unregistered one. Verified against the harness: identical values.
- **Deposit from the tester's wallet** — a Base transaction for the quoted `amountIn`.
- **Execution** — bridge-in execution, `personal_sign` (erc191) on `messageToSign`,
  submit, then polls to a terminal status with a live timer. Cancellable.

## The Rings deposit step

Wired and **confirmed on mainnet** (2026-11-06): 78 bytes on the wire, 78 of 78
consumed by the program, 38,518 CU.

The layout is not in the Helius guide, which documents only the SDK helper — it was
read out of the SDK and verified on chain:

| Field | Type |
|---|---|
| discriminator | `u8` = `0x0f` (one byte, **not** Anchor's eight) |
| `assetsLen`, `assetKind`, `depositsLen`, `assetIndex` | `u8` each |
| `viewTag` | 32 bytes |
| `recipientOwnerHash` | 32 bytes |
| `amount` | `u64` LE |
| `memo` | `Option` tag |

The two 32-byte hashes ride as **`pubkey`** args, not `bytes`. A `bytes` arg is
serialised as Borsh `Vec<u8>` — a 4-byte LE length prefix, proven on mainnet by the
Memo probe — which would corrupt a fixed-width layout. `pubkey` is appended raw.

## A note on what is confidential

`confidentialViewTag()` **is the recipient's Solana public key**, so the delivery
transaction is publicly linkable to the recipient. What becomes confidential is the
resulting **balance and all subsequent activity**. Keep copy honest about this: it is
confidential delivery *into* a private balance, not private delivery.

## Dependency overrides

`package.json` pins two transitive versions. Both are deliberate — don't drop them
without re-running `npm audit`:

- **`zod@^4.6.7`** — `@reown/appkit-wallet` pins `zod@3.22.4`, which carries a high
  severity memory-exhaustion advisory (GHSA-mrhx-c7xc-m3w5) with no fix in any
  published AppKit release. That single pin was the root of 8 of 9 high findings.
  AppKit's schemas use only APIs that are stable across the v3→v4 break (its one
  `z.record` call already passes two arguments), and the override was verified by
  opening the modal and completing a live WalletConnect relay handshake.
- **`@base-org/account@^2.5.1`** — resolves a genuinely broken tree (`@wagmi/connectors`
  required `^2.5.1` while `2.4.0` was installed).

## Known gaps

- The 3 remaining low-severity audit findings come from `@heliuslabs/zolana` →
  `@phala/dcap-qvl` → `elliptic`, with no fix published. The SDK is alpha.
- `t_index` (deposit confirmed → recipient can decrypt) is not measured here; that
  lives in the harness.
- `GET /executions/{wallet}` returns an empty list while an execution is in flight,
  so it is not a reliable status source. Poll the execution id instead.
