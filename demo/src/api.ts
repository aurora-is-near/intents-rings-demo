/** All Aurora calls go through the Vite proxy, which injects the API key. */
const AURORA = '/api/aurora';

export interface Intermediary { evm: string; solana: string; sui: string; originAccount: string; originType: string }

export async function fetchIntermediary(wallet: string): Promise<Intermediary> {
  const r = await fetch(`${AURORA}/api/v1/executions/${wallet}/intermediary`);
  if (!r.ok) throw new Error(`intermediary: ${r.status} ${await r.text()}`);
  return (await r.json()).result;
}

export interface SolanaStep {
  programId: string;
  discriminator?: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  args?: { name: string; type: string; value: string }[];
  metadata?: Record<string, unknown>;
}

/**
 * Steps-only execution. Assumes the intermediary ALREADY holds the destination
 * token — nothing is bridged in. Use createBridgeInExecution for the normal
 * flow; this mode is kept for acting on funds already sitting in the
 * intermediary (e.g. recovery), where that assumption genuinely holds.
 */
export async function createStepsExecution(
  wallet: string,
  steps: SolanaStep[],
  opts: { destinationAsset: string; dry?: boolean; addressLookupTables?: string[] },
) {
  const r = await fetch(`${AURORA}/api/v1/executions/${wallet}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'solana', steps, dry: opts.dry ?? false, destinationAsset: opts.destinationAsset,
      ...(opts.addressLookupTables ? { addressLookupTables: opts.addressLookupTables } : {}) }),
  });
  const text = await r.text();
  if (!r.ok) {
    if (r.status === 409) throw new Error('An execution is already in progress for this wallet.');
    if (r.status === 503) throw new Error('No Solana durable nonce available right now — retry.');
    throw new Error(`${r.status}: ${text}`);
  }
  return JSON.parse(text).result;
}

export interface BridgeInQuote {
  originAsset: string;
  destinationAsset: string;
  /** Smallest unit of the ORIGIN asset, as a string. */
  amount: string;
  swapType?: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  /** Basis points: 100 = 1%. */
  slippageTolerance?: number;
  /** Where a failed/expired swap is refunded. The origin wallet. */
  refundTo: string;
}

/**
 * Bridge-in execution: POST /executions/{wallet} with a `quote`.
 *
 * This is the mode the product actually uses, and the one the prototype should
 * have used from the start. The deposit leg delivers the destination token to
 * the intermediary FIRST, then the steps run against it, and the network fee is
 * quoted into the operation.
 *
 * Contrast with createStepsExecution (steps-only), whose single documented
 * assumption is that "the intermediary already holds the destination token...
 * the funds are already in place". Asserting that against an empty intermediary
 * is what produced the misleading
 *
 *     400 Transfer: insufficient lamports 0, need 10000
 *
 * which was briefly mistaken for a requirement that the USER fund the
 * intermediary. It is not. Verified 2026-11-04: a dry bridge-in against the same
 * empty intermediary returns 200 with networkFee 10000 and amountOut ~0.0746 SOL
 * — the fee comes out of what the deposit delivers.
 *
 * Note `quote.recipient` must NOT be sent: the API rejects it with
 * "quote.recipient is only valid when outOperation=true". For a bridge-in the
 * recipient IS the intermediary, and the API fills it in.
 */
export async function createBridgeInExecution(
  wallet: string,
  steps: SolanaStep[],
  quote: BridgeInQuote,
  opts: { dry?: boolean; addressLookupTables?: string[] } = {},
) {
  const r = await fetch(`${AURORA}/api/v1/executions/${wallet}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'solana',
      dry: opts.dry ?? false,
      quote: {
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        ...quote,
      },
      steps,
      ...(opts.addressLookupTables ? { addressLookupTables: opts.addressLookupTables } : {}),
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    if (r.status === 409) throw new Error('An execution is already in progress for this wallet.');
    if (r.status === 503) throw new Error('No Solana durable nonce available right now — retry.');
    throw new Error(`${r.status}: ${text}`);
  }
  return JSON.parse(text).result;
}

export async function submitSignature(wallet: string, executionId: string, signature: string) {
  const r = await fetch(`${AURORA}/api/v1/executions/${wallet}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executionId, signature }),
  });
  if (!r.ok) throw new Error(`submit: ${r.status} ${await r.text()}`);
  return (await r.json()).result;
}

export async function fetchExecution(wallet: string, executionId: string) {
  const r = await fetch(`${AURORA}/api/v1/executions/${wallet}?id=${executionId}`);
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j.result) ? j.result.find((e: any) => e.id === executionId) ?? null : j.result;
}

/** Statuses the API will delete. SUCCESS rows cannot be removed. */
export const DELETABLE = [
  'CREATED', 'DEPOSIT_PENDING', 'OPERATION_PENDING',
  'EXPIRED', 'DEPOSIT_FAILED', 'OPERATION_FAILED',
] as const;

/** Every execution the API still holds for this wallet, newest first. */
export async function listExecutions(wallet: string): Promise<any[]> {
  const r = await fetch(`${AURORA}/api/v1/executions/${wallet}`);
  if (!r.ok) return [];
  const j = await r.json();
  const rows = Array.isArray(j.result) ? j.result : j.result ? [j.result] : [];
  return rows.filter(Boolean).sort((a: any, b: any) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

/**
 * The execution currently blocking a new run, if any. A 409 from create does not
 * say which row it collided with, so it has to be looked up.
 */
export async function blockingExecution(wallet: string) {
  const rows = await listExecutions(wallet);
  return rows.find(e => (DELETABLE as readonly string[]).includes(e?.status)) ?? null;
}

/**
 * Cancel an execution: DELETE /executions/{wallet}/{executionId}.
 *
 * The body is a signed delete request. `signature` is a personal_sign over the
 * literal UTF-8 string `delete_execution:<executionId>` — not JSON-wrapped and
 * not pre-hashed — encoded exactly like a submit signature (curve prefix +
 * base58, v normalised to 0/1). No publicKey: the backend ecrecovers the signer
 * and checks it against the wallet in the URL, so only the owner can delete.
 *
 * NOTE: the docs do not say what becomes of a deposit that has already arrived.
 * Deleting a row whose deposit landed is therefore not known to be safe — the
 * caller should warn before offering this on anything past DEPOSIT_PENDING.
 */
export async function deleteExecution(wallet: string, executionId: string, signature: string) {
  const r = await fetch(`${AURORA}/api/v1/executions/${wallet}/${executionId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature }),
  });
  const text = await r.text();
  if (!r.ok) {
    if (r.status === 404) throw new Error('That execution no longer exists — it may already be gone.');
    if (r.status === 409) throw new Error(`It cannot be deleted in its current state. ${text}`);
    throw new Error(`cancel: ${r.status} ${text}`);
  }
  return text ? JSON.parse(text).result : null;
}

/** The message the delete signature must cover, verbatim. */
export const deleteMessage = (executionId: string) => `delete_execution:${executionId}`;

/**
 * Tell the backend the origin-chain deposit has been sent.
 *
 * The docs describe this as recording the hash and notifying 1click, but do not
 * say whether it is mandatory — the deposit address is watched, so a deposit is
 * likely picked up either way. We call it because it should shorten detection,
 * and treat a failure as non-fatal: by the time this runs the funds have already
 * left the wallet, so throwing here would be misleading.
 *
 * `memo` is only for MEMO-mode chains (Stellar and similar). Base is SIMPLE
 * mode, so it is omitted.
 */
export async function submitDepositHash(
  txHash: string, depositAddress: string, memo?: string | null,
) {
  const r = await fetch(`${AURORA}/api/v1/executions/deposit/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash, depositAddress, ...(memo ? { memo } : {}) }),
  });
  if (!r.ok) throw new Error(`deposit hash: ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text).result : null;
}

/**
 * The intermediary's SOL balance, in lamports (0 when the account does not exist).
 *
 * This is shown for information only and is NOT a precondition. Intents Connect
 * covers destination gas: "Destination gas remains an Intents Connect execution
 * responsibility, not a user prerequisite" (docs, intermediary-accounts).
 * See createBridgeInExecution below for why an earlier version of this file
 * claimed otherwise.
 */
export async function intermediaryBalance(address: string): Promise<number> {
  const r = await fetch('/api/solana-mainnet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result?.value ?? 0;
}

/**
 * Registry read over the proxied public Solana RPC — no Helius key needed.
 * Rings went live on mainnet on 2026-10-30, so both legs now run there and the
 * devnet seam is gone. Set RINGS_NETWORK=devnet to point the proxy back.
 */
export async function ringsRpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch('/api/solana-rings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  // Never go straight to r.json(). A 403 from the proxy, or a 429/HTML page
  // from the public RPC, either parses into a shape where j.error.message is
  // undefined or throws a SyntaxError — both surface as an opaque SDK failure
  // (WALLET_FETCH_USER_RECORD) with the real cause thrown away.
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch {
    throw new Error(`RPC ${method}: HTTP ${r.status}, non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(`RPC ${method}: HTTP ${r.status} ${text.slice(0, 200)}`);
  if (j.error) throw new Error(`RPC ${method}: ${j.error?.message ?? JSON.stringify(j.error)}`);
  return j.result;
}
