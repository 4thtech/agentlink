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
  DepositAuthErrorCode,
  DepositAuthorizationRequest,
  DirectKeys,
  DirectMode,
  PollOptions,
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
  /**
   * M1-11c-a4c: the agent's own direct mode on this chain over its KeyStore (the runtime passes
   * `(keys) => createDirectMode(config, keys, {fetchFn})`, testnets only). Asked only after an
   * owner-signed `credits.deposit` or `credits.withdraw` passed its checks; absent: no top-up here.
   */
  readonly directMode?: (keys: DirectKeys) => Promise<DirectMode>;
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
  // The gasless top-up (M3-4b-t-T4-a; 12 §4.1, 07 §7): the eip3009 gate (the client-side kill switch),
  // the $5 to $50 bounds and the agent-key authorization builder.
  | 'gaslessToken'
  | 'gaslessValueBounds'
  | 'buildReceiveWithAuthorization'
  | 'readClientEthCall'
  // Add credits on Chiado and withdraw credits, in direct mode (M1-11c-a4c).
  | 'offeredTokens'
  | 'tokenUnitsToUsd'
  | 'buildDeposit'
  | 'sendDeposit'
  | 'sendWithdraw'
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

/**
 * A submitter's answer to `POST /v1/deposit-authorization` (07 §7; M3-4b-t-T4-a), as the runtime
 * maps it (T4-b). Only the outcome: no transaction hash, URL or server text reaches the core. The
 * answer is untrusted: the core confirms the credit by reading `creditsOf` on chain.
 */
export type DepositAuthAnswer =
  | { readonly status: 'submitted' | 'already_used' | 'unavailable' }
  | {
      readonly status: 'rate_limited';
      /** Seconds until another try may succeed (from Retry-After, bounded by the runtime). */
      readonly retryAfter?: number;
    }
  | {
      readonly status: 'refused';
      /** A fixed submitter code, or `bad_request` for a malformed request or an unknown code. */
      readonly code: DepositAuthErrorCode | 'bad_request';
    };

/**
 * The runtime's call to the shipped submitters' deposit-authorization route (M3-4b-t-T4-a). It sends
 * exactly the signed, vault-payee authorization the core built; never a key or a URL of the user's.
 */
export interface DepositAuthPort {
  submit(request: DepositAuthorizationRequest): Promise<DepositAuthAnswer>;
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
  /**
   * The gasless top-up route (M3-4b-t-T4-a). Without it, an owner-approved gasless top-up is
   * refused `not_available` before anything is signed.
   */
  readonly depositAuth?: DepositAuthPort;
  /**
   * Waits `ms` milliseconds; the fixed delay before a receipt's one retry after `RecordNotFound`
   * (M1-34-c). Default: a timer.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * How a top-up or withdrawal waits for inclusion (M1-11c-a4c). Default: every 2 s for 20 s, then
   * `pending`, so it answers within one local UI request.
   */
  readonly directPoll?: PollOptions;
}
