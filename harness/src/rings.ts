/**
 * Rings addresses, derived from the SDK — never hardcoded.
 *
 * The SDK compiles in its own program IDs, so deriving from it guarantees the
 * registry we read and the pool we deposit into are the same deployment.
 *
 * Since 0.6.0-alpha there is a single set of ids, deployed at the SAME addresses
 * on mainnet and devnet, so the cluster is chosen by RPC endpoint alone. The old
 * parallel devnet deployments are gone. Still derived rather than hardcoded, so
 * the next version bump moves us with it.
 */
import { SHIELDED_POOL_PROGRAM_ID, USER_REGISTRY_PROGRAM_ID } from '@heliuslabs/zolana';
import { DEFAULT_TREE_ID, SOL_INTERFACE } from '@heliuslabs/zolana/interface';
import { getTreeAddress } from '@heliuslabs/zolana/addresses';

export async function ringsAddresses() {
  return {
    privacyProgram: String(SHIELDED_POOL_PROGRAM_ID),
    registryProgram: String(USER_REGISTRY_PROGRAM_ID),
    stateTree: String(await getTreeAddress(DEFAULT_TREE_ID)),
    solInterface: String(SOL_INTERFACE),
    treeId: Number(DEFAULT_TREE_ID),
  };
}
