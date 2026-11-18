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
import { FEE_UNITS, editPolicy } from '../prompt-injection/harness.js';
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
