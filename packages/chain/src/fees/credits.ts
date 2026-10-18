// Credits (12 §4.1; 06 §2.1 `credits`; 07 §6.3 step 1): `OCCFeeVault.creditsOf(payer, token)` for
// every offered fee token on every supported chain, shown in USD at 1:1 and rounded down. Which
// chain pays (auto-detection and selection, D-40) is M1-26; this only reads.
import type { ChainConfig, FeeTokenSymbol } from '../config/index.js';
import { feeVaultReader } from '../clients/calls.js';
import type { ReadClient } from '../clients/read-client.js';
import { canonicalAddress, type Hex } from '../ids/index.js';
import { offeredTokens } from './tokens.js';
import { tokenUnitsToUsd } from './usd.js';

/** One credit balance (06 §2.1 `credits[]`). */
export interface CreditBalance {
  readonly chainId: number;
  /** The chain's config key. */
  readonly chain: string;
  readonly token: FeeTokenSymbol;
  /** Base units. */
  readonly amount: bigint;
  /** USD rounded down; `null` above the USD range. */
  readonly usd: string | null;
}

/** A chain to read: its config and read client. */
export interface ChainReader {
  readonly config: ChainConfig;
  readonly client: ReadClient;
}

async function creditsOn(
  client: ReadClient,
  config: ChainConfig,
  payer: Hex,
): Promise<CreditBalance[]> {
  const vault = feeVaultReader(client, config);
  return Promise.all(
    offeredTokens(config).map(async ({ token, vaultAddress }) => {
      const amount = await vault.read.creditsOf([payer, vaultAddress]);
      return Object.freeze({
        chainId: config.chainId,
        chain: config.key,
        token: token.symbol,
        amount,
        usd: tokenUnitsToUsd(amount, token.decimals, 'down'),
      });
    }),
  );
}

/** The payer's credits on one chain. Errors are ChainInputErrors (before any request) or ChainErrors. */
export async function readCredits(
  client: ReadClient,
  config: ChainConfig,
  payer: Hex,
): Promise<CreditBalance[]> {
  return creditsOn(client, config, canonicalAddress(payer, 'payer'));
}

/**
 * The payer's credits on every given chain, in parallel. A chain that fails is listed in
 * `unavailable` (no error text: it could name an RPC) and skipped for this read (07 §6.3).
 */
export async function readCreditsAcrossChains(
  chains: readonly ChainReader[],
  payer: Hex,
): Promise<{ credits: CreditBalance[]; unavailable: number[] }> {
  const who = canonicalAddress(payer, 'payer');
  const results = await Promise.allSettled(
    chains.map(({ client, config }) => creditsOn(client, config, who)),
  );
  const credits: CreditBalance[] = [];
  const unavailable: number[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') credits.push(...result.value);
    else unavailable.push((chains[i] as ChainReader).config.chainId);
  });
  return { credits, unavailable };
}
