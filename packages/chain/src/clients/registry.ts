// The supported-chain registry and automatic chain selection (07 §6.1, §6.3; 03 §7; D-40).
//
// A `ChainConfig` is composed from the shipped network entry (M1-14) and the contracts of the
// pinned `@4thtech-io/occ-v2-abi` release (M1-3f), and only for chains that have both. Both ship
// with the client release; nothing is fetched at runtime, so no server can redirect a payment.
// The composition fails closed when the two disagree on the chain or on the fee tokens.
import {
  ChainConfigError,
  TESTNET_NETWORKS,
  validateChainNetwork,
  type Address,
  type ChainConfig,
  type ChainNetwork,
  type FeeToken,
} from '../config/index.js';
import { loadOccV2Contracts, type OccV2Contracts } from '../occ-v2.js';
import { checkRpcUrl } from './rpc-url.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function fail(code: string, message: string): never {
  throw new ChainConfigError(code, message);
}

/** Lowercase form; config addresses are lowercase (04 §2.5.1). */
const lower = (a: string): Address => a.toLowerCase() as Address;

function composeTokens(network: ChainNetwork, contracts: OccV2Contracts): FeeToken[] {
  const chain = String(network.chainId);
  if (network.feeTokens.length !== contracts.feeTokens.length) {
    fail(
      'fee_token_mismatch',
      `chain ${chain}: the release and the entry list different fee tokens`,
    );
  }
  return network.feeTokens.map((t) => {
    const want = t.address === null ? ZERO_ADDRESS : t.address;
    const match = contracts.feeTokens.find(
      (d) => lower(d.address) === want && d.native === (t.address === null),
    );
    if (match?.decimals !== t.decimals) {
      fail(
        'fee_token_mismatch',
        `chain ${chain}: ${t.symbol} differs between the release and the entry`,
      );
    }
    // EIP-3009 is offered only where the token supports it AND the deployed vault accepts it; the
    // vault refuses depositWithAuthorization until M1-3c (AUDIT-FABLE-OCC19-1 M-1).
    const eip3009 = t.eip3009 === true && contracts.depositWithAuthorization;
    return Object.freeze({
      ...t,
      eip3009,
      source: Object.freeze({ ...t.source }),
    });
  });
}

/** Composes and checks one chain's config. Exported for tests; callers use the registry. */
export function composeChainConfig(network: ChainNetwork, contracts: OccV2Contracts): ChainConfig {
  validateChainNetwork(network);
  const chain = String(network.chainId);
  if (contracts.chainId !== network.chainId) {
    fail('chain_mismatch', `chain ${chain}: the release deployment is for another chain`);
  }
  if (!contracts.testnet) fail('not_testnet', `chain ${chain}: launch testnets only`);
  for (const url of network.rpcUrls) {
    if (!checkRpcUrl(url).ok)
      fail('bad_rpc_url', `chain ${chain}: a shipped RPC URL breaks the 04 §4 rule`);
  }
  const feeTokens = composeTokens(network, contracts);
  return Object.freeze({
    key: network.key,
    chainId: network.chainId,
    rpcUrls: Object.freeze([...network.rpcUrls]) as string[],
    contracts: Object.freeze({ vault: lower(contracts.feeVault), notary: lower(contracts.notary) }),
    feeTokens: Object.freeze(feeTokens) as FeeToken[],
    explorer: network.explorer,
    confirmations: network.confirmations,
    finalizedTag: network.finalizedTag,
    testnet: true,
    source: Object.freeze({ ...network.source }),
  });
}

let registry: readonly ChainConfig[] | undefined;

/**
 * The supported chains: every shipped network entry that has a deployment in the pinned release,
 * in deployment order. Testnets only in this release (mainnets arrive with M3-2a).
 */
export function chainRegistry(): readonly ChainConfig[] {
  registry ??= Object.freeze(
    TESTNET_NETWORKS.flatMap((network) => {
      const contracts = loadOccV2Contracts(network.chainId);
      return contracts ? [composeChainConfig(network, contracts)] : [];
    }),
  );
  return registry;
}

/** The config for `chainId`, or undefined when this release does not support it. */
export function getChainConfig(chainId: number): ChainConfig | undefined {
  return chainRegistry().find((c) => c.chainId === chainId);
}

/** Options for `selectChain`. */
export interface SelectChainOptions {
  /** An Advanced-settings or tool `chain?` override (06 §2.4); never asked of the user. */
  readonly chainId?: number;
}

/**
 * Picks the chain for an action with no user choice (D-40, 02 F-51). Today: the override when it
 * names a supported chain, otherwise the first supported chain. The funded and cheapest-chain
 * steps of 07 §6.3 need credits and quotes and land with M1-26.
 */
export function selectChain(options: SelectChainOptions = {}): ChainConfig {
  if (options.chainId !== undefined) {
    const chosen = getChainConfig(options.chainId);
    if (!chosen) fail('unsupported_chain', 'that chain is not supported by this release');
    return chosen;
  }
  const first = chainRegistry()[0];
  if (!first) fail('unsupported_chain', 'this release supports no chain');
  return first;
}
