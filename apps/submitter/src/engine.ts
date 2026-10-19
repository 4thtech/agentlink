// The submitter's batching engine for one chain (05 §3.3 G-4, D-61, D-62; 07 §7 FA-1, FA-3; 04 §7
// gas griefing; M1-10a). Pure logic over a SubmitterChain port and a QueueState; the queue Durable
// Object (queue.ts) holds the state, serialises calls and persists what changed.
//
// Rules:
// - Before sending: the item's deadline; the EOA signature, locally (a signer with code is checked
//   by the Notary); each item simulated alone. An item already on-chain in identical form is
//   `skipped` and never transmitted (FA-3). Any other failure is `failed` with the contract error.
//   A pause holds the item (`held`) until unpause or its deadline (`Expired`).
// - The signer limit is charged only for items new at simulation (FA-3); the per-IP limit is the
//   Worker's, before this.
// - Batches: a code-bearing signer (ERC-1271, EIP-7702) is solo from its first item (FA-1, default),
//   or at most one such item per batch (`one-per-batch`). A signer that caused an on-chain revert is
//   solo for `soloAfterRevertSeconds` (D-62). The batch is simulated again; every transaction's gas
//   limit is that simulated gas plus the fixed margin (FA-1).
// - After an on-chain revert: every item is simulated again; the failing ones are `failed` and their
//   signers cool off; the rest are resubmitted once. An item that reverts twice is `failed` and never
//   retried. In `one-per-batch` mode the code-bearing item is taken as the cause.
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
  readonly soloAfterRevertSeconds: number;
  readonly codeSignerMode: 'solo' | 'one-per-batch';
  /** Most items in one transaction, 1 to 20. */
  readonly maxBatch: number;
  /** How long finished items and transactions stay readable through `/v1/status`. */
  readonly retentionSeconds: number;
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
  /** On-chain reverts of transactions that carried this item (one resubmission allowed). */
  reverts: number;
  updatedAt: number;
}

export interface TxState {
  readonly hash: Hex;
  readonly nonce: number;
  readonly ids: readonly string[];
  /** One-per-batch mode: the code-bearing item of a mixed batch, the cause if it reverts. */
  readonly codeBearingId: string | null;
  state: 'pending' | 'included' | 'reverted';
  readonly sentAt: number;
}

export interface QueueState {
  /** The next transaction nonce, or null to read the pending nonce from the chain. */
  nonce: number | null;
  readonly items: Map<string, ItemState>;
  readonly txs: Map<string, TxState>;
  /** Signer -> unix seconds until which its items go solo (D-62). */
  readonly soloUntil: Map<string, number>;
  /** What changed since the owner last persisted (not persisted itself). */
  readonly changed: { readonly items: Set<string>; readonly txs: Set<string>; meta: boolean };
}

export function emptyQueueState(): QueueState {
  return {
    nonce: null,
    items: new Map(),
    txs: new Map(),
    soloUntil: new Map(),
    changed: { items: new Set(), txs: new Set(), meta: false },
  };
}

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

async function sendGroup(
  port: SubmitterChain,
  settings: EngineSettings,
  state: QueueState,
  group: ItemState[],
  now: number,
  depth = 0,
): Promise<void> {
  const items = group.map((e) => e.item);
  const sim = await port.simulateBatch(items);
  if (!sim.ok) {
    if (sim.paused) {
      for (const e of group) update(state, e, 'held', now, { txHash: null });
      return;
    }
    // State changed since the per-item simulation: find the failing items again.
    const keep: ItemState[] = [];
    for (const e of group) {
      const s = await port.simulateItem(e.item);
      if (s.outcome === 'ok') keep.push(e);
      else if (s.outcome === 'skipped') update(state, e, 'skipped', now, { txHash: null });
      else if (s.outcome === 'paused') update(state, e, 'held', now, { txHash: null });
      else update(state, e, 'failed', now, { txHash: null, error: s.error });
    }
    if (keep.length === 0) return;
    if (depth === 0 && keep.length < group.length) {
      await sendGroup(port, settings, state, keep, now, 1);
    } else if (depth < 2 && keep.length > 1) {
      // Each passes alone but not together: send each signer's items apart.
      const bySigner = new Map<string, ItemState[]>();
      for (const e of keep)
        bySigner.set(e.item.signer, [...(bySigner.get(e.item.signer) ?? []), e]);
      for (const part of bySigner.values()) await sendGroup(port, settings, state, part, now, 2);
    } else {
      for (const e of keep) update(state, e, 'failed', now, { txHash: null, error: sim.error });
    }
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
    nonce,
    ids: items.map((i) => i.id),
    codeBearingId:
      settings.codeSignerMode === 'one-per-batch' && code && signers.size > 1 ? code.item.id : null,
    state: 'pending',
    sentAt: now,
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
      else fresh.push(item);
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
    const accepted: { item: SubmitItem; held: boolean }[] = [];
    checked.forEach((item, i) => {
      const sim = sims[i];
      if (!sim) return;
      if (sim.outcome === 'skipped') out.set(item.id, plain(item, 'skipped'));
      else if (sim.outcome === 'failed') out.set(item.id, plain(item, 'failed', sim.error));
      else accepted.push({ item, held: sim.outcome === 'paused' });
    });
    const counts = new Map<string, number>();
    for (const { item } of accepted) counts.set(item.signer, (counts.get(item.signer) ?? 0) + 1);
    const refused = counts.size > 0 ? await hooks.chargeSigners(counts, now) : new Set<string>();
    const toSend: ItemState[] = [];
    for (const { item, held } of accepted) {
      if (refused.has(item.signer)) {
        out.set(item.id, plain(item, 'failed', 'rate_limited'));
        continue;
      }
      const entry: ItemState = {
        item,
        codeBearing: hasCode.get(item.signer) === true,
        status: held ? 'held' : 'submitted',
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

async function handleRevert(
  port: SubmitterChain,
  settings: EngineSettings,
  state: QueueState,
  tx: TxState,
  now: number,
): Promise<void> {
  const entries = tx.ids
    .map((id) => state.items.get(id))
    .filter((e): e is ItemState => !!e && e.txHash === tx.hash && e.status === 'submitted');
  const coolOff = (signer: string) => {
    state.soloUntil.set(signer, now + settings.soloAfterRevertSeconds);
    state.changed.meta = true;
  };
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
    const sim = await port.simulateItem(e.item);
    if (sim.outcome === 'paused') {
      // A pause is not an item failure, and does not use up the retry.
      update(state, e, 'held', now, { txHash: null });
    } else if (sim.outcome === 'skipped') {
      update(state, e, 'skipped', now, { txHash: null });
    } else if (sim.outcome === 'failed') {
      update(state, e, 'failed', now, { error: sim.error });
      coolOff(e.item.signer);
    } else {
      e.reverts += 1;
      if (e.reverts >= 2) update(state, e, 'failed', now, { error: 'reverted' });
      else resend.push(e);
    }
  }
  await dispatch(port, settings, state, resend, now);
}

/**
 * One round of upkeep (the queue's alarm): inclusion of sent transactions, held items, expiry and
 * retention. Returns true while anything is still in flight.
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
    for (const [signer, until] of state.soloUntil) {
      if (until <= now) {
        state.soloUntil.delete(signer);
        state.changed.meta = true;
      }
    }

    for (const tx of [...state.txs.values()]) {
      if (tx.state !== 'pending') continue;
      let inclusion;
      try {
        inclusion = await port.inclusion(tx.hash);
      } catch {
        continue; // try again next round
      }
      if (inclusion.state === 'pending') continue;
      tx.state = inclusion.state;
      state.changed.txs.add(tx.hash);
      if (inclusion.state === 'included') {
        for (const id of tx.ids) {
          const e = state.items.get(id);
          if (!e || e.txHash !== tx.hash || e.status !== 'submitted') continue;
          const outcome = inclusion.outcomes.get(id);
          if (outcome) update(state, e, outcome, now);
          else update(state, e, 'failed', now, { error: 'not_included' });
        }
      } else {
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
      if (sim.outcome === 'ok') ready.push(e);
      else if (sim.outcome === 'skipped') update(state, e, 'skipped', now);
      else if (sim.outcome === 'failed') update(state, e, 'failed', now, { error: sim.error });
    }
    await dispatch(port, settings, state, ready, now);
    return queueDepth(state) > 0;
  });
}

/** The status of one transaction this queue sent, or null. */
export function txStatus(state: QueueState, chainId: number, txHash: Hex): StatusResponse | null {
  const tx = state.txs.get(txHash);
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
