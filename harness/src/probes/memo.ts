/**
 * MEMO PROBE — the cheapest de-risker in the project. Run this first.
 *
 * Answers two things in one mainnet execution costing a few lamports:
 *
 *  1. Open question #9: does the Intents Connect step encoder append a `bytes`
 *     arg RAW after the discriminator, or Borsh-length-prefix it? The whole
 *     the deposit-blob workaround (build the Rings deposit blob with the zolana SDK and
 *     pass it as one `bytes` arg) depends on the answer. The Memo program
 *     writes its input verbatim to the log, so the on-chain log tells us
 *     exactly what arrived.
 *  2. t_sign in isolation: MPC co-sign + submit latency, with no bridge leg.
 *
 * Run with `--dry` first to inspect the encoding without committing.
 *
 *   npx tsx src/probes/memo.ts --dry
 *   npx tsx src/probes/memo.ts
 */
import { createStepsExecution, fetchIntermediary } from '../aurora.js';
import { env } from '../config.js';

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const PROBE = 'AURORA_RINGS_PROBE_v1';

const dry = process.argv.includes('--dry');

if (!env.originWallet || !env.auroraKey) {
  console.error('Set ORIGIN_WALLET and AURORA_API_KEY in .env first.');
  process.exit(1);
}

const intermediary = await fetchIntermediary();
console.log(`origin       ${env.originWallet}`);
console.log(`intermediary ${intermediary}   <- same address on devnet and mainnet\n`);

const payload = Buffer.from(PROBE, 'utf8').toString('hex');

const res = await createStepsExecution([{
  programId: MEMO_PROGRAM,
  // No discriminator: the Memo program takes raw bytes as its whole instruction data.
  accounts: [{ pubkey: '{INTERMEDIARY}', isSigner: true, isWritable: true }],
  args: [{ name: 'memo', type: 'bytes', value: payload }],
  metadata: { name: 'encoder-probe' },
}], { dry, destinationAsset: 'nep141:sol.omft.near' });

console.log(JSON.stringify(res, null, 2));

console.log(`
WHAT TO LOOK FOR
  Sent bytes (hex): ${payload}
  Sent as UTF-8:    ${PROBE}

  After it lands, read the transaction log:
    - log shows exactly "${PROBE}"        -> bytes are appended RAW. The
                                             workaround holds. Proceed.
    - log shows 4 junk bytes then the text -> the encoder length-prefixes bytes.
                                             We need a 'raw' passthrough type or a
                                             first-class rings_deposit step from the
                                             Aurora platform team. Escalate.

  Record the CREATED -> SUCCESS wall time as t_sign.
`);
