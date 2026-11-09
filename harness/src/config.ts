import { readFileSync } from 'node:fs';

/** Tiny .env loader — keeps preflight runnable with zero npm install. */
function loadEnv(file = '.env') {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, k, raw] = m;
      if (process.env[k]) continue;
      process.env[k] = raw.trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env yet — fine */ }
}
loadEnv();

/**
 * Rings is live on Solana mainnet as of 2026-10-30. Use
 * @heliuslabs/zolana >= 0.6.0-alpha for the correct program ids; we pin 0.7.0-alpha.
 *
 * This supersedes the earlier devnet two-deployment split. The
 * SDK now compiles in ONE set of program ids, and BOTH clusters run them at the
 * SAME addresses (verified 2026-10-30 against api.mainnet-beta and api.devnet):
 *
 *     shielded pool   ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW   executable
 *     user registry   regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ   executable
 *     SOL interface   CiNmas621VuyofiDSrEPfTXHKrdZuB6jMKECyNiMpLXE
 *
 * So the network is now purely a choice of RPC endpoint, not of address set.
 * The old ids (sppU489…/regyS5rk… and spp3Cf…) are dead — neither resolves any
 * more. Addresses are still DERIVED from the SDK at runtime (see rings.ts) so a
 * version bump moves us automatically rather than silently diverging.
 *
 * The consequence for this project is large: Leg A (Intents settlement) and
 * Leg B (Rings deposit) can now BOTH run on mainnet. The cluster seam the whole
 * prototype was designed around — joining two networks at the ed25519
 * intermediary — is no longer needed to demonstrate the flow.
 *
 * Registry population, observed 2026-10-30:
 *     mainnet    11 accounts  (brand new)
 *     devnet  1,512 accounts
 */
export const RINGS_NETWORKS = {
  mainnet: {
    /** Plain Solana RPC. Photon is an INDEXER and does not serve getAccountInfo. */
    rpc: 'https://api.mainnet-beta.solana.com',
    photon: 'https://dgcj4pjarvo65.cloudfront.net',
    prover: 'https://d3ky2kt0ntqxt1.cloudfront.net',
  },
  devnet: {
    rpc: 'https://api.devnet.solana.com',
    photon: 'https://d34xe1hqb2ibg2.cloudfront.net',
    prover: 'https://dd73hh473h6ha.cloudfront.net',
  },
} as const;

export type RingsNetwork = keyof typeof RINGS_NETWORKS;

/**
 * Deploy slots and upgrade authorities per cluster, observed 2026-10-30.
 *
 * Neither deployment is frozen. Both programs remain upgradeable under a live
 * authority, and mainnet uses a DIFFERENT key from devnet. A silent redeploy can
 * change an instruction discriminator or account layout beneath a deposit blob
 * we built earlier, so preflight pins these and shouts when they move.
 */
export const PINNED_DEPLOYMENTS = {
  mainnet: {
    privacyProgram: 462234536,
    registryProgram: 462231048,
    upgradeAuthority: 'Dhf62DbddAc2uDNqnz13W8Z1MpF5MVJ8dvh3Uvhif7Tr',
  },
  devnet: {
    privacyProgram: 516193118,
    registryProgram: 513647465,
    upgradeAuthority: '2kgbLowvCQuMWxDKbHUZAURycziuRrvmtTuDEYMGMRsj',
  },
} as const;

/** Intents Connect destination-transaction envelope (Solana). */
export const CONNECT_LIMITS = {
  computeUnits: 200_000,   // shared across ALL steps; clients may not inject ComputeBudget
  maxTxBytes: 1_232,
  maxSolanaSteps: 50,
  maxBodyBytes: 256 * 1024,
} as const;

/** Which cluster the Rings leg runs against. Mainnet is now the default. */
export const RINGS_NETWORK: RingsNetwork =
  (process.env.RINGS_NETWORK as RingsNetwork) ?? 'mainnet';

export const env = {
  auroraApi: process.env.AURORA_CONNECT_API ?? 'https://intents-connect-api.aurora.dev',
  auroraKey: process.env.AURORA_API_KEY ?? '',
  originWallet: process.env.ORIGIN_WALLET ?? '',
  network: RINGS_NETWORK,

  /** Solana RPC for the Rings leg. A Helius key upgrades it; otherwise public. */
  get ringsRpc() {
    const explicit = process.env.SOLANA_RPC ?? '';
    // Ignore unexpanded shell-style placeholders from .env.example.
    if (explicit && !explicit.includes('${')) return explicit;
    const key = process.env.HELIUS_API_KEY ?? '';
    const host = RINGS_NETWORK === 'mainnet' ? 'mainnet' : 'devnet';
    if (key) return `https://${host}.helius-rpc.com/?api-key=${key}`;
    return RINGS_NETWORKS[RINGS_NETWORK].rpc;
  },
  get photonRpc() { return process.env.PHOTON_RPC || RINGS_NETWORKS[RINGS_NETWORK].photon; },
  get proverUrl() { return process.env.NITRO_PROVER || RINGS_NETWORKS[RINGS_NETWORK].prover; },

  /** Kept as an alias so older call sites keep compiling. */
  get devnetRpc() { return this.ringsRpc; },
  publicRpc: RINGS_NETWORKS[RINGS_NETWORK].rpc,
  recipient: process.env.RECIPIENT_SOLANA_ADDRESS ?? '',
};
