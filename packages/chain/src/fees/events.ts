// Credit events (IR-M1-3b-1 I-2; 05 §2.5): what the client reads for credit history.
//
// A log counts only when it comes from the configured (canonical) vault address, is final in the
// RPC's view (not `removed`, not pending), decodes strictly against the client ABI, names an offered
// fee token, and moves a nonzero amount. Anyone can emit a zero-amount `Deposited` (deposit 0),
// `Swept` or `IntegratorWithdrawn`, so those are ignored rather than shown.
//
// The history read asks the vault address only, for one payer, over a bounded block range. Proof
// verification never reads logs (07 §8, M1-4d): some RPCs prune them.
import { decodeEventLog, type AbiEvent } from 'viem';
import type { ChainConfig, FeeTokenSymbol } from '../config/index.js';
import { FEE_VAULT_CLIENT_ABI } from '../clients/calls.js';
import { toChainError } from '../clients/errors.js';
import type { ReadClient } from '../clients/read-client.js';
import { ChainInputError, canonicalAddress, type Hex } from '../ids/index.js';
import { offeredTokenAt } from './tokens.js';

/** The widest block range one history read covers. */
export const MAX_LOG_BLOCK_SPAN = 10_000n;

/** The events that change or explain a payer's credits, and the vault's own movements. */
export type CreditEventName =
  'Deposited' | 'Withdrawn' | 'Charged' | 'Swept' | 'IntegratorWithdrawn';

const CREDIT_EVENTS: readonly CreditEventName[] = Object.freeze([
  'Deposited',
  'Withdrawn',
  'Charged',
  'Swept',
  'IntegratorWithdrawn',
]);
/** Events whose `amount` must be nonzero to count. */
const AMOUNT_EVENTS: readonly string[] = Object.freeze([
  'Deposited',
  'Withdrawn',
  'Swept',
  'IntegratorWithdrawn',
]);
/** The payer's own events, read by `readCreditHistory`. */
const PAYER_EVENTS: readonly CreditEventName[] = Object.freeze([
  'Deposited',
  'Withdrawn',
  'Charged',
]);

/** A log as an RPC returns it (viem's `Log` fits). */
export interface RawLog {
  readonly address: string;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint | null;
  readonly logIndex: number | null;
  readonly transactionHash: Hex | null;
  readonly removed?: boolean;
}

/** A credit event that passed every check. */
export interface CreditEvent {
  readonly eventName: CreditEventName;
  readonly token: FeeTokenSymbol;
  readonly args: Readonly<Record<string, unknown>>;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly transactionHash: Hex;
}

function decode(log: RawLog): { eventName: string; args: Record<string, unknown> } | undefined {
  try {
    const decoded = decodeEventLog({
      abi: FEE_VAULT_CLIENT_ABI,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
      strict: true,
    });
    return { eventName: decoded.eventName, args: decoded.args as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/** The credit events among `logs`, in chain order, with everything that fails a check left out. */
export function filterCreditEvents(config: ChainConfig, logs: readonly RawLog[]): CreditEvent[] {
  const vault = config.contracts.vault.toLowerCase();
  const out: CreditEvent[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== vault) continue;
    if (log.removed === true) continue;
    if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) continue;
    const decoded = decode(log);
    if (decoded === undefined) continue;
    const eventName = decoded.eventName as CreditEventName;
    if (!CREDIT_EVENTS.includes(eventName)) continue;
    const token =
      typeof decoded.args.token === 'string'
        ? offeredTokenAt(config, decoded.args.token)
        : undefined;
    if (token === undefined) continue;
    if (AMOUNT_EVENTS.includes(eventName) && decoded.args.amount === 0n) continue;
    const id = `${log.transactionHash}:${String(log.logIndex)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(
      Object.freeze({
        eventName,
        token: token.token.symbol,
        args: Object.freeze({ ...decoded.args }),
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        transactionHash: log.transactionHash,
      }),
    );
  }
  return out.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
}

export interface CreditHistoryRequest {
  readonly payer: Hex;
  readonly fromBlock: bigint;
  /** Inclusive; at most MAX_LOG_BLOCK_SPAN after fromBlock. */
  readonly toBlock: bigint;
}

function eventAbi(name: CreditEventName): AbiEvent {
  return FEE_VAULT_CLIENT_ABI.find((e) => e.type === 'event' && e.name === name) as AbiEvent;
}

/** The payer's deposits, withdrawals and charges in a block range, filtered as above. */
export async function readCreditHistory(
  client: ReadClient,
  config: ChainConfig,
  request: CreditHistoryRequest,
): Promise<CreditEvent[]> {
  const payer = canonicalAddress(request.payer, 'payer');
  const { fromBlock, toBlock } = request;
  if (
    typeof fromBlock !== 'bigint' ||
    typeof toBlock !== 'bigint' ||
    fromBlock < 0n ||
    toBlock < fromBlock ||
    toBlock - fromBlock > MAX_LOG_BLOCK_SPAN
  ) {
    throw new ChainInputError(
      'invalid_block_range',
      `fromBlock..toBlock: ascending, at most ${String(MAX_LOG_BLOCK_SPAN)} blocks`,
    );
  }
  const batches = await Promise.all(
    PAYER_EVENTS.map((name) =>
      client.getLogs({
        address: config.contracts.vault,
        event: eventAbi(name),
        args: { payer },
        fromBlock,
        toBlock,
        strict: true,
      }),
    ),
  ).catch((error: unknown) => {
    throw toChainError(error);
  });
  const logs = batches.flat() as unknown as RawLog[];
  return filterCreditEvents(config, logs).filter(
    (e) => typeof e.args.payer === 'string' && e.args.payer.toLowerCase() === payer,
  );
}
