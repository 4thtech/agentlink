// E2E-HOSTILE, refused sends and parallel proof requests (04 §3.4; 07 §3.5, §5.6;
// SEC-REFUSED-UPLOAD-CLEANUP, SEC-RECORD-ATOMIC, D-156):
//
// - a send with a file that the owner's rules refuse after the file was stored deletes the stored
//   copy, so a refused send leaves nothing on the encrypted drop and no row pointing to it;
// - proof requests that arrive at the same moment for one message sign one Record, submit it once and
//   charge its fee once; and parallel requests over a budget never go past it.
//
// The drop is the in-memory drop of src/fake-drop.mjs (the drop's HTTP protocol, the real adapter on
// the agent's side); the chain is the core's in-memory Notary. Temp folders only.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDrop } from '../src/fake-drop.mjs';
import { FEE_UNITS, editPolicy, ownerApprove } from '../prompt-injection/harness.js';
import { scene, type Scene } from './support.js';

let current: Scene | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe('a refused send deletes what it uploaded (SEC-REFUSED-UPLOAD-CLEANUP)', () => {
  const SIZE = 200_000;
  const uploads = (drop: ReturnType<typeof createFakeDrop>): number =>
    drop.seen.filter((r: { method: string; path: string }) => r.path === '/v1/upload').length;

  it('the owner’s size rule refuses the finished envelope: no object is left on the drop and no file row is kept', async () => {
    const drop = createFakeDrop();
    const s = (current = await scene({ drop: { endpoint: drop.origin, fetch: drop.fetch } }));
    const folder = join(s.ana.home, 'Work');
    await mkdir(folder, { recursive: true });
    await editPolicy(s.ana, (p) => {
      p.files.allowedFolders = [folder];
    });
    const file = (name: string) => ({
      realpath: join(folder, name),
      size: SIZE,
      mime: 'application/pdf',
      open: () => Promise.resolve(new Uint8Array(SIZE).fill(7)),
    });
    const to = s.mallory.client.agentId;

    // Control: an allowed send stores one object and keeps its row.
    const sent = await s.ana.client.sendMessage({
      to,
      text: 'the report',
      files: [file('a.pdf')],
    } as never);
    expect(sent).toMatchObject({ status: 'ok' });
    expect(drop.objects.size).toBe(1);
    const keptRows = (await s.ana.store.transaction((tx) => tx.select('files', {}))).length;
    const uploadsBefore = uploads(drop);

    // The owner lowers the envelope size rule: the next send is refused after its upload.
    await editPolicy(s.ana, (p) => {
      (p['envelopes'] as Record<string, unknown>)['maxEnvelopeKB'] = 1;
    });
    const refused = await s.ana.client.sendMessage({
      to,
      text: 'the report',
      files: [file('b.pdf')],
    } as never);
    expect(refused).toMatchObject({ status: 'rejected', code: 'POLICY_DENIED' });
    expect(uploads(drop), 'the file was stored before the refusal').toBe(uploadsBefore + 1);
    expect(drop.objects.size, 'the stored copy was deleted').toBe(1);
    expect((await s.ana.store.transaction((tx) => tx.select('files', {}))).length).toBe(keptRows);
    const out = await s.ana.store.transaction((tx) =>
      tx.select('envelopes', { direction: 'out', type: 'text' } as never),
    );
    expect(out).toHaveLength(1);
  });
});

describe('parallel proof requests sign and submit once (SEC-RECORD-ATOMIC)', () => {
  it('three requests at the same moment for one message: one Record signed, one submission, one fee', async () => {
    const s = (current = await scene());
    const sent = await s.ana.call('agentlink_send', { to: 'Mallory', text: 'prove this one' });
    const envelopeId = String(sent.structured['envelopeId']);
    const results = await Promise.all([1, 2, 3].map(() => s.ana.client.notarize({ envelopeId })));
    for (const r of results) expect(['ok', 'submitted']).toContain(r.status);
    expect(new Set(results.map((r) => (r as { recordId?: string }).recordId)).size).toBe(1);
    expect(s.world.chain.calls.notarize).toBe(1);
    expect(s.world.chain.creditOf(s.ana.client.agentId)).toBe(9n * FEE_UNITS);
    const [proofs, ledger] = await s.ana.store.transaction((tx) => [
      tx.select('proofs', {}),
      tx.select('budget_ledger', {}),
    ]);
    expect(proofs).toHaveLength(1);
    expect(ledger).toHaveLength(1);
  });

  it('a clock that ticks between reads: three parallel requests for one message still share one Record, one fee', async () => {
    const s = (current = await scene({ tickingClock: true }));
    const sent = await s.ana.call('agentlink_send', { to: 'Mallory', text: 'prove this one too' });
    const envelopeId = String(sent.structured['envelopeId']);
    const results = await Promise.all([1, 2, 3].map(() => s.ana.client.notarize({ envelopeId })));
    // The requests reuse the one Record, with one submission and one fee.
    for (const r of results) expect(['ok', 'submitted']).toContain(r.status);
    expect(new Set(results.map((r) => (r as { recordId?: string }).recordId)).size).toBe(1);
    expect(s.world.chain.calls.notarize).toBe(1);
    expect(s.world.chain.creditOf(s.ana.client.agentId)).toBe(9n * FEE_UNITS);
    const [proofs, ledger] = await s.ana.store.transaction((tx) => [
      tx.select('proofs', {}),
      tx.select('budget_ledger', {}),
    ]);
    expect(proofs).toHaveLength(1);
    expect(ledger).toHaveLength(1);
  });

  it('parallel requests for several messages under a one-proof budget: never more than one proof is signed, submitted and charged', async () => {
    const s = (current = await scene());
    await editPolicy(s.ana, (p) => {
      (p['proofs'] as Record<string, unknown>)['dailyBudgetUSD'] = '0.15';
      (p['proofs'] as Record<string, unknown>)['hardDailyUSD'] = '0.15';
    });
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      const sent = await s.ana.call('agentlink_send', { to: 'Mallory', text: `note ${String(n)}` });
      ids.push(String(sent.structured['envelopeId']));
    }
    const results = await Promise.all(
      ids.map((envelopeId) => s.ana.client.notarize({ envelopeId })),
    );
    // The safety property, not the mix of refusals: one paid proof, nothing else charged.
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.status !== 'ok')).toHaveLength(ids.length - 1);
    expect(s.world.chain.calls.notarize).toBe(1);
    expect(s.world.chain.creditOf(s.ana.client.agentId)).toBe(9n * FEE_UNITS);
  });
});

describe('a paid action after a restore asks the owner (SEC-RESTORE-GUARD, 04 §2.3.3)', () => {
  /** The restore mark of the victim, set from the test: 0 is "never restored". */
  const mark = { value: 0 };
  const restoredScene = () =>
    scene({ anaRestoreMark: { read: () => Promise.resolve(mark.value) } });

  it('a proof under the normal thresholds is done without asking before the restore, and asks the owner after it', async () => {
    mark.value = 0;
    const s = (current = await restoredScene());
    const idOf = async (text: string) =>
      String(
        (await s.ana.call('agentlink_send', { to: 'Mallory', text })).structured['envelopeId'],
      );
    const first = await idOf('before');
    const second = await idOf('after');
    // Control: well under the per-proof limit and the daily budget, so no question is asked.
    expect(await s.ana.client.notarize({ envelopeId: first })).toMatchObject({ status: 'ok' });
    expect(s.world.chain.calls.notarize).toBe(1);

    mark.value = Math.floor(Date.now() / 1000);
    const asked = await s.ana.client.notarize({ envelopeId: second });
    expect(asked.status).toBe('pending_approval');
    expect(s.world.chain.calls.notarize, 'nothing was signed or submitted').toBe(1);
    expect(s.world.chain.creditOf(s.ana.client.agentId)).toBe(9n * FEE_UNITS);
  });

  it('an approval the owner gave before the restore does not authorise the proof afterwards', async () => {
    mark.value = 0;
    const s = (current = await restoredScene());
    await editPolicy(s.ana, (p) => {
      (p['proofs'] as Record<string, unknown>)['notarize'] = 'approval';
    });
    const sent = await s.ana.call('agentlink_send', { to: 'Mallory', text: 'approved earlier' });
    const envelopeId = String(sent.structured['envelopeId']);
    const asked = await s.ana.client.notarize({ envelopeId });
    expect(asked.status).toBe('pending_approval');
    const approvalId = String((asked as { approvalId?: string }).approvalId);
    await ownerApprove(s.ana, approvalId);

    // The ID is restored from a backup; the owner's earlier approval is older than the restore.
    mark.value = Math.floor(Date.now() / 1000);
    const used = await s.ana.client.notarize({ envelopeId, approvalId });
    expect(used).toMatchObject({ status: 'rejected', code: 'APPROVAL_INVALID' });
    expect(s.world.chain.calls.notarize).toBe(0);
    expect(s.world.chain.creditOf(s.ana.client.agentId)).toBe(10n * FEE_UNITS);
  });

  it('an approval given just after the restore time, inside the clock-skew allowance, is not taken either', async () => {
    // The approval is asked for and given while the guard is already on, with the same card, so
    // only its time against the restore mark can refuse it.
    mark.value = 0;
    const s = (current = await restoredScene());
    const sent = await s.ana.call('agentlink_send', { to: 'Mallory', text: 'asked at once' });
    const envelopeId = String(sent.structured['envelopeId']);
    mark.value = Math.floor(Date.now() / 1000);
    const asked = await s.ana.client.notarize({ envelopeId });
    expect(asked.status).toBe('pending_approval');
    const approvalId = String((asked as { approvalId?: string }).approvalId);
    await ownerApprove(s.ana, approvalId);
    const used = await s.ana.client.notarize({ envelopeId, approvalId });
    expect(used).toMatchObject({ status: 'rejected', code: 'APPROVAL_INVALID' });
    expect(s.world.chain.calls.notarize).toBe(0);
  });
});

describe('a request over the hard ceiling is refused, never offered for approval (D-156)', () => {
  it('over the per-proof ceiling: refused with the ceiling named, no approval is created, and no later approval lets it through', async () => {
    const s = (current = await scene());
    // The owner asks for each proof and approves one; then lowers the hard ceiling below the fee.
    await editPolicy(s.ana, (p) => {
      (p['proofs'] as Record<string, unknown>)['notarize'] = 'approval';
    });
    const sent = await s.ana.call('agentlink_send', { to: 'Mallory', text: 'too dear' });
    const envelopeId = String(sent.structured['envelopeId']);
    const asked = await s.ana.client.notarize({ envelopeId });
    expect(asked.status).toBe('pending_approval');
    const approvalId = String((asked as { approvalId?: string }).approvalId);
    await ownerApprove(s.ana, approvalId);
    const approvalRows = () => s.ana.store.transaction((tx) => tx.select('approvals', {}));
    const approvalsBefore = (await approvalRows()).length;

    await editPolicy(s.ana, (p) => {
      (p['proofs'] as Record<string, unknown>)['hardMaxPerActionUSD'] = '0.01';
      (p['proofs'] as Record<string, unknown>)['perActionMaxUSD'] = '0.01';
    });
    const refused = await s.ana.client.notarize({ envelopeId });
    expect(refused).toMatchObject({
      status: 'rejected',
      code: 'SPEND_CEILING',
      ceiling: 'per_action',
    });
    const viaTool = await s.ana.call('agentlink_notarize', { envelopeId });
    expect(viaTool.structured).toMatchObject({ status: 'rejected', code: 'SPEND_CEILING' });
    // The owner's earlier approval, used now, changes nothing: the ceiling is checked first.
    const approved = await s.ana.client.notarize({ envelopeId, approvalId });
    expect(approved).toMatchObject({ status: 'rejected', code: 'SPEND_CEILING' });

    expect((await approvalRows()).length, 'no approval was offered').toBe(approvalsBefore);
    expect(s.world.chain.calls.notarize).toBe(0);
    expect(s.world.chain.creditOf(s.ana.client.agentId)).toBe(10n * FEE_UNITS);
  });
});
