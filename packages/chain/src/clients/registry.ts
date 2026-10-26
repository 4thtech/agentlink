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
import { isFaucetChain } from '../fees/faucet.js';
import { loadOccV2Contracts, type OccV2Contracts } from '../occ-v2.js';
import { checkRpcUrl } from './rpc-url.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Kill switch for the gasless EIP-3009 top-up (M3-4b-t-0). The Base Sepolia vault accepts
 * `depositWithAuthorization` from v0.1.0-testnet.4, but nothing executes a top-up until M3-4b-t-4
 * (owner-approved flow through the submitter). While false, no fee token is composed `eip3009`, so
 * funding detection, `pick`, `checkGaslessTopUp` and the authorization builder all stay off. Only
 * M3-4b-t-4 flips it, in a reviewed PR; there is no runtime override.
 */
export const GASLESS_TOPUP_ENABLED = false as boolean;

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
    // EIP-3009 is offered only where the token supports it AND the deployed vault accepts it
    // (AUDIT-FABLE-OCC19-1 M-1; Base Sepolia from v0.1.0-testnet.4), AND the kill switch is on.
    const eip3009 =
      GASLESS_TOPUP_ENABLED && t.eip3009 === true && contracts.depositWithAuthorization;
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

/**
 * The registry chains that automatic selection and the default proof platform may use: in this
 * testnet release, exactly the testnets the testnet faucet serves (`isFaucetChain`, the hard-coded
 * allowlist in fees/faucet.ts). An unfunded payer is routed to the cheapest chain (07 §6.3; at an
 * equal fee, the lower chain ID), so a chain the faucet does not serve would leave them with no way
 * to get credits. Every registry chain stays available to an explicit override and to verification.
 *
 * Gnosis Chiado (10200) is in the registry; the owner accepted its routing change (M1-3j-b,
 * 2026-10-21). It joins automatic selection when it joins the faucet allowlist, a reviewed change
 * made only once its submitter gas and faucet keys exist and its smoke test has passed. Mainnets
 * (M3-2a) need their own rule here: no faucet serves them.
 */
export function autoSelectableChains(): readonly ChainConfig[] {
  return autoSelectableFrom(chainRegistry());
}

/**
 * The selection rule over any chain list: a testnet the faucet serves. Fails closed on a non-testnet
 * entry even if its ID were ever on the faucet allowlist. Internal (not re-exported); tested directly.
 */
export function autoSelectableFrom(chains: readonly ChainConfig[]): readonly ChainConfig[] {
  return chains.filter((c) => c.testnet && isFaucetChain(c.chainId));
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
 * Picks the chain for an action with no user choice (D-40, 02 F-51): the override when it names a
 * supported chain (Chiado included), otherwise the first automatically selectable chain. The
 * funded and cheapest-chain steps of 07 §6.3 live in `select/` (M1-26) and run over
 * `autoSelectableChains()`.
 */
export function selectChain(options: SelectChainOptions = {}): ChainConfig {
  if (options.chainId !== undefined) {
    const chosen = getChainConfig(options.chainId);
    if (!chosen) fail('unsupported_chain', 'that chain is not supported by this release');
    return chosen;
  }
  const first = autoSelectableChains()[0];
  if (!first) fail('unsupported_chain', 'this release supports no chain');
  return first;
}
