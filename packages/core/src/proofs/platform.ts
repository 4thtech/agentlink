// The chain side of the proof flow (07 §6.2, §6.3; M1-7g), as the runtime hands it to the core. The
// core never builds an RPC client, a submitter or a direct-mode signer itself: packages/node (and the
// Worker, M2-3a) build them from the shipped chain list and the user's RPC override, and pass them
// here. Everything is the chain package's public API; the core only orchestrates.
//
// The chain functions themselves come in `kit` too (the runtime passes `@4thtech-io/chain`'s own
// exports): the core imports only types from the chain package, so a bundle that never wires proofs
// carries no chain client code and none of its npm dependencies (apps/cli bundle-check).
import type * as Chain from '@4thtech-io/chain';
import type {
  ChainConfig,
  ChainSelector,
  ChainState,
  ProofSubmitter,
  ReadClient,
} from '@4thtech-io/chain';

/** One supported chain (07 §6.1) with what the core needs to record and read on it. */
export interface ProofChain {
  /** The shipped config: the Notary address always comes from here, never from a message. */
  readonly config: ChainConfig;
  /** Address-checked reads: `getRecord` in full, quotes and credits for the selector. */
  readonly client: ReadClient;
  /** The chain-state port (04 §5 replacement checks, inclusion). */
  readonly state: ChainState;
  /** Submitters with failover and, when configured, direct mode (`createProofSubmitter`). */
  readonly submitter: ProofSubmitter;
}

/** The chain package functions the proof flow calls: pass `@4thtech-io/chain` itself. */
export type ProofKit = Pick<
  typeof Chain,
  | 'buildRecord'
  | 'signRecord'
  | 'buildReceipt'
  | 'signReceipt'
  | 'replacementAllowed'
  | 'notaryReader'
  | 'createChainSelector'
  | 'recordKindForPayload'
  // The recipient's checks of a signed Record in a `proof` body (04 §3.4 checks 2 and 5; M1-7g-b).
  | 'computeRecordId'
  | 'verifyProofPack'
  // The local UI's credits read and the free test credits allowlist (M1-11r-a).
  | 'readCreditsAcrossChains'
  | 'isFaucetChain'
>;

/**
 * The 4thTech free test credits service's answer (05 §9, M1-10b: `POST /v1/faucet`), as the runtime
 * maps it. Only the outcome: no transaction hash, URL or server text reaches the core.
 */
export type FreeCreditsAnswer =
  | { readonly status: 'sent' }
  | {
      readonly status: 'already_claimed' | 'rate_limited' | 'daily_cap_reached';
      /** Seconds until another claim may succeed. */
      readonly retryAfter: number;
    }
  | { readonly status: 'unavailable' };

/**
 * The runtime's call to the free test credits service (M1-11r-a). It sends exactly the chain ID and
 * the agent ID, both public (the agent ID is the credits account on-chain); never a key, a URL of
 * the user's own or anything else. The core calls it only for an allowlisted testnet.
 */
export interface FreeCreditsPort {
  request(input: { readonly chainId: number; readonly agent: string }): Promise<FreeCreditsAnswer>;
}

export interface ProofsPlatform {
  /** `@4thtech-io/chain` itself: its Record builder is the only source of salts (04 §5, D-61). */
  readonly kit: ProofKit;
  /** The supported chains. Selection only ever picks a testnet in this release (07 §6.3). */
  readonly chains: readonly ProofChain[];
  /** The chain selector (07 §6.3). Default: `createChainSelector()`. */
  readonly selector?: Pick<ChainSelector, 'select' | 'clear'>;
  /** Free test credits (testnets only; M1-11r-a). Without it, `requestFaucet` is unavailable. */
  readonly faucet?: FreeCreditsPort;
}
