/**
 * Rings registry lookup — the quote-time check.
 *
 * Confirmed against the SDK: @heliuslabs/zolana exports
 * `resolveRegisteredAddress({rpc, owner}) -> {owner, address: ShieldedAddress, viewTag}`,
 * which needs no key material. That is exactly the third-party path Aurora needs.
 *
 * `rpc` only has to satisfy Pick<ChainReader,'getAccount'>, so we implement that
 * one method over plain JSON-RPC and skip both the Helius key and ZolanaClient.
 *
 *   npx tsx src/registry.ts <solanaAddress>
 */
import { resolveRegisteredAddress } from '@heliuslabs/zolana/wallet';
import { initializePoseidon } from '@heliuslabs/zolana';
import { env } from './config.js';
import { rpc } from './rpc.js';

/** Minimal AccountReader over public devnet RPC. */
export const accountReader = {
  async getAccount(address: string) {
    const r = await rpc<any>(env.ringsRpc, 'getAccountInfo', [address, { encoding: 'base64' }]);
    const v = r?.value;
    if (!v) return undefined;
    return {
      owner: v.owner,
      data: new Uint8Array(Buffer.from(v.data[0], 'base64')),
      lamports: BigInt(v.lamports),
    };
  },
} as any;

export interface ConfidentialCheck {
  registered: boolean;
  viewTag?: Uint8Array;
  ownerHash?: Uint8Array;
}

/**
 * The two values a deposit needs, derived from public registry data alone.
 * Returns {registered:false} when the recipient cannot receive confidentially —
 * the UI greys the option and the quote falls back to a public delivery.
 */
export async function canReceiveConfidentially(recipient: string): Promise<ConfidentialCheck> {
  // ownerHash() is a Poseidon hash — the hasher must be initialised first,
  // otherwise it throws `NotInitialized`. Cheap and idempotent.
  await initializePoseidon();
  const resolved = await resolveRegisteredAddress({ rpc: accountReader, owner: recipient as any });
  if (!resolved) return { registered: false };
  return {
    registered: true,
    viewTag: resolved.viewTag as unknown as Uint8Array,
    ownerHash: await (resolved.address as any).ownerHash(),
  };
}

if (process.argv[1]?.endsWith('registry.ts')) {
  const addr = process.argv[2] ?? env.recipient;
  if (!addr) { console.error('usage: tsx src/registry.ts <solanaAddress>'); process.exit(1); }
  const t0 = performance.now();
  const res = await canReceiveConfidentially(addr);
  const ms = Math.round(performance.now() - t0);
  console.log(`registry lookup for ${addr}  (${ms} ms)`);
  console.log(res.registered
    ? `  REGISTERED — can receive confidentially\n  viewTag=${Buffer.from(res.viewTag!).toString('hex')}\n  ownerHash=${Buffer.from(res.ownerHash!).toString('hex')}`
    : '  not registered — confidential delivery unavailable, quote must fall back to public');
}
