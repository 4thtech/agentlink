// Every function of the exported Notary and vault interfaces, tagged by who may call it (05 §2, §3,
// §5; AUDIT-FABLE-OCC19-1 L-1). The interfaces are the spec surface, so they include governance,
// upgrade and module-only functions; all are gated on chain (05 §5), and these tags keep them out of
// the client ABIs so tool code cannot pick one up by accident. `satisfies` makes a function that a
// new release adds, renames or drops a type error until it is tagged here, in the import PR.
import type { occFeeVaultAbi, occNotaryAbi } from './generated/abi.js';

/**
 * - `client`: what the AgentLink client calls (user functions and views, 05 §5 "user functions").
 * - `integrator`: an app integrator's own functions (05 §2.3); not used by the client today.
 * - `maintenance`: permissionless upkeep (`sweep`, 05 §2.5); the client never needs it.
 * - `admin`: AccessManager-gated governance (05 §5).
 * - `upgrade`: UUPS upgrade and its freeze (05 §5.3).
 * - `module`: callable only by a registered vault module (the Notary), never by a user.
 * - `relay`: sent only by the AgentLink submitter on an agent's behalf (`depositWithAuthorization`,
 *   the gasless EIP-3009 top-up, 05 §2.5; 07 §7). Exported in the relay ABI, never in the client
 *   ABI: an agent signs the authorization and never sends this call itself (D-89). A chain offers it
 *   only where its deployment's `capabilities.depositWithAuthorization` is true (v0.1.0-testnet.4:
 *   Base Sepolia only).
 */
export type FunctionTag =
  'client' | 'integrator' | 'maintenance' | 'admin' | 'upgrade' | 'module' | 'relay';

type FunctionName<Abi extends readonly { readonly type: string; readonly name?: string }[]> =
  Extract<Abi[number], { readonly type: 'function' }>['name'];

/** OCCNotary (IOCCNotary). */
export const NOTARY_FUNCTION_TAGS = Object.freeze({
  acknowledge: 'client',
  acknowledgeBatch: 'client',
  computeRecordId: 'client',
  getRecord: 'client',
  notarize: 'client',
  notarizeBatch: 'client',
  notarizeDirect: 'client',
  paused: 'client',
  upgradesFrozen: 'client',
  vault: 'client',
  pause: 'admin',
  unpause: 'admin',
  freezeUpgrades: 'upgrade',
  upgradeToAndCall: 'upgrade',
} as const satisfies Record<FunctionName<typeof occNotaryAbi>, FunctionTag>);

/** OCCFeeVault (IOCCFeeVault). */
export const FEE_VAULT_FUNCTION_TAGS = Object.freeze({
  creditsOf: 'client',
  deposit: 'client',
  depositFor: 'client',
  feeTokenAllowed: 'client',
  getApp: 'client',
  integratorAccrued: 'client',
  integratorFee: 'client',
  integratorFeeCapMultiple: 'client',
  isModule: 'client',
  maxProtocolFee: 'client',
  minDeposit: 'client',
  paused: 'client',
  protocolAccrued: 'client',
  protocolFee: 'client',
  quote: 'client',
  treasury: 'client',
  withdraw: 'client',
  depositWithAuthorization: 'relay',
  registerApp: 'integrator',
  setIntegrator: 'integrator',
  setIntegratorFee: 'integrator',
  withdrawIntegrator: 'integrator',
  sweep: 'maintenance',
  charge: 'module',
  depositFromModule: 'module',
  lowerMaxProtocolFee: 'admin',
  pause: 'admin',
  raiseMaxProtocolFee: 'admin',
  registerModule: 'admin',
  removeModule: 'admin',
  setAppActive: 'admin',
  setFeeTokenAllowed: 'admin',
  setIntegratorFeeCapMultiple: 'admin',
  setMinDeposit: 'admin',
  setProtocolFee: 'admin',
  setTreasury: 'admin',
  unpause: 'admin',
  upgradeToAndCall: 'upgrade',
} as const satisfies Record<FunctionName<typeof occFeeVaultAbi>, FunctionTag>);

/** The tags per contract. */
export const FUNCTION_TAGS = Object.freeze({
  OCCNotary: NOTARY_FUNCTION_TAGS,
  OCCFeeVault: FEE_VAULT_FUNCTION_TAGS,
});

/** The names a tag table marks `client`. */
export type ClientFunctionName<Tags> = {
  [Name in keyof Tags]: Tags[Name] extends 'client' ? Name : never;
}[keyof Tags];

/** The names a tag table marks `relay`. */
export type RelayFunctionName<Tags> = {
  [Name in keyof Tags]: Tags[Name] extends 'relay' ? Name : never;
}[keyof Tags];
