// M1-7e: `clientRequestId` idempotency (06 §1 rule 6; 07 §3.3). One row per (tool,
// clientRequestId, approvalId): an execution lease, a compare-and-set on every effect and on the
// finish, `IDEMPOTENCY_KEY_REUSED` for another request under the same key, a keyed request digest,
// and a stale `pending_approval` that is reported as the approval's current state, never replayed.
import {
  canonicalize,
  encodeHex,
  encodeUtf8,
  hmacSha256,
  sha256,
  type JsonObject,
} from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import {
  IDEMPOTENCY_KEY_REUSED,
  IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_MIN_RETENTION_SECONDS,
} from './constants.js';
import { CoreError } from './errors.js';
import { computeActionDigest } from './owner-action.js';
import { MemoryStore } from './store/memory-store.js';
import type { StoreCipher } from './store/store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TEST_INDEX_KEY,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from './testing/owner.js';

const TOOL = 'agentlink_send';
const ARGS = { to: 'Bob', text: 'hello' };
const RESULT = { status: 'ok', summary: 'Sent to Bob.', envelopeId: 'CWwS0akF74XyLhggaFDzZQ' };

async function setup(cipher: StoreCipher = new TestStoreCipher()) {
  const owner = new MemoryOwnerKeyStore(seed(121), passphrase());
  const store = new MemoryStore();
  const clock = new FakeClock();
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(11)),
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    policyMark: new MemoryPolicyMark(),
  });
  const session = await owner.unlock(passphrase());
  await client.identity.init({
    owner: session,
    ownerKeys: await owner.getPublicKeys(),
    name: 'Agent',
    relays: RELAYS,
  });
  await session.close();
  const OWNER = await ownerHex(owner);
  const idem = client.idempotency;
  const key = (
    over: Partial<{ clientRequestId: string; approvalId: string; args: unknown }> = {},
  ) => ({
    tool: TOOL,
    clientRequestId: 'req-1',
    args: ARGS,
    ...over,
  });
  const row = (approvalId = '') =>
    store.transaction((tx) =>
      tx.get('idempotency', { tool: TOOL, client_request_id: 'req-1', approval_id: approvalId }),
    );
  const decide = async (approvalId: string, action: unknown) =>
    client.ownerActions.apply(
      JSON.stringify(
        await signWith(owner, {
          v: 1,
          agent: client.agentId,
          owner: OWNER,
          op: 'approval.decide',
          params: { approvalId, actionDigest: computeActionDigest(action), decision: 'approve' },
          nonce: newNonce(),
          issuedAt: clock.t,
          expiresAt: clock.t + 600,
        }),
      ),
    );
  return { client, store, clock, idem, key, row, decide };
}

const exportAction = (): JsonObject => ({
  tool: 'agentlink_export_proof_pack',
  args: { recordId: '0x01', includeKey: true },
  context: {
    triggers: ['proofs.allowKeyDisclosure'],
    recordId: `0x${'ab'.repeat(32)}`,
    envelopeHash: `0x${'cd'.repeat(32)}`,
  },
});

describe('start (07 §3.3)', () => {
  it('a first call inserts a running row with a lease and a keyed digest, never a plain hash', async () => {
    const t = await setup();
    const start = await t.idem.begin(t.key());
    expect(start.kind).toBe('run');
    const row = await t.row();
    const keyed = encodeHex(hmacSha256(TEST_INDEX_KEY, encodeUtf8(canonicalize(ARGS))));
    expect(row).toMatchObject({
      state: 'running',
      request_digest: keyed,
      lease_until: t.clock.t + IDEMPOTENCY_LEASE_SECONDS,
      effect_ref: null,
      result_json: null,
      created_at: t.clock.t,
      expires_at: t.clock.t + IDEMPOTENCY_MIN_RETENTION_SECONDS,
    });
    expect(row?.request_digest).not.toBe(encodeHex(sha256(encodeUtf8(canonicalize(ARGS)))));
    expect(row?.run_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('a repeat after finish returns the identical result and runs nothing', async () => {
    const t = await setup();
    const start = await t.idem.begin(t.key());
    if (start.kind !== 'run') throw new Error('expected run');
    expect(await t.idem.finish(start.run, RESULT)).toBe(true);
    const row = await t.row();
    expect(row?.state).toBe('done');
    expect(row?.result_json).not.toContain('Sent to Bob');
    const again = await t.idem.begin(t.key());
    expect(again).toEqual({ kind: 'replay', result: RESULT });
    // The args are compared as JCS: key order does not make it another request.
    expect(await t.idem.begin(t.key({ args: { text: 'hello', to: 'Bob' } }))).toEqual({
      kind: 'replay',
      result: RESULT,
    });
  });

  it('the same key with other args runs nothing and returns IDEMPOTENCY_KEY_REUSED, with no data', async () => {
    const t = await setup();
    const start = await t.idem.begin(t.key());
    if (start.kind !== 'run') throw new Error('expected run');
    expect(await t.idem.begin(t.key({ args: { to: 'Bob', text: 'other' } }))).toEqual({
      kind: 'key_reused',
      code: IDEMPOTENCY_KEY_REUSED,
    });
    await t.idem.finish(start.run, RESULT);
    expect(await t.idem.begin(t.key({ args: { to: 'Eve', text: 'hello' } }))).toEqual({
      kind: 'key_reused',
      code: IDEMPOTENCY_KEY_REUSED,
    });
  });

  it('while another execution holds the lease, the call is in progress', async () => {
    const t = await setup();
    await t.idem.begin(t.key());
    t.clock.t += IDEMPOTENCY_LEASE_SECONDS - 1;
    expect(await t.idem.begin(t.key())).toEqual({ kind: 'in_progress' });
  });

  it('two concurrent first calls: exactly one runs', async () => {
    const t = await setup();
    const starts = await Promise.all([
      t.idem.begin(t.key()),
      t.idem.begin(t.key()),
      t.idem.begin(t.key()),
    ]);
    expect(starts.filter((s) => s.kind === 'run')).toHaveLength(1);
    expect(starts.filter((s) => s.kind === 'in_progress')).toHaveLength(2);
  });

  it('a retry with an approvalId is a new call (its own row)', async () => {
    const t = await setup();
    const first = await t.idem.begin(t.key());
    if (first.kind !== 'run') throw new Error('expected run');
    await t.idem.finish(first.run, RESULT);
    const withApproval = await t.idem.begin(t.key({ approvalId: 'apr_AAAAAAAAAAAAAAAAAAAAAA' }));
    expect(withApproval.kind).toBe('run');
  });

  it('fails closed without a keyed digest: nothing runs', async () => {
    const plain = new TestStoreCipher();
    const cipher: StoreCipher = {
      seal: (c, p) => plain.seal(c, p),
      open: (c, s) => plain.open(c, s),
    };
    const t = await setup(cipher);
    const error = await t.idem.begin(t.key()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe('idempotency_unavailable');
    expect(await t.store.transaction((tx) => tx.count('idempotency'))).toBe(0);
  });

  it('refuses a key it cannot hold, with a fixed message', async () => {
    const t = await setup();
    const error = await t.idem.begin(t.key({ args: { n: 10n } })).catch((e: unknown) => e);
    expect((error as CoreError).code).toBe('idempotency_args_invalid');
  });
});

describe('lease, effects and takeover (07 §3.3, IR-G-9-1 H-1)', () => {
  it('an effect commits only with the compare-and-set on the own run', async () => {
    const t = await setup();
    const start = await t.idem.begin(t.key());
    if (start.kind !== 'run') throw new Error('expected run');
    const prepared = await t.idem.prepareEffect(start.run, ['env-1']);
    expect(await t.store.transaction((tx) => t.idem.effectTx(tx, start.run, prepared))).toBe(true);
    t.idem.committed(start.run, prepared);
    expect(start.run.effects).toEqual(['env-1']);
    expect((await t.row())?.effect_ref).not.toBeNull();
  });

  it('after the lease lapses another execution takes over; the old one can no longer write', async () => {
    const t = await setup();
    const old = await t.idem.begin(t.key());
    if (old.kind !== 'run') throw new Error('expected run');
    t.clock.t += IDEMPOTENCY_LEASE_SECONDS;
    const taken = await t.idem.begin(t.key());
    expect(taken.kind).toBe('run');
    if (taken.kind !== 'run') return;
    expect(taken.run.runId).not.toBe(old.run.runId);
    const prepared = await t.idem.prepareEffect(old.run, ['env-old']);
    expect(await t.store.transaction((tx) => t.idem.effectTx(tx, old.run, prepared))).toBe(false);
    expect(await t.idem.finish(old.run, RESULT)).toBe(false);
    expect(await t.idem.renew(old.run)).toBe(false);
    expect(await t.idem.finish(taken.run, RESULT)).toBe(true);
  });

  it('an effect transaction at or after the lease end aborts, even with no takeover', async () => {
    const t = await setup();
    const start = await t.idem.begin(t.key());
    if (start.kind !== 'run') throw new Error('expected run');
    const prepared = await t.idem.prepareEffect(start.run, ['env-1']);
    t.clock.t += IDEMPOTENCY_LEASE_SECONDS;
    expect(await t.store.transaction((tx) => t.idem.effectTx(tx, start.run, prepared))).toBe(false);
  });

  it('renew extends the lease for the own run', async () => {
    const t = await setup();
    const start = await t.idem.begin(t.key());
    if (start.kind !== 'run') throw new Error('expected run');
    t.clock.t += 20;
    expect(await t.idem.renew(start.run)).toBe(true);
    expect((await t.row())?.lease_until).toBe(t.clock.t + IDEMPOTENCY_LEASE_SECONDS);
  });

  it('a takeover with stored effects resumes from them instead of running again', async () => {
    const t = await setup();
    const old = await t.idem.begin(t.key());
    if (old.kind !== 'run') throw new Error('expected run');
    const prepared = await t.idem.prepareEffect(old.run, ['env-1', 'rec-1']);
    await t.store.transaction((tx) => t.idem.effectTx(tx, old.run, prepared));
    t.clock.t += IDEMPOTENCY_LEASE_SECONDS;
    const resumed = await t.idem.begin(t.key());
    expect(resumed.kind).toBe('resume');
    if (resumed.kind !== 'resume') return;
    expect(resumed.run.effects).toEqual(['env-1', 'rec-1']);
  });
});

describe('finish (07 §3.3 "Which results are kept")', () => {
  it('a result without any effect that is not kept deletes the row, so a retry runs', async () => {
    const t = await setup();
    const start = await t.idem.begin(t.key());
    if (start.kind !== 'run') throw new Error('expected run');
    expect(await t.idem.finish(start.run, { status: 'error' }, { keep: false })).toBe(true);
    expect(await t.row()).toBeUndefined();
    expect((await t.idem.begin(t.key())).kind).toBe('run');
  });

  it('a result with an effect is kept even when asked not to', async () => {
    const t = await setup();
    const start = await t.idem.begin(t.key());
    if (start.kind !== 'run') throw new Error('expected run');
    const prepared = await t.idem.prepareEffect(start.run, ['env-1']);
    await t.store.transaction((tx) => t.idem.effectTx(tx, start.run, prepared));
    t.idem.committed(start.run, prepared);
    const result = { status: 'error', code: 'X' };
    expect(await t.idem.finish(start.run, result, { keep: false })).toBe(true);
    expect(await t.idem.begin(t.key())).toEqual({ kind: 'replay', result });
  });

  it('a kept pending_approval is replayed while the approval is pending, and never after', async () => {
    const t = await setup();
    const action = exportAction();
    const start = await t.idem.begin(t.key({ args: action.args }));
    if (start.kind !== 'run') throw new Error('expected run');
    const pending = await t.client.approvalService.request(
      { action, summary: 'Include the document key in an export' },
      { run: start.run },
    );
    expect(start.run.effects).toEqual([pending.approvalId]);
    await t.idem.finish(start.run, pending);
    // The row lives at least until the approval has expired, plus S.
    const row = await t.row();
    expect(row?.expires_at).toBe(
      Math.max(t.clock.t + IDEMPOTENCY_MIN_RETENTION_SECONDS, pending.expiresAt + 300),
    );
    expect(await t.idem.begin(t.key({ args: action.args }))).toEqual({
      kind: 'replay',
      result: pending,
    });
    await t.decide(pending.approvalId, action);
    expect(await t.idem.begin(t.key({ args: action.args }))).toEqual({
      kind: 'stale_approval',
      approvalId: pending.approvalId,
    });
  });

  it('a request made under a lost lease is not created', async () => {
    const t = await setup();
    const start = await t.idem.begin(t.key());
    if (start.kind !== 'run') throw new Error('expected run');
    t.clock.t += IDEMPOTENCY_LEASE_SECONDS;
    await t.idem.begin(t.key());
    const error = await t.client.approvalService
      .request({ action: exportAction(), summary: 'Export' }, { run: start.run })
      .catch((e: unknown) => e);
    expect((error as CoreError).code).toBe('idempotency_lost');
    expect(await t.store.transaction((tx) => tx.count('approvals'))).toBe(0);
  });
});
