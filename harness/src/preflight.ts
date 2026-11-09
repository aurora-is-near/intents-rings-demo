/**
 * Runs with NO credentials against public Solana RPC.
 *
 * Verifies the Rings deployment is intact and has not been redeployed since we
 * pinned it. Neither cluster is frozen — both programs stay upgradeable under a
 * live authority — so a silent redeploy is a real risk: it can change an
 * instruction discriminator or account layout beneath a deposit blob we built
 * earlier.
 *
 *   npx tsx src/preflight.ts            # the configured network (mainnet)
 *   RINGS_NETWORK=devnet npx tsx src/preflight.ts
 */
import { PINNED_DEPLOYMENTS, RINGS_NETWORKS, RINGS_NETWORK, env } from './config.js';
import { ringsAddresses } from './rings.js';
import { rpc, base58 } from './rpc.js';

const NETWORK = RINGS_NETWORK;
const PINNED = PINNED_DEPLOYMENTS[NETWORK];
const RPC = RINGS_NETWORKS[NETWORK].rpc;
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

async function account(addr: string) {
  const r = await rpc<any>(RPC, 'getAccountInfo', [addr, { encoding: 'base64' }]);
  return r?.value ?? null;
}

/** For an upgradeable program account: data = [u32 enum][32B programdata addr]. */
async function programData(programId: string) {
  const acc = await account(programId);
  if (!acc) return null;
  const raw = Buffer.from(acc.data[0], 'base64');
  const pdAddr = base58(raw.subarray(4, 36));
  const pd = await account(pdAddr);
  if (!pd) return null;
  const pdRaw = Buffer.from(pd.data[0], 'base64');
  return {
    programDataAddress: pdAddr,
    lastDeployedSlot: Number(pdRaw.readBigUInt64LE(4)),
    upgradeAuthority: pdRaw[12] ? base58(pdRaw.subarray(13, 45)) : null,
    sizeBytes: pdRaw.length,
    executable: acc.executable,
    owner: acc.owner,
  };
}

async function main() {
  const RINGS = await ringsAddresses();
  console.log(`preflight — Rings devnet\nRPC: ${RPC}`);
  console.log(`SDK deployment (derived, not hardcoded):`);
  console.log(`  privacy  ${RINGS.privacyProgram}`);
  console.log(`  registry ${RINGS.registryProgram}`);
  console.log(`  tree[${RINGS.treeId}]  ${RINGS.stateTree}`);
  console.log(`  solIface ${RINGS.solInterface}\n`);

  for (const [label, id] of [
    ['privacyProgram', RINGS.privacyProgram],
    ['registryProgram', RINGS.registryProgram],
  ] as const) {
    const pd = await programData(id);
    if (!pd) { add(label, false, 'account not found'); continue; }
    add(`${label} executable`, pd.executable && pd.owner === LOADER,
        `owner=${pd.owner} executable=${pd.executable}`);

    const pinned = PINNED[label];
    const moved = pd.lastDeployedSlot !== pinned;
    add(`${label} deploy slot`, !moved,
        moved
          ? `REDEPLOYED: pinned ${pinned} -> now ${pd.lastDeployedSlot}. Re-derive the discriminator and re-verify the account layout before trusting any cached deposit blob.`
          : `unchanged at ${pinned}`);

    add(`${label} upgrade authority`, pd.upgradeAuthority === PINNED.upgradeAuthority,
        pd.upgradeAuthority === PINNED.upgradeAuthority
          ? `${PINNED.upgradeAuthority} (still upgradeable — not frozen)`
          : `CHANGED: ${pd.upgradeAuthority}`);
  }

  const tree = await account(RINGS.stateTree);
  add('state merkle tree', !!tree && tree.owner === RINGS.privacyProgram,
      tree ? `owner=${tree.owner} data=${Buffer.from(tree.data[0], 'base64').length}B` : 'not found');

  const iface = await account(RINGS.solInterface);
  const sol = iface ? iface.lamports / 1e9 : 0;
  add('SOL interface PDA', !!iface,
      iface ? `holds ${sol.toFixed(2)} SOL (native escrow — no data account)` : 'not found');

  // Mainnet and devnet now run the same program ids, so the SDK addresses must
  // resolve on BOTH. If one cluster is missing them, the SDK has moved again.
  const other = NETWORK === 'mainnet' ? 'devnet' : 'mainnet';
  const otherPool = (await rpc<any>(RINGS_NETWORKS[other].rpc, 'getAccountInfo',
    [RINGS.privacyProgram, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]))?.value;
  add('same ids on both clusters', !!otherPool,
      otherPool ? `${RINGS.privacyProgram.slice(0, 12)}… also live on ${other}`
                : `NOT on ${other} — the SDK ids are cluster-specific again`);

  const registered = await rpc<any>(RPC, 'getProgramAccounts',
    [RINGS.registryProgram, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]).catch(() => null);
  add('registry populated', Array.isArray(registered) && registered.length > 0,
      Array.isArray(registered) ? `${registered.length} registered owners on ${NETWORK}` : 'could not enumerate');

  console.log(`\nRings preflight — network: ${NETWORK}  rpc: ${RPC}\n`);
  console.log(checks.map(c => `  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.name.padEnd(30)} ${c.detail}`).join('\n'));

  const failed = checks.filter(c => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) {
    console.log('\nBlocking before you build against this deployment:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error('preflight error:', e.message); process.exitCode = 1; });
