// @4thtech-io/occ-v2-abi (M1-3f, D-83): the OCC v2 contract interface for this repository.
//
// - The ABIs and addresses are the exported JSON of a tagged release of the private contracts
//   repository (artifacts/<tag>/), verified file by file against the release's SHA-256 manifest,
//   whose own hash is pinned in release.json (tools/occ-v2-abi/check.mjs, in CI). No Solidity source
//   is in this repository (tools/check-no-solidity.mjs).
// - `occNotaryClientAbi` and `occFeeVaultClientAbi` are what client code binds to: the `client`
//   functions of tags.ts plus every event and error (the inherited OpenZeppelin ones included) for
//   decoding. The full interface ABIs are exported for decoding and review, not for calls.
// - Addresses: Base Sepolia (84532) only, a testnet in development (05 §9). No mainnet entry exists
//   and the check refuses one.
// - The EIP-712 types (domain, Record, Receipt) are not here: they live in @4thtech-io/crypto, and
//   @4thtech-io/chain tests that they match the Notary's structs (AUDIT-FABLE-OCC19-1 L-2).
// Private, bundled into the CLI, never published (D-83).
import {
  occErrorsAbi as errorsAbi,
  occFeeVaultAbi as feeVaultAbi,
  occManagedAbi as managedAbi,
  occNotaryAbi as notaryAbi,
  openZeppelinInheritedAbi as ozAbi,
} from './generated/abi.js';
import { OCC_V2_RELEASE as RELEASE, deploymentsByChainId } from './generated/release.js';
import {
  FEE_VAULT_FUNCTION_TAGS,
  NOTARY_FUNCTION_TAGS,
  type ClientFunctionName,
  type FunctionTag,
} from './tags.js';

export const packageName = '@4thtech-io/occ-v2-abi';

export {
  FEE_VAULT_FUNCTION_TAGS,
  FUNCTION_TAGS,
  NOTARY_FUNCTION_TAGS,
  type ClientFunctionName,
  type FunctionTag,
} from './tags.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** The contracts release the ABIs and addresses were imported from. */
export const OCC_V2_RELEASE = deepFreeze(RELEASE);

/** Full interface ABIs, as exported by the release. Bind calls to the client ABIs below. */
export const occNotaryAbi = deepFreeze(notaryAbi);
export const occFeeVaultAbi = deepFreeze(feeVaultAbi);
export const occManagedAbi = deepFreeze(managedAbi);
export const occErrorsAbi = deepFreeze(errorsAbi);
/** The OpenZeppelin errors and events the deployed contracts can surface (05 §7). */
export const openZeppelinInheritedAbi = deepFreeze(ozAbi);

type AbiEntry = { readonly type: string; readonly name?: string };
type NonFunction<Abi extends readonly AbiEntry[]> = Exclude<
  Abi[number],
  { readonly type: 'function' }
>;

/** A client ABI: the client-tagged functions, plus every event and error for decoding. */
export type ClientAbi<Abi extends readonly AbiEntry[], Tags> = readonly (
  | Extract<Abi[number], { readonly type: 'function'; readonly name: ClientFunctionName<Tags> }>
  | NonFunction<Abi>
  | NonFunction<typeof ozAbi>
)[];

function clientAbi<Abi extends readonly AbiEntry[], Tags extends Record<string, FunctionTag>>(
  abi: Abi,
  tags: Tags,
): ClientAbi<Abi, Tags> {
  const items: AbiEntry[] = abi.filter(
    (item) => item.type !== 'function' || tags[item.name ?? ''] === 'client',
  );
  const seen = new Set(items.map((item) => `${item.type}:${item.name ?? ''}`));
  for (const item of ozAbi) {
    if (!seen.has(`${item.type}:${item.name}`)) items.push(item);
  }
  return deepFreeze(items) as unknown as ClientAbi<Abi, Tags>;
}

/** OCCNotary for client code: notarize, acknowledge and views; no admin or upgrade function. */
export const occNotaryClientAbi = clientAbi(occNotaryAbi, NOTARY_FUNCTION_TAGS);
/**
 * OCCFeeVault for client code: deposits, withdrawals, credits, quotes and views. No admin, module,
 * integrator or maintenance function, and no `depositWithAuthorization` until M1-3c.
 */
export const occFeeVaultClientAbi = clientAbi(occFeeVaultAbi, FEE_VAULT_FUNCTION_TAGS);

/** The per-chain deployment file (addresses/<chainId>.json). */
export type Deployment = (typeof deploymentsByChainId)[keyof typeof deploymentsByChainId];

/** Deployments keyed by chain ID: Base Sepolia (84532) only, a testnet. */
export const deployments = deepFreeze(deploymentsByChainId);

/** The chain IDs with a deployment, ascending. */
export const DEPLOYMENT_CHAIN_IDS: readonly number[] = Object.freeze(
  Object.keys(deployments)
    .map(Number)
    .sort((a, b) => a - b),
);

/** The deployment on `chainId`, or undefined when the bundle has none. */
export function getDeployment(chainId: number): Deployment | undefined {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return undefined;
  const key = String(chainId);
  return Object.hasOwn(deployments, key) ? deployments[key as keyof typeof deployments] : undefined;
}
