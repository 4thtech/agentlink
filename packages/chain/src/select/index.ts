// Zero-config chain selection (07 §6.3, D-40, 02 F-51; M1-26): detect credits and top-up balances
// on every supported chain, then pick the default chain if funded, otherwise the cheapest funded
// chain, otherwise `needs_credits` routed to the cheapest chain. The user never chooses a chain;
// the `chainId` override exists for Advanced settings and the tools' `chain?` input only.
import type { ChainReader } from '../fees/index.js';
import { canonicalAddress, ChainInputError, type Hex } from '../ids/index.js';
import { checkDetectOptions, detectFunding, type DetectOptions } from './detect.js';
import { pickChain, type ChainSelection, type FundingDetection, type PickOptions } from './pick.js';

export {
  DEFAULT_DETECT_BUDGET_MS,
  MAX_DETECT_BUDGET_MS,
  detectFunding,
  type DetectOptions,
} from './detect.js';
export {
  KNOWN_MAINNET_CHAIN_IDS,
  isSelectableChain,
  pickChain,
  type ChainFunding,
  type ChainSelection,
  type FundingDetection,
  type FundingOption,
  type PayFrom,
  type PickOptions,
  type TopUpRoute,
} from './pick.js';

/** How long a detection is reused by default (07 §6.3: "a short cache (e.g. 60 s)"). */
export const DEFAULT_DETECT_CACHE_MS = 60_000;
const MAX_DETECT_CACHE_MS = 300_000;
const MAX_CACHE_ENTRIES = 32;

export type SelectOptions = DetectOptions & PickOptions;

/** Detects, then picks the chain for one paid action (07 §6.3). */
export async function selectPayingChain(
  chains: readonly ChainReader[],
  payer: Hex,
  options: SelectOptions,
): Promise<ChainSelection> {
  return pickChain(await detectFunding(chains, payer, options), options);
}

export interface ChainSelectorOptions {
  /** Cache time in ms, 0 to 300 000; default 60 000. 0 turns the cache off. */
  readonly ttlMs?: number;
  /** Clock, for tests. */
  readonly now?: () => number;
}

export interface ChainSelector {
  select(
    chains: readonly ChainReader[],
    payer: Hex,
    options: SelectOptions,
  ): Promise<ChainSelection>;
  /** Drops every cached detection (for example after credits changed). */
  clear(): void;
}

/**
 * A selector that reuses a detection for a short time per payer, action and chain set. A
 * detection with an unavailable chain is not reused, so the next attempt asks that chain again.
 */
export function createChainSelector(options: ChainSelectorOptions = {}): ChainSelector {
  const ttl = options.ttlMs ?? DEFAULT_DETECT_CACHE_MS;
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_DETECT_CACHE_MS) {
    throw new ChainInputError('invalid_ttl', 'ttlMs: an integer from 0 to 300000');
  }
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; detection: FundingDetection }>();
  return Object.freeze({
    async select(chains: readonly ChainReader[], payer: Hex, opts: SelectOptions) {
      const who = canonicalAddress(payer, 'payer');
      checkDetectOptions(opts);
      const ids = chains.map((c) => c.config.chainId).sort((a, b) => a - b);
      const key = [who, opts.feeType, (opts.appId ?? '').toLowerCase(), ids.join(',')].join('|');
      const hit = cache.get(key);
      if (hit && now() - hit.at <= ttl) return pickChain(hit.detection, opts);
      cache.delete(key);
      const detection = await detectFunding(chains, who, opts);
      if (ttl > 0 && detection.unavailable.length === 0) {
        if (cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { at: now(), detection });
      }
      return pickChain(detection, opts);
    },
    clear() {
      cache.clear();
    },
  });
}
