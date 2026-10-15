// The M1a local approval channel (06 §2.5, D-73 (3)): request() returns a ticket with no URL;
// status() is `pending` or `unknown`, never `signed`, and fails closed.
import { MemoryStore, type Sealed, type Store } from '@agentlink/core';
import { encodeBase64url, randomBytes } from '@agentlink/crypto';
import { describe, expect, it } from 'vitest';
import {
  createLocalApprovalChannel,
  storeApprovalReader,
  type ApprovalRowReader,
  type ApprovalRowView,
} from './local-channel.js';

const NOW = 1_800_000_000;
const newId = (): string => `apr_${encodeBase64url(randomBytes(16))}`;
const digest = (): string =>
  Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');

/** A sealed placeholder: the channel never opens `enc` columns. */
const sealed = (label: string): Sealed => `test-sealed:${label}` as Sealed;

type Status = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'void';

async function insertRow(
  store: Store,
  over: {
    status?: Status;
    expiresAt?: number;
    signedDecision?: string | null;
    signedCancel?: string | null;
  } = {},
): Promise<string> {
  const approvalId = newId();
  await store.transaction((tx) =>
    tx.insert('approvals', {
      approval_id: approvalId,
      action_json: sealed('action'),
      scope_json: null,
      answers_envelope_id: null,
      scope_key: null,
      source: 'owner',
      policy_hash: null,
      signed_decision: over.signedDecision ?? null,
      signed_cancel: over.signedCancel ?? null,
      summary: sealed('summary'),
      status: over.status ?? 'pending',
      expires_at: over.expiresAt ?? NOW + 3_600,
      created_at: NOW - 60,
      decided_at: null,
    }),
  );
  return approvalId;
}

function setup(clock: () => number = () => NOW) {
  const store = new MemoryStore();
  const channel = createLocalApprovalChannel({ reader: storeApprovalReader(store), clock });
  return { store, channel };
}

const SIGNED = JSON.stringify({ forged: true });

describe('LocalApprovalChannel.request (06 §2.5 step 1)', () => {
  it('returns only the approval ID, with no URL, and writes nothing', async () => {
    const { store, channel } = setup();
    const approvalId = newId();
    const ticket = await channel.request({
      approvalId,
      actionDigest: digest(),
      summary: 'Send a file to Ana',
      expiresAt: NOW + 86_400,
    });
    expect(ticket).toEqual({ approvalId });
    expect(Object.keys(ticket)).toEqual(['approvalId']);
    expect(await store.transaction((tx) => tx.count('approvals'))).toBe(0);
  });

  it('refuses an approval ID that is not canonical', async () => {
    const { channel } = setup();
    await expect(
      channel.request({
        approvalId: 'apr_x y',
        actionDigest: digest(),
        summary: 's',
        expiresAt: NOW,
      }),
    ).rejects.toThrow();
  });
});

describe('LocalApprovalChannel.status (06 §2.5)', () => {
  it('a live row with no signed decision or cancel is pending', async () => {
    const { store, channel } = setup();
    const id = await insertRow(store);
    expect(await channel.status(id)).toEqual({ state: 'pending' });
  });

  it('a row edited to `approved` without a signed object is still only pending: the status column is a cache', async () => {
    const { store, channel } = setup();
    const id = await insertRow(store);
    await store.transaction((tx) =>
      tx.update('approvals', { approval_id: id }, { status: 'approved', decided_at: NOW }),
    );
    const status = await channel.status(id);
    expect(status).toEqual({ state: 'pending' });
    expect(status.state).not.toBe('signed');
  });

  it('a row with a stored decision or cancel is unknown (the owner process already applied it)', async () => {
    const { store, channel } = setup();
    const decided = await insertRow(store, { signedDecision: SIGNED, status: 'approved' });
    const cancelled = await insertRow(store, { signedCancel: SIGNED, status: 'cancelled' });
    // A decision on a row whose status column was edited back to pending changes nothing.
    const edited = await insertRow(store, { signedDecision: SIGNED, status: 'pending' });
    for (const id of [decided, cancelled, edited]) {
      expect(await channel.status(id)).toEqual({ state: 'unknown' });
    }
  });

  it('an expired row is unknown, at and after its expiry', async () => {
    const { store, channel } = setup();
    const atExpiry = await insertRow(store, { expiresAt: NOW });
    const past = await insertRow(store, { expiresAt: NOW - 1 });
    expect(await channel.status(atExpiry)).toEqual({ state: 'unknown' });
    expect(await channel.status(past)).toEqual({ state: 'unknown' });
  });

  it('an unknown or malformed ID is unknown, and the store is not read for a malformed one', async () => {
    let reads = 0;
    const reader: ApprovalRowReader = {
      read: () => {
        reads += 1;
        return Promise.resolve(undefined);
      },
    };
    const channel = createLocalApprovalChannel({ reader, clock: () => NOW });
    expect(await channel.status(newId())).toEqual({ state: 'unknown' });
    expect(reads).toBe(1);
    for (const bad of ['', 'apr_', 'apr_short', `${newId()}\n`, 'x'.repeat(10_000)]) {
      expect(await channel.status(bad)).toEqual({ state: 'unknown' });
    }
    expect(await channel.status(undefined as unknown as string)).toEqual({ state: 'unknown' });
    expect(reads).toBe(1);
  });

  it('fails closed: a read error, a throwing clock or a malformed row view is unknown', async () => {
    const id = newId();
    const throwing = createLocalApprovalChannel({
      reader: { read: () => Promise.reject(new Error('SQLITE_BUSY')) },
      clock: () => NOW,
    });
    expect(await throwing.status(id)).toEqual({ state: 'unknown' });

    const live: ApprovalRowView = {
      hasSignedDecision: false,
      hasSignedCancel: false,
      expiresAt: NOW + 60,
    };
    const badClock = createLocalApprovalChannel({
      reader: { read: () => Promise.resolve(live) },
      clock: () => {
        throw new Error('clock');
      },
    });
    expect(await badClock.status(id)).toEqual({ state: 'unknown' });

    for (const view of [
      { ...live, expiresAt: Number.NaN },
      { ...live, expiresAt: Number.POSITIVE_INFINITY },
      { ...live, expiresAt: '9999999999' as unknown as number },
      { ...live, hasSignedDecision: 'no' as unknown as boolean },
      { ...live, hasSignedCancel: undefined as unknown as boolean },
    ]) {
      const channel = createLocalApprovalChannel({
        reader: { read: () => Promise.resolve(view) },
        clock: () => NOW,
      });
      expect(await channel.status(id)).toEqual({ state: 'unknown' });
    }
  });

  it('never returns `signed`, for any row', async () => {
    const { store, channel } = setup();
    const ids = [
      await insertRow(store),
      await insertRow(store, { status: 'approved' }),
      await insertRow(store, { signedDecision: SIGNED }),
      await insertRow(store, { signedCancel: SIGNED }),
      await insertRow(store, { expiresAt: NOW - 10 }),
      await insertRow(store, { status: 'void', signedDecision: SIGNED }),
      newId(),
    ];
    for (const id of ids) {
      const status = await channel.status(id);
      expect(['pending', 'unknown']).toContain(status.state);
      expect(status).not.toHaveProperty('signed');
    }
  });
});

describe('the channel object (I-4)', () => {
  it('is frozen and has exactly request and status: no route to a decision', () => {
    const { channel } = setup();
    expect(Object.isFrozen(channel)).toBe(true);
    expect(Object.keys(channel).sort()).toEqual(['request', 'status']);
  });
});
