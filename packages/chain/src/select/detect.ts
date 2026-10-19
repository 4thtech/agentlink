// Detection for chain selection (07 §6.3 step 1, D-40): for one payer and one action, read on every
// selectable chain in parallel the fee quote, `creditsOf` and, where a gasless top-up exists, the
// stablecoin balance and the vault's `minDeposit`. Each chain has a short time budget; a chain that fails or does not answer
// in time is listed as unavailable (chain ID only, no error text: it could name an RPC URL) and
// skipped for this attempt. A mainnet entry is never queried, so its RPC never sees the address.
import { erc20Abi } from 'viem';
import type { ConfiguredFeeType } from '../config/index.js';
import { feeVaultReader } from '../clients/calls.js';
import { canonicalAddress, ChainInputError, type Hex } from '../ids/index.js';
import { FEE_TYPE_IDS, offeredTokens, quoteFee, type ChainReader } from '../fees/index.js';
import { isSelectableChain, type ChainFunding, type FundingDetection } from './pick.js';

/** The per-chain time budget by default (07 §6.3: "a short time budget"). */
export const DEFAULT_DETECT_BUDGET_MS = 4_000;
/** The longest per-chain budget a caller may set. */
export const MAX_DETECT_BUDGET_MS = 30_000;

const APP_ID = /^0x[0-9a-fA-F]{64}$/;

export interface DetectOptions {
  readonly feeType: ConfiguredFeeType;
  /** Defaults to the official app (0). */
  readonly appId?: Hex;
  /** Per-chain budget in ms, 1 to 30 000; default 4 000. */
  readonly budgetMs?: number;
}

/** Validates the options before any request: a bad input must not look like a chain outage. */
export function checkDetectOptions(options: DetectOptions): number {
  if (!Object.hasOwn(FEE_TYPE_IDS, options.feeType as string)) {
    throw new ChainInputError('unsupported_fee_type', 'feeType: NOTARIZE or REGISTER');
  }
  if (
    options.appId !== undefined &&
    (typeof options.appId !== 'string' || !APP_ID.test(options.appId))
  ) {
    throw new ChainInputError('invalid_app_id', 'appId: 0x + 64 hex');
  }
  const budget = options.budgetMs ?? DEFAULT_DETECT_BUDGET_MS;
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_DETECT_BUDGET_MS) {
    throw new ChainInputError('invalid_budget', 'budgetMs: an integer from 1 to 30000');
  }
  return budget;
}

async function detectOn(
  { client, config }: ChainReader,
  payer: Hex,
  options: DetectOptions,
): Promise<ChainFunding> {
  const vault = feeVaultReader(client, config);
  const opts = await Promise.all(
    offeredTokens(config).map(async ({ token, vaultAddress }) => {
      const topUp = token.eip3009 === true && token.address !== null;
      const [quote, credits, topUpBalance, minDeposit] = await Promise.all([
        quoteFee(client, config, {
          feeType: options.feeType,
          token: token.symbol,
          ...(options.appId === undefined ? {} : { appId: options.appId }),
        }),
        vault.read.creditsOf([payer, vaultAddress]),
        topUp
          ? client.readContract({
              address: token.address as Hex,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [payer],
            })
          : Promise.resolve(null),
        topUp ? vault.read.minDeposit([vaultAddress]) : Promise.resolve(null),
      ]);
      return Object.freeze({ quote, credits, topUpBalance, minDeposit });
    }),
  );
  return Object.freeze({ config, options: Object.freeze(opts) });
}

/** Timers exist in every target (browser, Node, Workers); this package's lib has no DOM or Node types. */
interface TimerGlobals {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}
const timers = globalThis as unknown as TimerGlobals;

function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  let timer: unknown;
  const late = new Promise<never>((_resolve, reject) => {
    timer = timers.setTimeout(() => {
      reject(new Error('budget'));
    }, budgetMs);
  });
  return Promise.race([work, late]).finally(() => {
    timers.clearTimeout(timer);
  });
}

/**
 * Detects how the payer can pay for one action on every selectable chain, in parallel. Errors are
 * ChainInputErrors for bad input, before any request; a chain's own failure is never thrown.
 */
export async function detectFunding(
  chains: readonly ChainReader[],
  payer: Hex,
  options: DetectOptions,
): Promise<FundingDetection> {
  const who = canonicalAddress(payer, 'payer');
  const budget = checkDetectOptions(options);
  const selectable = chains.filter((c) => isSelectableChain(c.config));
  const results = await Promise.allSettled(
    selectable.map((c) => withinBudget(detectOn(c, who, options), budget)),
  );
  const found: ChainFunding[] = [];
  const unavailable: number[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') found.push(result.value);
    else unavailable.push((selectable[i] as ChainReader).config.chainId);
  });
  return Object.freeze({
    payer: who,
    chains: Object.freeze(found),
    unavailable: Object.freeze(unavailable.sort((a, b) => a - b)),
  });
}
