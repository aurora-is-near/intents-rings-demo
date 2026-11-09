/**
 * Tier 1 orchestrator.
 *
 * Leg A (mainnet): Aurora quote + NEAR Intents settlement -> intermediary on Solana.
 * Leg B (devnet):  Rings deposit for that SAME intermediary pubkey -> confidential balance.
 *
 * The seam is displayed, never hidden: an ed25519 address is identical on every
 * cluster, so total = A + B is a legitimate estimate of production latency.
 *
 *   npx tsx src/run.ts
 */
import { Timer } from './timing.js';
import { canReceiveConfidentially } from './registry.js';
import { fetchIntermediary } from './aurora.js';
import { env } from './config.js';

const t = new Timer();

console.log('Tier 1 — Aurora Intents x Helius Rings\n');

// --- Stage 1: registry check (devnet, no credentials needed) ---------------
const check = await t.measure('t_registry',
  () => canReceiveConfidentially(env.recipient),
  `recipient ${env.recipient.slice(0, 8)}…`);

if (!check.registered) {
  console.log('\nRecipient is not registered on devnet Rings.');
  console.log('Register it with the zolana example first:');
  console.log('  https://github.com/helius-labs/zolana-examples/tree/main/typescript-client');
  console.log('(register_private_wallet.ts). Then re-run.');
  t.report();
  process.exit(0);
}

// --- Stage 2: resolve the cluster-independent intermediary -----------------
const intermediary = await fetchIntermediary();
console.log(`\n  intermediary ${intermediary}`);
console.log('  ^ same ed25519 address on mainnet and devnet — this is the seam\n');

// --- Stage 3+: Leg A then Leg B -------------------------------------------
// TODO(leg-a): mainnet quote + settlement -> t_quote, t_settle
// TODO(leg-b): build deposit via depositInstruction({tree, depositor, deposits:[...]}),
//              sign for `intermediary` through NEAR chain signatures, submit to devnet
//              -> t_sign, t_deposit; capture CU + tx bytes here
// TODO(index):  poll until the recipient can decrypt the new balance -> t_index

console.log('Leg A / Leg B not wired yet — run `probe:memo` first (see README).');
t.report();
