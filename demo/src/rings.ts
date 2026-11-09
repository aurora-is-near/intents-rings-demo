/**
 * Registry check in the browser.
 *
 * Addresses are derived from the SDK, never hardcoded. Since @heliuslabs/zolana
 * 0.6.0-alpha there is one set of program ids, live at the same addresses on
 * mainnet and devnet, so the cluster is chosen by RPC endpoint alone.
 *
 * The SDK is loaded lazily so a bundling problem degrades to a clear message
 * instead of a blank page.
 */
import bs58 from 'bs58';
import { ringsRpc } from './api';

export interface RecipientCheck {
  registered: boolean;
  /** Hex, for display. */
  viewTag?: string;
  ownerHash?: string;
  /**
   * The same two values base58-encoded, which is how they ride in the deposit
   * step. The Intents Connect encoder length-prefixes a `bytes` arg (proven on
   * mainnet: a 21-byte payload arrived as 25 with a 4-byte LE length), so these
   * 32-byte hashes are passed as `pubkey` args instead — fixed width, appended
   * raw. Any 32 bytes are a valid base58 pubkey string.
   */
  viewTagB58?: string;
  ownerHashB58?: string;
  error?: string;
}

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** Guard: the deposit layout is fixed-width, so a wrong size must not reach it. */
function expect32(b: Uint8Array, what: string): Uint8Array {
  if (b.length !== 32) throw new Error(`${what} is ${b.length} bytes, expected 32`);
  return b;
}

/**
 * The Rings state tree the deposit writes into, derived from the SDK rather
 * than hardcoded — the same rule the harness follows, so a version bump moves
 * the demo with it instead of silently pointing at a dead tree.
 */
let treeCache: string | undefined;
export async function ringsTreeAddress(): Promise<string> {
  if (treeCache) return treeCache;
  const [{ DEFAULT_TREE_ID }, { getTreeAddress }] = await Promise.all([
    import('@heliuslabs/zolana/interface'),
    import('@heliuslabs/zolana/addresses'),
  ]);
  treeCache = String(await getTreeAddress(DEFAULT_TREE_ID));
  return treeCache;
}

/** Program ids for the deposit step, also derived from the SDK. */
export async function ringsProgramIds() {
  const [{ SHIELDED_POOL_PROGRAM_ID }, { SOL_INTERFACE }] = await Promise.all([
    import('@heliuslabs/zolana'),
    import('@heliuslabs/zolana/interface'),
  ]);
  return {
    pool: String(SHIELDED_POOL_PROGRAM_ID),
    solInterface: String(SOL_INTERFACE),
  };
}

/** Satisfies Pick<ChainReader,'getAccount'> — the only method the lookup needs. */
const accountReader = {
  async getAccount(address: string) {
    const r: any = await ringsRpc('getAccountInfo', [address, { encoding: 'base64' }]);
    const v = r?.value;
    if (!v) return undefined;
    const bin = atob(v.data[0]);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return { owner: v.owner, data, lamports: BigInt(v.lamports) };
  },
} as any;

export async function checkRecipient(recipient: string): Promise<RecipientCheck> {
  try {
    const [{ resolveRegisteredAddress }, { initializePoseidon }] = await Promise.all([
      import('@heliuslabs/zolana/wallet'),
      import('@heliuslabs/zolana'),
    ]);
    // ownerHash() is a Poseidon hash; without this it throws NotInitialized.
    await initializePoseidon();

    const resolved = await resolveRegisteredAddress({ rpc: accountReader, owner: recipient as any });
    if (!resolved) return { registered: false };

    const viewTag = expect32(resolved.viewTag as unknown as Uint8Array, 'viewTag');
    const ownerHash = expect32(await (resolved.address as any).ownerHash(), 'ownerHash');

    return {
      registered: true,
      viewTag: hex(viewTag),
      ownerHash: hex(ownerHash),
      viewTagB58: bs58.encode(viewTag),
      ownerHashB58: bs58.encode(ownerHash),
    };
  } catch (e: any) {
    return { registered: false, error: `Registry lookup failed: ${e.message ?? e}` };
  }
}
