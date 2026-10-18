// The OCC v2 contracts of one chain, loaded from the pinned @4thtech-io/occ-v2-abi release (M1-3f,
// D-83; 07 §6.1). Every address goes through viem's getAddress (EIP-55) at load, and the load fails
// closed if the release's spelling is not the valid checksum form, so a corrupted or hand-edited
// address cannot reach a client. The registry (M1-4a) builds its ChainConfig on this.
import { getDeployment, type Address } from '@4thtech-io/occ-v2-abi';
import { getAddress } from 'viem';

/** The OCC v2 contracts and fee tokens on one chain, EIP-55 checksummed. */
export interface OccV2Contracts {
  readonly chainId: number;
  readonly notary: Address;
  readonly feeVault: Address;
  readonly accessManager: Address;
  readonly feeTokens: readonly {
    readonly address: Address;
    readonly decimals: number;
    readonly eip3009: boolean;
    readonly native: boolean;
    readonly symbol: string;
  }[];
  /** False until the vault accepts EIP-3009 deposits (M1-3c); clients use deposit/depositFor. */
  readonly depositWithAuthorization: boolean;
  readonly testnet: boolean;
}

function checksummed(value: string): Address {
  const out = getAddress(value);
  if (out !== value) throw new Error('occ-v2: a release address is not in EIP-55 checksum form');
  return out;
}

/** The contracts on `chainId`, or undefined when the pinned release has no deployment there. */
export function loadOccV2Contracts(chainId: number): OccV2Contracts | undefined {
  const deployment = getDeployment(chainId);
  if (!deployment) return undefined;
  return Object.freeze({
    chainId: deployment.chainId,
    notary: checksummed(deployment.contracts.OCCNotary),
    feeVault: checksummed(deployment.contracts.OCCFeeVault),
    accessManager: checksummed(deployment.contracts.AccessManager),
    feeTokens: Object.freeze(
      deployment.feeTokens.map(({ address, decimals, eip3009, native, symbol }) =>
        Object.freeze({ address: checksummed(address), decimals, eip3009, native, symbol }),
      ),
    ),
    depositWithAuthorization: deployment.capabilities.depositWithAuthorization,
    testnet: deployment.testnet,
  });
}
