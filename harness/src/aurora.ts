/** Aurora Intents Connect client (mainnet). Docs: docs.intents.aurora.dev */
import { env, CONNECT_LIMITS } from './config.js';

const headers = () => ({
  'Content-Type': 'application/json',
  ...(env.auroraKey ? { Authorization: `Bearer ${env.auroraKey}` } : {}),
});

export interface SolanaStep {
  programId: string;
  discriminator?: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  args?: { name: string; type: string; value: string }[];
  metadata?: Record<string, unknown>;
}

/** The ed25519 Solana account derived from the origin wallet. Same address on every cluster. */
export async function fetchIntermediary(originWallet = env.originWallet): Promise<string> {
  const r = await fetch(`${env.auroraApi}/api/v1/executions/${originWallet}/intermediary`, { headers: headers() });
  if (!r.ok) throw new Error(`intermediary: HTTP ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.result?.solana ?? j.result?.address ?? j.solana ?? JSON.stringify(j);
}

/** Steps-only execution. `dry: true` previews without committing. */
export async function createStepsExecution(
  steps: SolanaStep[],
  opts: { destinationAsset?: string; dry?: boolean; addressLookupTables?: string[] } = {},
) {
  if (steps.length > CONNECT_LIMITS.maxSolanaSteps)
    throw new Error(`${steps.length} steps exceeds the ${CONNECT_LIMITS.maxSolanaSteps} limit`);

  const body = { type: 'solana', steps, dry: opts.dry ?? false,
    ...(opts.destinationAsset ? { destinationAsset: opts.destinationAsset } : {}),
    ...(opts.addressLookupTables ? { addressLookupTables: opts.addressLookupTables } : {}) };

  const r = await fetch(`${env.auroraApi}/api/v1/executions/${env.originWallet}/steps`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    if (r.status === 409) throw new Error('409: an execution is already in progress for this wallet');
    if (r.status === 503) throw new Error('503: no Solana durable nonce available — retry');
    throw new Error(`steps: HTTP ${r.status} ${text}`);
  }
  return JSON.parse(text).result;
}

/** EVM origin signs `details.messageToSign` with personal_sign (erc191). */
export async function submitSignature(executionId: string, signature: string, publicKey?: string) {
  const r = await fetch(`${env.auroraApi}/api/v1/executions/${env.originWallet}/submit`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ executionId, signature, ...(publicKey ? { publicKey } : {}) }),
  });
  if (!r.ok) throw new Error(`submit: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()).result;
}

const TERMINAL = new Set(['SUCCESS', 'EXPIRED', 'DEPOSIT_FAILED', 'OPERATION_FAILED']);

export async function pollUntilTerminal(executionId: string, timeoutMs = 25 * 60_000, everyMs = 2_000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetch(`${env.auroraApi}/api/v1/executions/${env.originWallet}?id=${executionId}`, { headers: headers() });
    if (r.ok) {
      const j = await r.json();
      const ex = Array.isArray(j.result) ? j.result.find((e: any) => e.id === executionId) : j.result;
      const status = ex?.status;
      if (status && status !== last) { console.log(`    status: ${status}  (+${((Date.now() - t0) / 1000).toFixed(1)}s)`); last = status; }
      if (status && TERMINAL.has(status)) return ex;
    }
    await new Promise(res => setTimeout(res, everyMs));
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s (last status: ${last || 'unknown'})`);
}
