# Measurement harness

Exercises the Aurora Intents × Helius Rings flow from the command line and measures
how long each stage takes. It also settles the two questions the UI can't answer on
its own: the Solana compute budget for a Rings deposit, and how the Intents Connect
step encoder serialises arguments.

**Origin chain: Base (EVM)** → `signingStandard: erc191` (personal_sign).

## One cluster, since 2026-10-30

Rings went live on Solana mainnet on 2026-10-30, so both legs now run there and the
earlier devnet seam is gone. The SDK compiles in one set of program ids, live at the
same addresses on both clusters, so the network is a choice of RPC endpoint alone.

Set `RINGS_NETWORK=devnet` to point the Rings leg back at the test cluster.

- **Leg A — Aurora quote + NEAR Intents settlement**, delivering to the intermediary.
- **Leg B — the Rings deposit**, signed for that same intermediary pubkey.

## Order of operations

```bash
npm install
cp .env.example .env     # fill in as you go
```

### 1. Preflight — works right now, no credentials

```bash
npx tsx src/preflight.ts
```

Verifies the Rings deployment and **fails loudly if it was redeployed**. Both
programs are upgradeable under a live authority, so the IDL is not frozen — a
redeploy can change the discriminator or account layout beneath a deposit blob
built earlier. Pin the SDK version exactly and re-run this before any demo.

### 2. Registry read — needs only a recipient address

```bash
npx tsx src/registry.ts <solanaAddress>
```

Uses `resolveRegisteredAddress` from `@heliuslabs/zolana` over public RPC. No key
material, no Helius key. This is the quote-time check.

### 3. Encoder probe — one mainnet execution, a few lamports

```bash
npx tsx src/probes/memo.ts --dry   # inspect encoding first
npx tsx src/probes/memo.ts
```

Submits a Memo step carrying a known `bytes` payload. The Memo program writes its
input verbatim to the transaction log, so the result shows exactly how the encoder
treats a `bytes` argument, and gives `t_sign` in isolation.

**Answered, 2026-11-06:** a `bytes` arg is Borsh `Vec<u8>` — a 4-byte little-endian
length prefix, then the payload. A 21-byte payload arrived as 25. It is *not*
appended raw, which is why the deposit passes its two 32-byte hashes as fixed-width
`pubkey` args instead.

### 4. Full run

```bash
npx tsx src/run.ts
```

Writes `out/run-<timestamp>.json` and `.csv`.

## Stages measured

| Stage | What |
|---|---|
| `t_quote` | Aurora Swap API quote |
| `t_registry` | registry PDA lookup |
| `t_settle` | origin deposit → asset at intermediary |
| `t_sign` | MPC co-sign + submit |
| `t_deposit` | deposit tx → confirmed |
| `t_index` | confirmed → recipient can decrypt |

`t_index` is the one nobody has measured — the user's "did it arrive?" moment.

Perceived latency = `t_quote + t_settle + t_sign + t_deposit + t_index`.

The same Leg B run captures **CU consumed, tx bytes and account count**. Measured on
mainnet: a single-asset SOL deposit is **78 bytes and 38,518 CU**, comfortably inside
the 200,000 CU default and the 1,232-byte transaction limit.

## Scope

Native **SOL only** — the SOL interface PDA already exists, which removes
interface-PDA creation, the Kora allow-list and ATA derivation entirely. The registry
check runs client-side, with no Swap API changes. The public-delivery fallback is
exercised as a separate manual execution.

## Status

- [x] Preflight
- [x] Registry resolver
- [x] Aurora Intents Connect client
- [x] Encoder probe — answered
- [x] Leg A wiring
- [x] Leg B deposit, confirmed on mainnet 2026-11-06
- [ ] `t_index` measurement
