// The proof and credits reads for the local UI (M1-11r-a): the stored proofs, newest first; the
// credits per chain; and free test credits on an allowlisted testnet.
//
// Zero access (I-7): a listed proof carries IDs, its chain, status and time only, never the salt,
// the signed Record or a transaction hash. A credits read names the chain, its token and amounts,
// never an RPC URL (07 §6.1: RPC URLs are secrets) or a chain error's text. The free test credits
// request sends the chain ID and the agent ID, both public, and only for a chain on the chain
// package's hard-coded testnet allowlist whose shipped config also says testnet (05 §9, SUB-7):
// a mainnet chain is refused before any request. It spends nothing of the user's and signs nothing,
// so it needs no owner presence (04 §2.5 covers owner operations; M1-10b limits claims server-side).
import type { Hex } from '@4thtech-io/chain';
import type { CoreContext } from '../context.js';
import {
  candidatesTx,
  pageLimit,
  pageOf,
  parseCursor,
  type Page,
  type PageQuery,
} from '../paging.js';
import type { FreeCreditsAnswer, ProofChain, ProofsPlatform } from './platform.js';

/** One stored proof (own or received) for the proof list. */
export interface ProofListItem {
  readonly recordId: string;
  /** The message it proves. */
  readonly envelopeId: string;
  readonly direction: 'sent' | 'received';
  /** As in getProof (`recorded`, `pending`, `needs_credits`, `received`, …). */
  readonly status: string;
  readonly chainId: number;
  /** The chain's config key, or the chain ID when this runtime does not know the chain. */
  readonly chain: string;
  /** Unix seconds. */
  readonly createdAt: number;
}

/** Credits on one chain, in the fee tokens it offers (12 §4.1). */
export interface ChainCredits {
  readonly chainId: number;
  readonly chain: string;
  readonly testnet: boolean;
  /** Free test credits can be requested on this chain (requestFaucet). */
  readonly freeCredits: boolean;
  /** False when the chain could not be read just now; `credits` is then empty. */
  readonly available: boolean;
  readonly credits: readonly {
    readonly token: string;
    /** Base units, as a decimal string. */
    readonly amount: string;
    /** USD rounded down; null above the USD range. */
    readonly usd: string | null;
  }[];
}

export type CreditsView =
  | {
      readonly status: 'ok';
      /** The credits account: the agent ID. */
      readonly agentId: string;
      readonly chains: readonly ChainCredits[];
    }
  | { readonly status: 'unavailable' };

export type FreeCreditsResult =
  | FreeCreditsAnswer
  | {
      readonly status: 'refused';
      readonly reason: 'not_testnet' | 'identity_missing';
    };

const UNAVAILABLE = Object.freeze({ status: 'unavailable' as const });

/** The stored proofs with a listed status, newest first by (createdAt, recordId). */
export async function listProofs(
  ctx: CoreContext,
  platform: ProofsPlatform | undefined,
  statuses: readonly string[],
  query: PageQuery,
): Promise<Page<ProofListItem>> {
  const limit = pageLimit(query);
  const cursor = parseCursor(query.cursor);
  const rows = await ctx.store.transaction((tx) =>
    candidatesTx(
      tx,
      'proofs',
      { status: { in: [...statuses] } },
      'created_at',
      'record_id',
      cursor,
      limit,
    ),
  );
  const page = pageOf(
    rows.map((r) => ({ at: r.created_at, id: r.record_id, row: r })),
    cursor,
    limit,
  );
  const chainKey = (chainId: number): string =>
    platform?.chains.find((c) => c.config.chainId === chainId)?.config.key ?? String(chainId);
  const items = page.items.map(({ row }) =>
    Object.freeze({
      recordId: row.record_id,
      envelopeId: row.envelope_id,
      direction: row.status === 'received' ? ('received' as const) : ('sent' as const),
      status: row.status,
      chainId: row.chain_id,
      chain: chainKey(row.chain_id),
      createdAt: row.created_at,
    }),
  );
  return Object.freeze({
    items: Object.freeze(items),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  });
}

const isFreeCreditsChain = (platform: ProofsPlatform, chain: ProofChain): boolean =>
  chain.config.testnet && platform.kit.isFaucetChain(chain.config.chainId);

/** The agent's credits on every chain of the platform, read in parallel (07 §6.3). */
export async function readCredits(
  platform: ProofsPlatform | undefined,
  agentId: string | undefined,
): Promise<CreditsView> {
  if (platform === undefined || agentId === undefined) return UNAVAILABLE;
  const chains = platform.chains;
  // Per chain, so a failure is listed by the chain; never the error text (it could name an RPC).
  const results = await Promise.all(
    chains.map(async (chain) => {
      try {
        const read = await platform.kit.readCreditsAcrossChains(
          [{ config: chain.config, client: chain.client }],
          agentId as Hex,
        );
        return read.unavailable.length > 0 ? undefined : read.credits;
      } catch {
        return undefined;
      }
    }),
  );
  return Object.freeze({
    status: 'ok' as const,
    agentId,
    chains: Object.freeze(
      chains.map((chain, i) => {
        const credits = results[i];
        return Object.freeze({
          chainId: chain.config.chainId,
          chain: chain.config.key,
          testnet: chain.config.testnet,
          freeCredits: isFreeCreditsChain(platform, chain),
          available: credits !== undefined,
          credits: Object.freeze(
            (credits ?? []).map((c) =>
              Object.freeze({ token: c.token, amount: c.amount.toString(), usd: c.usd }),
            ),
          ),
        });
      }),
    ),
  });
}

/**
 * Free test credits for the agent on `chainId` (M1-10b). Refused unless the chain is on the chain
 * package's testnet allowlist and this runtime ships it as a testnet; nothing is sent then.
 */
export async function requestFreeCredits(
  ctx: CoreContext,
  platform: ProofsPlatform | undefined,
  agentId: string | undefined,
  chainId: number,
): Promise<FreeCreditsResult> {
  if (platform === undefined) return UNAVAILABLE;
  const chain = platform.chains.find((c) => c.config.chainId === chainId);
  if (
    !platform.kit.isFaucetChain(chainId) ||
    chain === undefined ||
    !isFreeCreditsChain(platform, chain)
  ) {
    return Object.freeze({ status: 'refused', reason: 'not_testnet' });
  }
  if (platform.faucet === undefined) return UNAVAILABLE;
  if (agentId === undefined)
    return Object.freeze({ status: 'refused', reason: 'identity_missing' });
  let answer: FreeCreditsAnswer;
  try {
    answer = await platform.faucet.request({ chainId, agent: agentId });
  } catch {
    ctx.log.warn('free test credits not requested');
    return UNAVAILABLE;
  }
  switch (answer.status) {
    case 'sent':
      return Object.freeze({ status: 'sent' });
    case 'already_claimed':
    case 'rate_limited':
    case 'daily_cap_reached':
      return Number.isSafeInteger(answer.retryAfter) && answer.retryAfter >= 0
        ? Object.freeze({ status: answer.status, retryAfter: answer.retryAfter })
        : UNAVAILABLE;
    default:
      return UNAVAILABLE;
  }
}
