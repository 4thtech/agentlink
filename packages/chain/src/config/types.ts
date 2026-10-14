// Chain configuration types (07 §6.1; 03 §7; D-40, D-46).

/** A `0x`-prefixed EVM address. Config addresses are lowercase (04 §2.5.1 canonical form). */
export type Address = `0x${string}`;

/** Fee-token symbols at launch: USD stablecoins only (D-46, 12 §3.1). `NATIVE` is xDAI on Gnosis. */
export type FeeTokenSymbol = 'NATIVE' | 'USDC' | 'USDT';

/** Where an entry comes from and when it was last checked (M1-14: every entry cites both). */
export type ConfigSource = {
  /** The issuer's or chain's official page. */
  url: string;
  /** `YYYY-MM-DD`. */
  verifiedOn: string;
};

/** One allowlisted fee token (07 §6.1 `feeTokens[]`, with its source). */
export type FeeToken = {
  symbol: FeeTokenSymbol;
  /** `null` for the native coin (`address(0)` in the vault). */
  address: Address | null;
  decimals: number;
  /** True only where `receiveWithAuthorization` was proven on a fork for this exact token (12 §3.2). */
  eip3009?: boolean;
  source: ConfigSource;
};

/** The deployed OCC v2 contracts. Identical on every chain via CREATE3 (05 §9). */
export type ChainContracts = { vault: Address; notary: Address; registry?: Address };

/** A supported chain (07 §6.1). Ships with each client release and is never fetched at runtime (D-40). */
export type ChainConfig = {
  key: 'base' | 'gnosis' | 'arbitrum' | 'optimism' | 'polygon' | (string & {});
  chainId: number;
  /** Several public, keyless RPC URLs; the user may add their own (fallback transport). */
  rpcUrls: string[];
  contracts: ChainContracts;
  feeTokens: FeeToken[];
  explorer: string;
  /**
   * Blocks after inclusion before the client shows a proof as included. Where `finalizedTag` is
   * true, 04 §5 reads chain state at the `finalized` block and this is only the display threshold;
   * on a chain without the tag it is also the 04 §5 fallback depth. Not a reorg-safety bound.
   */
  confirmations: number;
  /** The chain answers `eth_getBlockByNumber("finalized")` (proven by verify-chain), so the client never probes. */
  finalizedTag: boolean;
  testnet: boolean;
  /** Official page for the chain ID, RPC and explorer entries. */
  source: ConfigSource;
};

/**
 * A chain's shipped network and fee-token entry (M1-14). The registry (M1-4a) composes the full
 * `ChainConfig` from it plus `contracts` from the pinned `@agentlink/occ-v2-abi` (07 §6.1).
 */
export type ChainNetwork = Omit<ChainConfig, 'contracts'>;
