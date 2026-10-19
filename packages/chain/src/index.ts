// @4thtech-io/chain: chain clients and OCC v2 bindings. M1-4a: registry, read clients, typed-data
// builders and IDs. M1-4b: quotes in USD, credits, the deposit helper and credit events. Submission
// lands with M1-4c.
export const packageName = '@4thtech-io/chain';

export * from './config/index.js';
export { loadOccV2Contracts, type OccV2Contracts } from './occ-v2.js';
export * from './clients/index.js';
export * from './typed-data/index.js';
export * from './fees/index.js';
export * from './submitter/index.js';
// The salt generator stays internal: only buildRecord draws salts (04 §5, D-61).
export {
  ChainInputError,
  computeRecordId,
  isEvmAddress,
  randomNonce,
  type Hex,
} from './ids/index.js';

/**
 * The OCC v2 contracts release this package binds to (M1-3f, D-83): exactly one imported
 * `@4thtech-io/occ-v2-abi` release, by tag and manifest SHA-256. A new import changes it here, in the
 * same reviewed PR as the ABI diff; src/occ-v2-abi.test.ts fails while the two differ. Renovate
 * never updates it (the package is in-repo and never published).
 */
export const OCC_V2_ABI_PIN = Object.freeze({
  tag: 'v0.1.0-testnet.2',
  manifestSha256: 'b1a8daa57d51bcbfbecbc91e6c5d2740d76428a4f63bbd5f1043537591188c1b',
} as const);
