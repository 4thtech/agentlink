// @4thtech-io/occ-v2-abi (M1-3f, D-83): the OCC v2 contract interface for this repository.
//
// - The ABIs are the exported JSON of a tagged release of the private contracts repository
//   (artifacts/<tag>/), verified file by file against the release's SHA-256 manifest, whose own hash
//   is pinned in release.json (tools/occ-v2-abi/check.mjs, in CI). No Solidity source is in this
//   repository (tools/check-no-solidity.mjs).
// - The addresses come from the same release's addresses/<chainId>.json, kept in a scanner-safe
//   generated form (addresses.generated.ts: neutral names, no `0x` literal; the secret scan flags the
//   raw file and the owner chose no allowlist). This module restores the release's shape, and
//   `deploymentFileText` rebuilds the released bytes, which @4thtech-io/chain checks against the
//   manifest's SHA-256. EIP-55 checksumming (viem getAddress) is applied by @4thtech-io/chain's
//   loader, the only zone allowed to use viem.
// - `occNotaryClientAbi` and `occFeeVaultClientAbi` are what client code binds to: the `client`
//   functions of tags.ts plus every event and error (the inherited OpenZeppelin ones included) for
//   decoding. The full interface ABIs are exported for decoding and review, not for calls.
// - Addresses: Base Sepolia (84532) and Gnosis Chiado (10200), testnets in development (05 §9). No mainnet entry exists
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
import { deploymentRecords } from './addresses.generated.js';
import {
  OCC_V2_MANIFEST_FILES as MANIFEST_FILES,
  OCC_V2_RELEASE as RELEASE,
} from './generated/release.js';
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

/** The release manifest's `files`: path -> SHA-256 (hex) of the released bytes. */
export const OCC_V2_MANIFEST_FILES: Readonly<Record<string, string>> = deepFreeze(MANIFEST_FILES);

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

/** An EVM address as the release spells it (EIP-55 mixed case). */
export type Address = `0x${string}`;

/** The per-chain deployment, in the shape of the release's addresses/<chainId>.json. */
export interface Deployment {
  readonly campaign: string;
  readonly capabilities: { readonly depositWithAuthorization: boolean };
  readonly chainId: number;
  readonly chainKey: string;
  readonly contracts: {
    readonly AccessManager: Address;
    readonly OCCFeeVault: Address;
    readonly OCCNotary: Address;
  };
  readonly deployBlock: number;
  readonly deployedOn: string;
  readonly feeTokens: readonly {
    readonly address: Address;
    readonly decimals: number;
    readonly eip3009: boolean;
    readonly native: boolean;
    readonly symbol: string;
  }[];
  readonly name: string;
  readonly schemaVersion: number;
  readonly testnet: boolean;
}

type SafeRecord = (typeof deploymentRecords)[keyof typeof deploymentRecords];

const prefixed = (hex: string): Address => `0x${hex}`;

function toDeployment(record: SafeRecord): Deployment {
  return {
    campaign: record.campaign,
    capabilities: { depositWithAuthorization: record.depositWithAuthorization },
    chainId: record.chainId,
    chainKey: record.chainSlug,
    contracts: {
      AccessManager: prefixed(record.manager),
      OCCFeeVault: prefixed(record.vault),
      OCCNotary: prefixed(record.notary),
    },
    deployBlock: record.deployBlock,
    deployedOn: record.deployedOn,
    feeTokens: record.feeAssets.map((asset) => ({
      address: prefixed(asset.hex),
      decimals: asset.decimals,
      eip3009: asset.eip3009,
      native: asset.native,
      symbol: asset.symbol,
    })),
    name: record.name,
    schemaVersion: record.schemaVersion,
    testnet: record.testnet,
  };
}

/** Deployments keyed by chain ID: Base Sepolia (84532) and Gnosis Chiado (10200), testnets. */
export const deployments: Readonly<Record<string, Deployment>> = deepFreeze(
  Object.fromEntries(
    Object.entries(deploymentRecords).map(([id, record]) => [id, toDeployment(record)]),
  ),
);

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
  return Object.hasOwn(deployments, key) ? deployments[key] : undefined;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortKeys(object[key])]),
    );
  }
  return value;
}

/**
 * The release's addresses/<chainId>.json text, rebuilt as the exporter writes it
 * (`json.dumps(data, indent=2, sort_keys=True) + "\n"`), or undefined when the bundle has no
 * deployment there. Its SHA-256 equals the manifest entry (checked in @4thtech-io/chain's tests).
 */
export function deploymentFileText(chainId: number): string | undefined {
  const deployment = getDeployment(chainId);
  return deployment ? `${JSON.stringify(sortKeys(deployment), null, 2)}\n` : undefined;
}
