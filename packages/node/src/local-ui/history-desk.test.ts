// RET-4 (S2; D-148; 04 §4.2 "Presence and undo"; 08 §1 "The delete sheet"): the server-side delete
// ticket. Begin computes the plan on the server and binds its planHash to a ticket of this page
// session; finish (after the central gate verified presence) schedules exactly that plan; the apply
// is deferred for the Undo window, and Undo inside it applies nothing. A plan that changed between
// begin and finish is refused; another session, an unknown nonce or another ID never reaches it.
import type { HistoryDeleteInput, HistoryDeletePlan, HistoryDeleteResult } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import {
  HISTORY_UNDO_MS,
  HistoryDesk,
  parseHistorySelection,
  type HistoryPort,
} from './history-desk.js';

const ALICE = `0x${'a'.repeat(40)}`;
const NOW_MS = 1_800_000_000_000;

function planOf(input: HistoryDeleteInput, hash: string): HistoryDeletePlan {
  return {
    input,
    include: input.include,
    planHash: hash,
    envelopeIds: ['e1', 'e2'],
    messages: { count: 2, bytes: 2048 },
    notarized: 0,
    files: { count: 1, bytes: 4096 },
    savedFiles: [{ envelopeId: 'e1', index: 0 }],
    kept: { count: 1, by: { pairing: 1, terms: 0, approval: 0, outbox: 0, ledger: 0, receipt: 0 } },
    truncated: false,
  };
}

const RESULT: HistoryDeleteResult = {
  messages: { deleted: 2, notarized: 0, kept: 0 },
  files: { trashed: 1, changed: 0, missing: 0, refused: 0, noTrash: 0, failed: 0 },
};

interface World {
  readonly desk: HistoryDesk;
  readonly applied: HistoryDeletePlan[];
  readonly planned: HistoryDeleteInput[];
  readonly timers: Map<number, () => void>;
  hash: string;
  agentId: string;
  fire(): Promise<void>;
}

function world(): World {
  const applied: HistoryDeletePlan[] = [];
  const planned: HistoryDeleteInput[] = [];
  const timers = new Map<number, () => void>();
  let seq = 0;
  const w = {
    applied,
    planned,
    timers,
    hash: 'h1',
    agentId: 'agent-1',
  } as World & { desk: HistoryDesk };
  const port = (): HistoryPort => ({
    agentId: w.agentId,
    plan: (input) => {
      planned.push(input);
      return Promise.resolve(planOf(input, w.hash));
    },
    apply: (plan) => {
      applied.push(plan);
      return Promise.resolve(RESULT);
    },
  });
  (w as { desk: HistoryDesk }).desk = new HistoryDesk({
    current: () => port(),
    now: () => NOW_MS,
    setTimer: (fn, ms) => {
      expect(ms).toBe(HISTORY_UNDO_MS);
      seq += 1;
      timers.set(seq, fn);
      return seq;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  });
  w.fire = async () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  return w;
}

describe('parseHistorySelection (begin body)', () => {
  it('maps a person, an age and what to remove to one core selector', () => {
    expect(parseHistorySelection({ contact: ALICE, include: 'both' }, NOW_MS)).toEqual({
      contactId: ALICE,
      include: 'both',
    });
    expect(parseHistorySelection({ olderThanDays: 30, include: 'files' }, NOW_MS)).toEqual({
      before: NOW_MS / 1000 - 30 * 86_400,
      include: 'files',
    });
    expect(
      parseHistorySelection({ contact: ALICE, olderThanDays: 90, include: 'messages' }, NOW_MS),
    ).toEqual({ contactId: ALICE, before: NOW_MS / 1000 - 90 * 86_400, include: 'messages' });
    expect(parseHistorySelection({ envelopeIds: ['e1', 'e2'], include: 'both' }, NOW_MS)).toEqual(
      { envelopeIds: ['e1', 'e2'], include: 'both' },
    );
  });

  it('refuses anything else (fixed shape, no extra keys)', () => {
    for (const bad of [
      {},
      { include: 'both' },
      { contact: ALICE },
      { contact: ALICE, include: 'all' },
      { contact: 'Alice', include: 'both' },
      { contact: ALICE, include: 'both', path: '/tmp' },
      { olderThanDays: 0, include: 'both' },
      { olderThanDays: 1.5, include: 'both' },
      { olderThanDays: 100_000, include: 'both' },
      { envelopeIds: [], include: 'both' },
      { envelopeIds: ['../x'], include: 'both' },
      { envelopeIds: ['e1'], contact: ALICE, include: 'both' },
      { envelopeIds: Array.from({ length: 501 }, (_, i) => `e${String(i)}`), include: 'both' },
    ]) {
      expect(parseHistorySelection(bad, NOW_MS)).toBeUndefined();
    }
  });
});

describe('HistoryDesk: begin binds the server plan to a ticket', () => {
  it('answers counts, sizes and a nonce, never the item list or the hash', async () => {
    const w = world();
    const begun = await w.desk.forSession('cookie-a').begin({ contact: ALICE, include: 'both' });
    expect(begun.status).toBe('planned');
    if (begun.status !== 'planned') return;
    expect(begun.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(begun.messages).toEqual({ count: 2, bytes: 2048 });
    expect(begun.files).toEqual({ count: 1, bytes: 4096 });
    expect(begun.kept).toBe(1);
    expect(begun.undoSeconds).toBe(10);
    expect(JSON.stringify(begun)).not.toContain('h1');
    expect(JSON.stringify(begun)).not.toContain('e1');
    expect(w.applied).toEqual([]);
  });

  it('refuses an invalid body before planning', async () => {
    const w = world();
    expect(await w.desk.forSession('c').begin({ contact: ALICE })).toEqual({ status: 'invalid' });
    expect(w.planned).toEqual([]);
  });
});

describe('HistoryDesk: finish, the deferred apply and Undo', () => {
  it('finish schedules exactly the bound plan; it applies only when the Undo window ends', async () => {
    const w = world();
    const s = w.desk.forSession('cookie-a');
    const begun = await s.begin({ contact: ALICE, include: 'both' });
    if (begun.status !== 'planned') throw new Error('not planned');
    expect(await s.finish(begun.nonce)).toBe('scheduled');
    expect(w.applied).toEqual([]);
    expect(await s.status(begun.nonce)).toEqual({ status: 'scheduled' });
    await w.fire();
    expect(w.applied).toHaveLength(1);
    expect(w.applied[0]?.planHash).toBe('h1');
    expect(w.applied[0]?.input).toEqual({ contactId: ALICE, include: 'both' });
    expect(await s.status(begun.nonce)).toEqual({ status: 'done', result: RESULT });
    // A ticket runs once.
    expect(await s.finish(begun.nonce)).toBe('not_found');
  });

  it('Undo within the window applies nothing', async () => {
    const w = world();
    const s = w.desk.forSession('cookie-a');
    const begun = await s.begin({ contact: ALICE, include: 'both' });
    if (begun.status !== 'planned') throw new Error('not planned');
    expect(await s.finish(begun.nonce)).toBe('scheduled');
    expect(await s.undo(begun.nonce)).toBe('cancelled');
    expect(w.timers.size).toBe(0);
    await w.fire();
    expect(w.applied).toEqual([]);
    expect(await s.status(begun.nonce)).toEqual({ status: 'cancelled' });
    expect(await s.finish(begun.nonce)).toBe('not_found');
  });

  it('Undo after the apply is too late (and says so)', async () => {
    const w = world();
    const s = w.desk.forSession('cookie-a');
    const begun = await s.begin({ contact: ALICE, include: 'files' });
    if (begun.status !== 'planned') throw new Error('not planned');
    await s.finish(begun.nonce);
    await w.fire();
    expect(await s.undo(begun.nonce)).toBe('too_late');
    expect(w.applied).toHaveLength(1);
  });

  it('a stale plan (the list changed since it was shown) is refused at finish', async () => {
    const w = world();
    const s = w.desk.forSession('cookie-a');
    const begun = await s.begin({ contact: ALICE, include: 'both' });
    if (begun.status !== 'planned') throw new Error('not planned');
    w.hash = 'h2';
    expect(await s.finish(begun.nonce)).toBe('changed');
    await w.fire();
    expect(w.applied).toEqual([]);
    expect(await s.status(begun.nonce)).toEqual({ status: 'changed' });
  });

  it('another page session, an unknown nonce or another ID never finishes or undoes it', async () => {
    const w = world();
    const s = w.desk.forSession('cookie-a');
    const begun = await s.begin({ contact: ALICE, include: 'both' });
    if (begun.status !== 'planned') throw new Error('not planned');
    const other = w.desk.forSession('cookie-b');
    expect(await other.finish(begun.nonce)).toBe('not_found');
    expect(await other.status(begun.nonce)).toEqual({ status: 'not_found' });
    expect(await s.finish('A'.repeat(43))).toBe('not_found');
    w.agentId = 'agent-2';
    expect(await s.finish(begun.nonce)).toBe('agent_changed');
    await w.fire();
    expect(w.applied).toEqual([]);
  });

  it('a switch to another ID during the window applies nothing', async () => {
    const w = world();
    const s = w.desk.forSession('cookie-a');
    const begun = await s.begin({ contact: ALICE, include: 'both' });
    if (begun.status !== 'planned') throw new Error('not planned');
    expect(await s.finish(begun.nonce)).toBe('scheduled');
    expect(await w.desk.forSession('cookie-b').undo(begun.nonce)).toBe('not_found');
    w.agentId = 'agent-2';
    await w.fire();
    expect(w.applied).toEqual([]);
    expect(await s.status(begun.nonce)).toEqual({ status: 'agent_changed' });
  });

  it('close drops every waiting delete (nothing applied)', async () => {
    const w = world();
    const s = w.desk.forSession('cookie-a');
    const begun = await s.begin({ contact: ALICE, include: 'both' });
    if (begun.status !== 'planned') throw new Error('not planned');
    await s.finish(begun.nonce);
    w.desk.close();
    expect(w.timers.size).toBe(0);
    expect(w.applied).toEqual([]);
  });
});
