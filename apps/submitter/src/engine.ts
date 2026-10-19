// The submitter's batching engine for one chain (05 §3.3 G-4, D-61, D-62; 07 §7 FA-1, FA-3; 04 §7
// gas griefing; M1-10a). Pure logic over a SubmitterChain port and a QueueState; the queue Durable
// Object (queue.ts) holds the state, serialises calls and persists what changed.
//
// Rules:
// - Before sending: the item's deadline; a signer refused after a solo revert (below); the EOA
//   signature, locally (a signer with code is checked by the Notary); each item simulated alone. An
//   item already on-chain in identical form is `skipped` and never transmitted (FA-3). An item whose
//   own simulated gas is above `maxItemGas` is `failed` with `gas_too_high` (IR-M1-10a-1 H-1: an
//   ERC-1271 account that burns gas in isValidSignature). Any other failure is `failed` with the
//   contract error. A pause holds the item (`held`) until unpause or its deadline (`Expired`).
// - The signer limit is charged only for items new at simulation (FA-3); the per-IP limit is the
//   Worker's, before this.
// - Batches: a code-bearing signer (ERC-1271, EIP-7702) is solo from its first item (FA-1, default),
//   or at most one such item per batch (`one-per-batch`). A signer that caused an on-chain revert is
//   solo for `soloAfterRevertSeconds` (D-62). The batch is simulated again; its gas limit is that
//   simulated gas plus the fixed margin (FA-1), and a batch whose simulated gas is above the sum of
//   its items' own simulated gas is split, so a limit never exceeds that sum plus the margin.
// - After an on-chain revert: every item is simulated again; the failing ones are `failed` and their
//   signers cool off. In a solo transaction whose items still pass simulation, the simulation and
//   the inclusion disagree: the items are `failed` without a resend, and the signer is refused for
//   `soloAfterRevertSeconds` (IR-M1-10a-1 M-1). In a shared batch the rest are resubmitted once; an
//   item that reverts twice is `failed` and never retried. In `one-per-batch` mode the code-bearing
//   item is taken as the cause.
// - A transaction with no receipt after `stuckAfterSeconds` is replaced at the same nonce with
//   raised fees, at most `maxReplacements` times. If none is included after that, it is `dropped`:
//   its items are queued again (a fresh simulation shows any that landed as `skipped`) and the next
//   nonce is read from the chain, so a lost nonce cannot block later sends (IR-M1-10a-1 M-2).
// - Nonces are serialised per chain: the engine holds one lock per state object.
import type {
  Hex,
  StatusResponse,
  SubmitItem,
  SubmitItemResult,
  SubmitStatus,
  SubmitterChain,
} from '@4thtech-io/chain';

export interface EngineSettings {
  /** Added to every transaction's simulated gas (FA-1). */
  readonly gasMargin: bigint;
  /** The most simulated gas one item may use alone (H-1). */
  readonly maxItemGas: bigint;
  readonly soloAfterRevertSeconds: number;
  readonly codeSignerMode: 'solo' | 'one-per-batch';
  /** Most items in one transaction, 1 to 20. */
  readonly maxBatch: number;
  /** How long finished items and transactions stay readable through `/v1/status`. */
  readonly retentionSeconds: number;
  /** A transaction with no receipt after this long is replaced with raised fees. */
  readonly stuckAfterSeconds: number;
  /** Fee-raised replacements per transaction before it counts as dropped. */
  readonly maxReplacements: number;
}

export interface EngineHooks {
  /**
   * Charges each signer's limit for its new items; returns the signers over their limit, whose
   * items are then `failed` with `rate_limited`.
   */
  chargeSigners(counts: ReadonlyMap<string, number>, now: number): Promise<ReadonlySet<string>>;
}

/** One item in flight or recently finished. */
export interface ItemState {
  readonly item: SubmitItem;
  readonly codeBearing: boolean;
  status: SubmitStatus;
  txHash?: Hex;
  error?: string;
  /** The item's own simulated gas (its latest simulation). */
  gas: bigint;
  /** On-chain reverts of transactions that carried this item (one resubmission allowed). */
  reverts: number;
  updatedAt: number;
}

export interface TxState {
  /** The first transaction sent at this nonce; the key of the transaction. */
  readonly hash: Hex;
  /** Every transaction signed at this nonce for these items: the first, then its replacements. */
  readonly hashes: Hex[];
  readonly nonce: number;
  readonly ids: readonly string[];
  readonly gasLimit: bigint;
  /** One-per-batch mode: the code-bearing item of a mixed batch, the cause if it reverts. */
  readonly codeBearingId: string | null;
  state: 'pending' | 'included' | 'reverted' | 'dropped';
  readonly sentAt: number;
  lastSentAt: number;
  replacements: number;
}

export interface QueueState {
  /** The next transaction nonce, or null to read the pending nonce from the chain. */
  nonce: number | null;
  readonly items: Map<string, ItemState>;
  readonly txs: Map<string, TxState>;
  /** Signer -> unix seconds until which its items go solo (D-62). */
  readonly soloUntil: Map<string, number>;
  /** Signer -> unix seconds until which its items are refused (M-1). */
  readonly refusedUntil: Map<string, number>;
  /** What changed since the owner last persisted (not persisted itself). */
  readonly changed: { readonly items: Set<string>; readonly txs: Set<string>; meta: boolean };
}

export function emptyQueueState(): QueueState {
  return {
    nonce: null,
    items: new Map(),
    txs: new Map(),
    soloUntil: new Map(),
    refusedUntil: new Map(),
    changed: { items: new Set(), txs: new Set(), meta: false },
  };
}

/** Fee level of the n-th replacement, in percent: +25 % compounded (each one over the 10 % rule). */
export const replacementFeePercent = (n: number): number => Math.ceil(100 * 1.25 ** n);

const locks = new WeakMap<QueueState, Promise<unknown>>();

/** Runs `fn` after every earlier call on the same state (per-chain nonce serialisation). */
function withLock<T>(state: QueueState, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(state) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(
    state,
    next.catch(() => undefined),
  );
  return next;
}

function resultOf(entry: ItemState): SubmitItemResult {
  return {
    id: entry.item.id,
    recordId: entry.item.recordId,
    status: entry.status,
    ...(entry.txHash === undefined ? {} : { txHash: entry.txHash }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}

const plain = (item: SubmitItem, status: SubmitStatus, error?: string): SubmitItemResult => ({
  id: item.id,
  recordId: item.recordId,
  status,
  ...(error === undefined ? {} : { error }),
});

function setItem(state: QueueState, entry: ItemState): void {
  state.items.set(entry.item.id, entry);
  state.changed.items.add(entry.item.id);
}

function update(
  state: QueueState,
  entry: ItemState,
  status: SubmitStatus,
  now: number,
  extra: { txHash?: Hex | null; error?: string | null } = {},
): void {
  entry.status = status;
  entry.updatedAt = now;
  if (extra.txHash === null) delete entry.txHash;
  else if (extra.txHash !== undefined) entry.txHash = extra.txHash;
  if (extra.error === null) delete entry.error;
  else if (extra.error !== undefined) entry.error = extra.error;
  state.changed.items.add(entry.item.id);
}

const inFlight = (s: SubmitStatus): boolean => s === 'submitted' || s === 'held';

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Splits items into transactions under the FA-1 and D-62 rules. */
function plan(settings: EngineSettings, state: QueueState, entries: ItemState[], now: number) {
  const soloBySigner = new Map<string, ItemState[]>();
  const shared: ItemState[] = [];
  for (const entry of entries) {
    const signer = entry.item.signer;
    const cooling = (state.soloUntil.get(signer) ?? 0) > now;
    if (cooling || (entry.codeBearing && settings.codeSignerMode === 'solo')) {
      soloBySigner.set(signer, [...(soloBySigner.get(signer) ?? []), entry]);
    } else {
      shared.push(entry);
    }
  }
  const codes = shared.filter((e) => e.codeBearing);
  const others = shared.filter((e) => !e.codeBearing);
  const room =
    codes.length > 0 && settings.maxBatch > 1 ? settings.maxBatch - 1 : settings.maxBatch;
  const batches = chunk(others, room);
  codes.forEach((code, i) => {
    const batch = batches[i];
    if (batch && batch.length < settings.maxBatch) batch.push(code);
    else batches.push([code]);
  });
  for (const group of soloBySigner.values()) batches.push(...chunk(group, settings.maxBatch));
  return batches;
}

/** Applies a fresh one-item simulation to an entry; returns true when it may be sent. */
function applySimulation(
  state: QueueState,
  settings: EngineSettings,
  entry: ItemState,
  sim: Awaited<ReturnType<SubmitterChain['simulateItem']>>,
  now: number,
): boolean {
  if (sim.outcome === 'ok') {
    if (sim.gas > settings.maxItemGas) {
      update(state, entry, 'failed', now, { txHash: null, error: 'gas_too_high' });
      return false;
    }
    entry.gas = sim.gas;
    return true;
  }
  if (sim.outcome === 'skipped') update(state, entry, 'skipped', now, { txHash: null });
  else if (sim.outcome === 'paused') update(state, entry, 'held', now, { txHash: null });
  else update(state, entry, 'failed', now, { txHash: null, error: sim.error });
  return false;
}

async function sendGroup(
  port: SubmitterChain,
  settings: EngineSettings,
  state: QueueState,
  group: ItemState[],
  now: number,
  depth = 0,
): Promise<void> {
  const items = group.map((e) => e.item);
  let sim;
  try {
    sim = await port.simulateBatch(items);
  } catch {
    // The chain could not be read: infrastructure, not the items' fault (no cool-off).
    for (const e of group) update(state, e, 'failed', now, { txHash: null, error: 'unavailable' });
    return;
  }
  const ceiling = group.reduce((sum, e) => sum + e.gas, 0n);
  if (sim.ok && sim.gas > ceiling && group.length > 1) {
    // Together they need more than the sum of their own simulations: never pay for that.
    sim = { ok: false as const, error: 'gas_too_high', paused: false };
  }
  if (!sim.ok) {
    if (sim.paused) {
      for (const e of group) update(state, e, 'held', now, { txHash: null });
      return;
    }
    // State changed since the per-item simulation: find the failing items again.
    const keep: ItemState[] = [];
    for (const e of group) {
      try {
        if (applySimulation(state, settings, e, await port.simulateItem(e.item), now)) keep.push(e);
      } catch {
        update(state, e, 'failed', now, { txHash: null, error: 'unavailable' });
      }
    }
    if (keep.length === 0) return;
    if (depth === 0 && keep.length < group.length) {
      await sendGroup(port, settings, state, keep, now, 1);
    } else if (depth < 2 && keep.length > 1) {
      // Each passes alone but not together: send each item apart.
      for (const e of keep) await sendGroup(port, settings, state, [e], now, 2);
    } else {
      for (const e of keep) update(state, e, 'failed', now, { txHash: null, error: sim.error });
    }
    return;
  }
  if (group.length === 1 && sim.gas > settings.maxItemGas) {
    update(state, group[0] as ItemState, 'failed', now, { txHash: null, error: 'gas_too_high' });
    return;
  }
  const gasLimit = sim.gas + settings.gasMargin;
  let nonce: number;
  let hash: Hex;
  try {
    nonce = state.nonce ?? (await port.pendingNonce());
    hash = await port.send(items, { gasLimit, nonce });
  } catch {
    // The nonce may or may not be used: read it from the chain next time.
    state.nonce = null;
    state.changed.meta = true;
    for (const e of group) update(state, e, 'failed', now, { txHash: null, error: 'unavailable' });
    return;
  }
  state.nonce = nonce + 1;
  state.changed.meta = true;
  const signers = new Set(items.map((i) => i.signer));
  const code = group.find((e) => e.codeBearing);
  state.txs.set(hash, {
    hash,
    hashes: [hash],
    nonce,
    ids: items.map((i) => i.id),
    gasLimit,
    codeBearingId:
      settings.codeSignerMode === 'one-per-batch' && code && signers.size > 1 ? code.item.id : null,
    state: 'pending',
    sentAt: now,
    lastSentAt: now,
    replacements: 0,
  });
  state.changed.txs.add(hash);
  for (const e of group) update(state, e, 'submitted', now, { txHash: hash, error: null });
}

async function dispatch(
  port: SubmitterChain,
  settings: EngineSettings,
  state: QueueState,
  entries: ItemState[],
  now: number,
): Promise<void> {
  for (const group of plan(settings, state, entries, now)) {
    await sendGroup(port, settings, state, group, now);
  }
}

/**
 * Validates, simulates and sends a request's items; returns their status in request order. A
 * chain read that fails throws (the Worker answers `unavailable`) before anything is sent.
 */
export function submitItems(
  port: SubmitterChain,
  settings: EngineSettings,
  state: QueueState,
  items: readonly SubmitItem[],
  now: number,
  hooks: EngineHooks,
): Promise<SubmitItemResult[]> {
  return withLock(state, async () => {
    const out = new Map<string, SubmitItemResult>();
    const fresh: SubmitItem[] = [];
    for (const item of items) {
      const existing = state.items.get(item.id);
      if (existing && inFlight(existing.status)) out.set(item.id, resultOf(existing));
      else if (item.deadline < now) out.set(item.id, plain(item, 'failed', 'Expired'));
      else if ((state.refusedUntil.get(item.signer) ?? 0) > now) {
        out.set(item.id, plain(item, 'failed', 'signer_refused'));
      } else fresh.push(item);
    }
    const signers = [...new Set(fresh.map((i) => i.signer))];
    const codes = await Promise.all(signers.map((s) => port.hasCode(s)));
    const hasCode = new Map(signers.map((s, i) => [s, codes[i] === true]));
    const checked = fresh.filter((item) => {
      if (hasCode.get(item.signer) || port.signatureMatches(item)) return true;
      out.set(item.id, plain(item, 'failed', 'InvalidSignature'));
      return false;
    });
    const sims = await Promise.all(checked.map((item) => port.simulateItem(item)));
    const accepted: { item: SubmitItem; held: boolean; gas: bigint }[] = [];
    checked.forEach((item, i) => {
      const sim = sims[i];
      if (!sim) return;
      if (sim.outcome === 'skipped') out.set(item.id, plain(item, 'skipped'));
      else if (sim.outcome === 'failed') out.set(item.id, plain(item, 'failed', sim.error));
      else if (sim.outcome === 'ok' && sim.gas > settings.maxItemGas) {
        out.set(item.id, plain(item, 'failed', 'gas_too_high'));
      } else {
        accepted.push({
          item,
          held: sim.outcome === 'paused',
          gas: sim.outcome === 'ok' ? sim.gas : settings.maxItemGas,
        });
      }
    });
    const counts = new Map<string, number>();
    for (const { item } of accepted) counts.set(item.signer, (counts.get(item.signer) ?? 0) + 1);
    const refused = counts.size > 0 ? await hooks.chargeSigners(counts, now) : new Set<string>();
    const toSend: ItemState[] = [];
    for (const { item, held, gas } of accepted) {
      if (refused.has(item.signer)) {
        out.set(item.id, plain(item, 'failed', 'rate_limited'));
        continue;
      }
      const entry: ItemState = {
        item,
        codeBearing: hasCode.get(item.signer) === true,
        status: held ? 'held' : 'submitted',
        gas,
        reverts: 0,
        updatedAt: now,
      };
      setItem(state, entry);
      if (!held) toSend.push(entry);
    }
    await dispatch(port, settings, state, toSend, now);
    return items.map((item) => {
      const known = out.get(item.id);
      if (known) return known;
      const entry = state.items.get(item.id);
      return entry ? resultOf(entry) : plain(item, 'failed', 'unavailable');
    });
  });
}

/** The items a transaction still carries (submitted in one of its hashes). */
function carried(state: QueueState, tx: TxState): ItemState[] {
  return tx.ids
    .map((id) => state.items.get(id))
    .filter(
      (e): e is ItemState =>
        !!e && e.status === 'submitted' && e.txHash !== undefined && tx.hashes.includes(e.txHash),
    );
}

async function handleRevert(
  port: SubmitterChain,
  settings: EngineSettings,
  state: QueueState,
  tx: TxState,
  now: number,
): Promise<void> {
  const entries = carried(state, tx);
  const until = now + settings.soloAfterRevertSeconds;
  const coolOff = (signer: string) => {
    state.soloUntil.set(signer, until);
    state.changed.meta = true;
  };
  const solo = new Set(entries.map((e) => e.item.signer)).size === 1;
  let candidates = entries;
  if (tx.codeBearingId !== null && entries.length > 1) {
    // One-per-batch mode (FA-1): the code-bearing item is taken as the cause.
    const cause = entries.find((e) => e.item.id === tx.codeBearingId);
    if (cause) {
      update(state, cause, 'failed', now, { error: 'reverted' });
      coolOff(cause.item.signer);
      candidates = entries.filter((e) => e !== cause);
    }
  }
  const resend: ItemState[] = [];
  for (const e of candidates) {
    let sim;
    try {
      sim = await port.simulateItem(e.item);
    } catch {
      // Infrastructure, not the item: no cool-off.
      update(state, e, 'failed', now, { error: 'unavailable' });
      continue;
    }
    if (sim.outcome === 'paused') {
      // A pause is not an item failure, and does not use up the retry.
      update(state, e, 'held', now, { txHash: null });
    } else if (sim.outcome === 'skipped') {
      update(state, e, 'skipped', now, { txHash: null });
    } else if (sim.outcome === 'failed') {
      update(state, e, 'failed', now, { error: sim.error });
      coolOff(e.item.signer);
    } else if (solo) {
      // M-1: its own transaction reverted, yet it still passes simulation. Simulation and
      // inclusion disagree for this signer: no resend, and its items are refused for a while.
      update(state, e, 'failed', now, { error: 'reverted' });
      state.refusedUntil.set(e.item.signer, until);
      coolOff(e.item.signer);
    } else {
      e.reverts += 1;
      if (e.reverts >= 2) update(state, e, 'failed', now, { error: 'reverted' });
      else if (applySimulation(state, settings, e, sim, now)) resend.push(e);
    }
  }
  await dispatch(port, settings, state, resend, now);
}

/** M-2: replaces a transaction stuck without a receipt, or gives it up and queues its items again. */
async function handleStuck(
  port: SubmitterChain,
  settings: EngineSettings,
  state: QueueState,
  tx: TxState,
  now: number,
): Promise<void> {
  const entries = carried(state, tx);
  if (entries.length === 0) {
    tx.state = 'dropped';
    state.changed.txs.add(tx.hash);
    return;
  }
  if (tx.replacements < settings.maxReplacements) {
    tx.replacements += 1;
    tx.lastSentAt = now;
    state.changed.txs.add(tx.hash);
    try {
      const hash = await port.send(
        entries.map((e) => e.item),
        {
          gasLimit: tx.gasLimit,
          nonce: tx.nonce,
          feePercent: replacementFeePercent(tx.replacements),
        },
      );
      tx.hashes.push(hash);
      for (const e of entries) update(state, e, 'submitted', now, { txHash: hash });
    } catch {
      // Refused (for example underpriced) or unreachable: this try is used up all the same.
    }
    return;
  }
  // Given up: queue the items again; a fresh simulation shows any that landed after all.
  tx.state = 'dropped';
  state.changed.txs.add(tx.hash);
  state.nonce = null;
  state.changed.meta = true;
  for (const e of entries) update(state, e, 'held', now, { txHash: null });
}

/**
 * One round of upkeep (the queue's alarm): inclusion of sent transactions, stuck transactions,
 * held items, expiry and retention. Returns true while anything is still in flight.
 */
export function pollQueue(
  port: SubmitterChain,
  settings: EngineSettings,
  state: QueueState,
  now: number,
): Promise<boolean> {
  return withLock(state, async () => {
    const horizon = now - settings.retentionSeconds;
    for (const [id, e] of state.items) {
      if (!inFlight(e.status) && e.updatedAt < horizon) {
        state.items.delete(id);
        state.changed.items.add(id);
      }
    }
    for (const [hash, tx] of state.txs) {
      if (tx.state !== 'pending' && tx.sentAt < horizon) {
        state.txs.delete(hash);
        state.changed.txs.add(hash);
      }
    }
    for (const map of [state.soloUntil, state.refusedUntil]) {
      for (const [signer, until] of map) {
        if (until <= now) {
          map.delete(signer);
          state.changed.meta = true;
        }
      }
    }

    for (const tx of [...state.txs.values()]) {
      if (tx.state !== 'pending') continue;
      let found: { hash: Hex; inclusion: Awaited<ReturnType<SubmitterChain['inclusion']>> } | null =
        null;
      let readFailed = false;
      for (const hash of tx.hashes) {
        try {
          const inclusion = await port.inclusion(hash);
          if (inclusion.state !== 'pending') {
            found = { hash, inclusion };
            break;
          }
        } catch {
          readFailed = true; // try again next round
        }
      }
      if (!found) {
        if (!readFailed && now - tx.lastSentAt >= settings.stuckAfterSeconds) {
          await handleStuck(port, settings, state, tx, now);
        }
        continue;
      }
      const { hash, inclusion } = found;
      // The included one (first or a replacement) is what the items show.
      for (const e of carried(state, tx)) update(state, e, 'submitted', now, { txHash: hash });
      if (inclusion.state === 'included') {
        tx.state = 'included';
        state.changed.txs.add(tx.hash);
        for (const e of carried(state, tx)) {
          const outcome = inclusion.outcomes.get(e.item.id);
          if (outcome) update(state, e, outcome, now);
          else update(state, e, 'failed', now, { error: 'not_included' });
        }
      } else {
        tx.state = 'reverted';
        state.changed.txs.add(tx.hash);
        await handleRevert(port, settings, state, tx, now);
      }
    }

    const held = [...state.items.values()].filter((e) => e.status === 'held');
    const ready: ItemState[] = [];
    for (const e of held) {
      if (e.item.deadline < now) {
        update(state, e, 'failed', now, { error: 'Expired' });
        continue;
      }
      let sim;
      try {
        sim = await port.simulateItem(e.item);
      } catch {
        continue;
      }
      if (sim.outcome === 'paused') continue;
      if (applySimulation(state, settings, e, sim, now)) ready.push(e);
    }
    await dispatch(port, settings, state, ready, now);
    return queueDepth(state) > 0;
  });
}

/** The status of a transaction this queue sent (by its first hash or a replacement's), or null. */
export function txStatus(state: QueueState, chainId: number, txHash: Hex): StatusResponse | null {
  let tx = state.txs.get(txHash);
  if (!tx) {
    for (const candidate of state.txs.values()) {
      if (candidate.hashes.includes(txHash)) {
        tx = candidate;
        break;
      }
    }
  }
  if (!tx) return null;
  const items = tx.ids
    .map((id) => state.items.get(id))
    .filter((e): e is ItemState => e !== undefined)
    .map(resultOf);
  return { chainId, txHash, state: tx.state, items };
}

/** Items in flight: submitted and not yet included, or held. */
export function queueDepth(state: QueueState): number {
  let n = 0;
  for (const e of state.items.values()) if (inFlight(e.status)) n += 1;
  return n;
}
