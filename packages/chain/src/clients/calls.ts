// OCC v2 calls, bound to the client-safe ABIs only (05 §5; M1-3f; AUDIT-FABLE-OCC19-1 L-1).
//
// `occNotaryClientAbi` and `occFeeVaultClientAbi` hold the functions tagged `client` and every
// event and error. Admin, upgrade, module, integrator, maintenance and pending functions
// (`depositWithAuthorization`, which only the relay ABI carries) are absent, so this package can neither type nor encode
// them: the call fails before any request. The full interface ABIs are for decoding and review and
// are never bound to a call here.
import { occFeeVaultClientAbi, occNotaryClientAbi } from '@4thtech-io/occ-v2-abi';
import {
  encodeFunctionData,
  getContract,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Chain,
  type GetContractReturnType,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import type { ChainConfig } from '../config/index.js';
import type { ReadClient } from './read-client.js';

/** The Notary ABI this package binds: client functions, events and errors. */
export const NOTARY_CLIENT_ABI = occNotaryClientAbi;
/** The fee vault ABI this package binds: client functions, events and errors. */
export const FEE_VAULT_CLIENT_ABI = occFeeVaultClientAbi;

type NotaryAbi = typeof NOTARY_CLIENT_ABI;
type FeeVaultAbi = typeof FEE_VAULT_CLIENT_ABI;

/** A Notary call by name and arguments; only client functions type-check. */
export type NotaryCall<
  Name extends ContractFunctionName<NotaryAbi> = ContractFunctionName<NotaryAbi>,
> = {
  readonly functionName: Name;
  readonly args?: ContractFunctionArgs<NotaryAbi, 'pure' | 'view' | 'nonpayable' | 'payable', Name>;
};

/** A fee vault call by name and arguments; only client functions type-check. */
export type FeeVaultCall<
  Name extends ContractFunctionName<FeeVaultAbi> = ContractFunctionName<FeeVaultAbi>,
> = {
  readonly functionName: Name;
  readonly args?: ContractFunctionArgs<
    FeeVaultAbi,
    'pure' | 'view' | 'nonpayable' | 'payable',
    Name
  >;
};

/** Calldata for a client Notary function. Anything else throws before any request. */
export function encodeNotaryCall<Name extends ContractFunctionName<NotaryAbi>>(
  call: NotaryCall<Name>,
): Hex {
  return encodeFunctionData({
    abi: NOTARY_CLIENT_ABI,
    functionName: call.functionName,
    args: call.args,
  } as Parameters<typeof encodeFunctionData>[0]);
}

/** Calldata for a client fee vault function. Anything else throws before any request. */
export function encodeFeeVaultCall<Name extends ContractFunctionName<FeeVaultAbi>>(
  call: FeeVaultCall<Name>,
): Hex {
  return encodeFunctionData({
    abi: FEE_VAULT_CLIENT_ABI,
    functionName: call.functionName,
    args: call.args,
  } as Parameters<typeof encodeFunctionData>[0]);
}

/** Read-only Notary bindings. */
export type NotaryReader = GetContractReturnType<NotaryAbi, { public: ViemReadClient }>;
/** Read-only fee vault bindings. */
export type FeeVaultReader = GetContractReturnType<FeeVaultAbi, { public: ViemReadClient }>;

/** viem's own type for the client; ReadClient only hides the send methods it refuses anyway. */
type ViemReadClient = PublicClient<Transport, Chain>;

/** Read-only Notary bindings at the configured address (no `write`: the client holds no key). */
export function notaryReader(client: ReadClient, config: ChainConfig): NotaryReader {
  return getContract({
    address: config.contracts.notary as Address,
    abi: NOTARY_CLIENT_ABI,
    client: { public: client as ViemReadClient },
  });
}

/** Read-only fee vault bindings at the configured address. */
export function feeVaultReader(client: ReadClient, config: ChainConfig): FeeVaultReader {
  return getContract({
    address: config.contracts.vault as Address,
    abi: FEE_VAULT_CLIENT_ABI,
    client: { public: client as ViemReadClient },
  });
}
