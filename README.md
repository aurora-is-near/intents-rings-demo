# Aurora Intents × Helius Rings

Delivering cross-chain swap output straight into a recipient's **Rings confidential
balance** on Solana.

Rings gives Solana wallets a confidential balance, but today a user has to receive
funds publicly first and then shield them in a second step they have to know about.
This removes that step: when the swap settles, the output is deposited directly into
the Rings balance.

**No protocol change on either side.** Third-party, proofless deposit is documented
Rings behaviour, and delivery to an arbitrary Solana address is standard NEAR Intents.

## What's here

| | |
|---|---|
| [`demo/`](demo) | The runbook page. Connect a wallet, pick a recipient, run the flow end to end. |
| [`harness/`](harness) | Command-line harness that measures each stage and settles the encoding questions. |

Each has its own README and runs independently.

## How it works

**Origin** — the user signs one message in the wallet they already use, and NEAR
Intents settles the swap.

**Control** — the output lands in an ed25519 intermediary account derived from the
user's wallet and co-signed by NEAR Chain Signatures. Non-custodial: no hot wallet.
Intents Connect covers destination gas, so the user never funds it.

**Destination** — a Rings deposit into the recipient's confidential balance. Two
values read from the public on-chain registry are enough: the recipient's view tag
and owner hash. The sender never learns the recipient's keys.

## What is public, and what is not

The deposit itself is **public**: depositor, recipient, asset and amount are all
visible, and the recipient's view tag *is* their Solana public key, so the delivery
is linkable to them.

What becomes confidential is the **resulting balance and every later transfer**.

This is confidential delivery *into* a private balance. It is not private delivery
and should not be described as such.

## Status

Working end to end on mainnet. The Rings deposit step was confirmed on
**2026-11-06**: 78 bytes on the wire, 78 of 78 consumed by the program, 38,518 CU —
well inside both the 200,000 CU default and the 1,232-byte transaction limit.

The deposit instruction layout is not in the published Helius guide, which documents
only the SDK helper. It was read out of the SDK and verified on chain; see
[`demo/README.md`](demo/README.md) for the byte layout.

## Prerequisites

Node 20.19+ (the demo's Vite 8 build needs 22.12+ in practice). An Aurora Intents
Connect API key, a free [Reown](https://cloud.reown.com) project id, and — for any
deployment — a real Solana RPC provider.

No secrets are committed. Copy each `.env.example` to `.env` and fill it in.
