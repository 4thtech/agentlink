// Which chain pays for one action (07 §6.3 step 2, D-40, 02 F-51): the default chain if funded,
// otherwise the cheapest funded chain, otherwise `needs_credits` with a top-up routed to the
// cheapest supported chain. Pure: it works on a detection (detect.ts) and makes no request.
//
// Results carry codes and numbers only, never text: the tool layer turns them into 11 §5 copy
// (no chain, network fee or account words in the default UI) and builds the top-up link.
import { ChainConfigError, type ChainConfig, type FeeTokenSymbol } from '../config/index.js';
import type { Hex } from '../ids/index.js';
import type { FeeQuote } from '../fees/index.js';

/** How a funded chain pays: existing credits, or a gasless top-up from a stablecoin balance (F-46). */
export type PayFrom = 'credits' | 'top_up';

/** One fee token on one chain, as detected for one action. */
export interface FundingOption {
  /** The contract's quote for this action in this token. */
  readonly quote: FeeQuote;
  /** `creditsOf(payer, token)`, base units. */
  readonly credits: bigint;
  /**
   * The payer's balance of the token, base units; `null` where no gasless top-up exists for it
   * (the token or the deployed vault lacks EIP-3009), so the balance cannot become credits.
   */
  readonly topUpBalance: bigint | null;
}

/** One chain that answered in time. */
export interface ChainFunding {
  readonly config: ChainConfig;
  readonly options: readonly FundingOption[];
}

/** What detection found for one payer and one action. */
export interface FundingDetection {
  /** Lowercase. */
  readonly payer: Hex;
  readonly chains: readonly ChainFunding[];
  /** Chain IDs that failed or did not answer in time: skipped for this attempt, never picked. */
  readonly unavailable: readonly number[];
}

export interface PickOptions {
  /** Policy `proofs.defaultChain` (06 §3): a chain key. An unknown key is ignored. */
  readonly defaultChain?: string;
  /** The Advanced or tool `chain?` override (06 §2.4); never asked of the user. */
  readonly chainId?: number;
}

/** Where to add credits (06 §2.1 `topUpUrl`, 02 F-46): the tool layer builds the link from it. */
export interface TopUpRoute {
  readonly chainId: number;
  readonly chain: string;
  readonly token: FeeTokenSymbol;
  /** The fee for this action in USD (the minimum that makes the chain funded). */
  readonly usd: string;
  /** The payer's address, lowercase. */
  readonly agentAddress: Hex;
}

export type ChainSelection =
  | {
      readonly status: 'ok';
      readonly chainId: number;
      readonly chain: string;
      readonly token: FeeTokenSymbol;
      readonly payFrom: PayFrom;
      readonly quote: FeeQuote;
      readonly reason: 'override' | 'default' | 'cheapest';
      readonly unavailable: readonly number[];
    }
  | {
      readonly status: 'needs_credits';
      readonly topUp: TopUpRoute;
      readonly unavailable: readonly number[];
    }
  | { readonly status: 'unavailable'; readonly unavailable: readonly number[] };

/**
 * Chain IDs of public mainnets. Launch is testnet only (mainnets arrive with M3-2a): a config with
 * one of these IDs is never queried, picked or offered for a top-up, even when flagged a testnet.
 */
export const KNOWN_MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, 10, 56, 100, 130, 137, 324, 480, 1101, 5000, 8453, 34443, 42161, 42220, 43114, 59144, 81457,
  534352, 7777777,
]);

/** True when the chain may be queried and picked in this release: a testnet, not a mainnet ID. */
export function isSelectableChain(config: ChainConfig): boolean {
  return config.testnet === true && !KNOWN_MAINNET_CHAIN_IDS.has(config.chainId);
}

const USD = /^(\d{1,30})(?:\.(\d{1,6}))?$/;

/** The USD string of a quote (rounded up to the micro-dollar) in micro-dollars; null if malformed. */
function micros(usd: string): bigint | null {
  const m = USD.exec(usd);
  if (!m) return null;
  return BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

interface Ranked {
  readonly config: ChainConfig;
  readonly option: FundingOption;
  readonly cost: bigint;
  readonly tokenIndex: number;
  readonly payFrom: PayFrom | null;
}

const KIND_RANK = { credits: 0, top_up: 1, none: 2 } as const;

function payFromOf(config: ChainConfig, option: FundingOption): PayFrom | null {
  const { total, token } = option.quote;
  if (option.credits >= total) return 'credits';
  const fee = config.feeTokens.find((t) => t.symbol === token);
  if (fee?.eip3009 === true && option.topUpBalance !== null) {
    if (option.credits + option.topUpBalance >= total) return 'top_up';
  }
  return null;
}

/** Cheaper first, then credits before a top-up, then the lower chain ID, then config token order. */
function compare(a: Ranked, b: Ranked): number {
  if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1;
  const ka = KIND_RANK[a.payFrom ?? 'none'];
  const kb = KIND_RANK[b.payFrom ?? 'none'];
  if (ka !== kb) return ka - kb;
  if (a.config.chainId !== b.config.chainId) return a.config.chainId - b.config.chainId;
  return a.tokenIndex - b.tokenIndex;
}

function rank(chain: ChainFunding): Ranked[] {
  const out: Ranked[] = [];
  chain.options.forEach((option, i) => {
    const cost = micros(option.quote.usd);
    if (cost === null || option.quote.chainId !== chain.config.chainId) return;
    out.push({
      config: chain.config,
      option,
      cost,
      tokenIndex: i,
      payFrom: payFromOf(chain.config, option),
    });
  });
  return out.sort(compare);
}

function best(ranked: readonly Ranked[], fundedOnly: boolean): Ranked | undefined {
  return ranked.filter((r) => !fundedOnly || r.payFrom !== null).sort(compare)[0];
}

/**
 * Picks the chain for one paid action (07 §6.3). Throws `ChainConfigError('unsupported_chain')`
 * only for an override naming a chain this release does not offer (a mainnet included).
 */
export function pickChain(detection: FundingDetection, options: PickOptions = {}): ChainSelection {
  const unavailable = Object.freeze([...new Set(detection.unavailable)].sort((a, b) => a - b));
  const chains = detection.chains.filter((c) => isSelectableChain(c.config));
  const ok = (r: Ranked, reason: 'override' | 'default' | 'cheapest'): ChainSelection =>
    Object.freeze({
      status: 'ok' as const,
      chainId: r.config.chainId,
      chain: r.config.key,
      token: r.option.quote.token,
      payFrom: r.payFrom as PayFrom,
      quote: r.option.quote,
      reason,
      unavailable,
    });
  const needsCredits = (r: Ranked): ChainSelection =>
    Object.freeze({
      status: 'needs_credits' as const,
      topUp: Object.freeze({
        chainId: r.config.chainId,
        chain: r.config.key,
        token: r.option.quote.token,
        usd: r.option.quote.usd,
        agentAddress: detection.payer,
      }),
      unavailable,
    });
  const none: ChainSelection = Object.freeze({ status: 'unavailable' as const, unavailable });

  if (options.chainId !== undefined) {
    const forced = chains.find((c) => c.config.chainId === options.chainId);
    if (forced === undefined) {
      if (unavailable.includes(options.chainId)) return none;
      throw new ChainConfigError(
        'unsupported_chain',
        'that chain is not supported by this release',
      );
    }
    const ranked = rank(forced);
    const funded = best(ranked, true);
    if (funded) return ok(funded, 'override');
    const cheapest = best(ranked, false);
    return cheapest ? needsCredits(cheapest) : none;
  }

  const all = chains.flatMap(rank);
  if (options.defaultChain !== undefined) {
    const funded = best(
      all.filter((r) => r.config.key === options.defaultChain),
      true,
    );
    if (funded) return ok(funded, 'default');
  }
  const funded = best(all, true);
  if (funded) return ok(funded, 'cheapest');
  const cheapest = best(all, false);
  return cheapest ? needsCredits(cheapest) : none;
}
