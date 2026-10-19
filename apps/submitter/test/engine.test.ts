// M1-10a: the submitter's batching rules (05 §3.3 G-4, D-61, D-62; 07 §7 FA-1, FA-3; 04 §7), on the
// engine alone with a fake chain. The Worker around it (HTTP, rate limits, Durable Objects) is
// tested under Miniflare in submitter.test.ts.
import { describe, expect, it } from 'vitest';
import {
  emptyQueueState,
  pollQueue,
  queueDepth,
  submitItems,
  txStatus,
  type EngineHooks,
  type EngineSettings,
  type QueueState,
} from '../src/engine.js';
import {
  FAKE_ITEM_GAS,
  FakeChain,
  fakeBatchGas,
  fakeRecordItem,
  signerAddress,
} from './fake-chain.js';
import { replacementFeePercent } from '../src/engine.js';

const NOTARY = `0x${'4'.repeat(40)}` as const;
const NOW = 1_900_000_000;

const settings = (over: Partial<EngineSettings> = {}): EngineSettings => ({
  gasMargin: 25_000n,
  soloAfterRevertSeconds: 3_600,
  codeSignerMode: 'solo',
  maxBatch: 20,
  retentionSeconds: 86_400,
  maxItemGas: 700_000n,
  stuckAfterSeconds: 180,
  maxReplacements: 3,
  ...over,
});

const noLimits: EngineHooks = { chargeSigners: () => Promise.resolve(new Set<string>()) };

function setup(over: Partial<EngineSettings> = {}) {
  const chain = new FakeChain(84532, NOTARY);
  const state: QueueState = emptyQueueState();
  const s = settings(over);
  return {
    chain,
    state,
    submit: (items: Parameters<typeof submitItems>[3], now = NOW, hooks = noLimits) =>
      submitItems(chain, s, state, items, now, hooks),
    poll: (now = NOW + 10) => pollQueue(chain, s, state, now),
  };
}

const A = signerAddress(1);
const B = signerAddress(2);
const C = signerAddress(3);
const S = signerAddress(4); // a signer with code (ERC-1271 or EIP-7702)

describe('batching and the per-item status', () => {
  it('sends new items from EOA signers in one batch and reports them submitted, then recorded', async () => {
    const t = setup();
    const items = [fakeRecordItem(A), fakeRecordItem(B), fakeRecordItem(C)];
    const results = await t.submit(items);
    expect(results.map((r) => r.status)).toEqual(['submitted', 'submitted', 'submitted']);
    expect(t.chain.sent).toHaveLength(1);
    const tx = t.chain.sent[0];
    expect(tx?.ids).toEqual(items.map((i) => i.id));
    expect(results.every((r) => r.txHash === tx?.hash)).toBe(true);
    t.chain.includeAll();
    await t.poll();
    const status = txStatus(t.state, 84532, tx?.hash as `0x${string}`);
    expect(status?.state).toBe('included');
    expect(status?.items.map((i) => i.status)).toEqual(['recorded', 'recorded', 'recorded']);
    expect(queueDepth(t.state)).toBe(0);
  });

  it('every transaction’s gas limit is its simulated gas plus the configured margin (FA-1)', async () => {
    const t = setup({ gasMargin: 31_337n });
    await t.submit([fakeRecordItem(A), fakeRecordItem(B)]);
    await t.submit([fakeRecordItem(C)]);
    expect(t.chain.sent).toHaveLength(2);
    for (const tx of t.chain.sent) {
      expect(tx.simulatedGas).toBe(fakeBatchGas(tx.ids.length));
      expect(tx.gasLimit).toBe(tx.simulatedGas + 31_337n);
    }
  });

  it('leaves out an item that fails simulation and reports it failed with the error', async () => {
    const t = setup();
    const ok = fakeRecordItem(A);
    const poor = fakeRecordItem(B);
    t.chain.simulationErrors.set(poor.id, 'InsufficientCredits');
    const results = await t.submit([ok, poor]);
    expect(results[1]).toMatchObject({ status: 'failed', error: 'InsufficientCredits' });
    expect(results[1]?.txHash).toBeUndefined();
    expect(t.chain.sent).toHaveLength(1);
    expect(t.chain.sent[0]?.ids).toEqual([ok.id]);
  });

  it('sends nothing when every item fails simulation (credits checked before sending)', async () => {
    const t = setup();
    const poor = fakeRecordItem(A);
    t.chain.simulationErrors.set(poor.id, 'InsufficientCredits');
    const [result] = await t.submit([poor]);
    expect(result).toMatchObject({ status: 'failed', error: 'InsufficientCredits' });
    expect(t.chain.sent).toHaveLength(0);
  });

  it('refuses an invalid EOA signature before simulating or sending', async () => {
    const t = setup();
    t.chain.signatureCheck = 'real'; // the synthetic signature matches nobody
    const [result] = await t.submit([fakeRecordItem(A)]);
    expect(result).toMatchObject({ status: 'failed', error: 'InvalidSignature' });
    expect(t.chain.sent).toHaveLength(0);
  });

  it('refuses an item whose deadline has passed without sending it', async () => {
    const t = setup();
    const [result] = await t.submit([fakeRecordItem(A, NOW - 1)]);
    expect(result).toMatchObject({ status: 'failed', error: 'Expired' });
    expect(t.chain.sent).toHaveLength(0);
  });

  it('splits more items than maxBatch into several transactions', async () => {
    const t = setup({ maxBatch: 2 });
    await t.submit([fakeRecordItem(A), fakeRecordItem(B), fakeRecordItem(C)]);
    expect(t.chain.sent.map((tx) => tx.ids.length)).toEqual([2, 1]);
    expect(t.chain.sent.map((tx) => tx.nonce)).toEqual([7, 8]);
  });

  it('does not send an item twice while it is in flight', async () => {
    const t = setup();
    const item = fakeRecordItem(A);
    const [first] = await t.submit([item]);
    const [again] = await t.submit([item]);
    expect(again).toEqual(first);
    expect(t.chain.sent).toHaveLength(1);
  });
});

describe('items already on-chain (FA-3)', () => {
  it('reports an item already on-chain at simulation as skipped and leaves it out of the calldata', async () => {
    const t = setup();
    const known = fakeRecordItem(A);
    const fresh = fakeRecordItem(B);
    t.chain.onChain.add(known.id);
    const results = await t.submit([known, fresh]);
    expect(results[0]).toEqual({ id: known.id, recordId: known.recordId, status: 'skipped' });
    expect(t.chain.sent).toHaveLength(1);
    expect(t.chain.sent[0]?.ids).toEqual([fresh.id]);
  });

  it('charges the signer limit only for items that are new at simulation', async () => {
    const t = setup();
    const known = fakeRecordItem(A);
    t.chain.onChain.add(known.id);
    const charged: [string, number][] = [];
    const hooks: EngineHooks = {
      chargeSigners: (counts) => {
        charged.push(...counts.entries());
        return Promise.resolve(new Set<string>());
      },
    };
    await t.submit([known, fakeRecordItem(B), fakeRecordItem(B)], NOW, hooks);
    expect(charged).toEqual([[B, 2]]);
  });

  it('fails the items of a signer over its limit, without sending them', async () => {
    const t = setup();
    const hooks: EngineHooks = { chargeSigners: () => Promise.resolve(new Set([B])) };
    const results = await t.submit([fakeRecordItem(A), fakeRecordItem(B)], NOW, hooks);
    expect(results[1]).toMatchObject({ status: 'failed', error: 'rate_limited' });
    expect(t.chain.sent[0]?.signers).toEqual([A]);
  });

  it('reports an item that landed between simulation and inclusion as skipped', async () => {
    const t = setup();
    const item = fakeRecordItem(A);
    const [sent] = await t.submit([item]);
    t.chain.onChain.add(item.id); // someone else's transaction carried it first
    t.chain.includeAll();
    await t.poll();
    expect(txStatus(t.state, 84532, sent?.txHash as `0x${string}`)?.items[0]?.status).toBe(
      'skipped',
    );
  });
});

describe('after an on-chain revert (G-4, D-61, D-62)', () => {
  it('resubmits once without an item that lost its credits; the others are recorded', async () => {
    const t = setup();
    const a = fakeRecordItem(A);
    const b = fakeRecordItem(B);
    const c = fakeRecordItem(C);
    await t.submit([a, b, c]);
    const first = t.chain.sent[0];
    // B spends its credits between simulation and inclusion.
    t.chain.failAtInclusion.add(b.id);
    t.chain.simulationErrors.set(b.id, 'InsufficientCredits');
    t.chain.includeAll();
    await t.poll();
    expect(t.chain.sent).toHaveLength(2);
    const second = t.chain.sent[1];
    expect(second?.ids).toEqual([a.id, c.id]);
    expect(second?.gasLimit).toBe(fakeBatchGas(2) + 25_000n);
    t.chain.includeAll();
    await t.poll();
    const old = txStatus(t.state, 84532, first?.hash as `0x${string}`);
    expect(old?.state).toBe('reverted');
    const byId = new Map(old?.items.map((i) => [i.id, i]));
    expect(byId.get(b.id)).toMatchObject({ status: 'failed', error: 'InsufficientCredits' });
    expect(byId.get(a.id)).toMatchObject({ status: 'recorded', txHash: second?.hash });
    expect(byId.get(c.id)).toMatchObject({ status: 'recorded', txHash: second?.hash });
  });

  it('fails an item that fails twice and never retries it again; the other signer still lands', async () => {
    const t = setup();
    const a = fakeRecordItem(A);
    const b = fakeRecordItem(B);
    await t.submit([a, b]);
    t.chain.failAtInclusion.add(a.id); // passes simulation, reverts at inclusion, every time
    t.chain.includeAll();
    await t.poll();
    // No identifiable cause: the one resubmission is split per signer (M1-10a-b).
    expect(t.chain.sent.slice(1).map((tx) => tx.ids)).toEqual([[a.id], [b.id]]);
    t.chain.includeAll();
    await t.poll();
    await t.poll(NOW + 100);
    expect(t.chain.sent).toHaveLength(3);
    const again = txStatus(t.state, 84532, t.chain.sent[1]?.hash as `0x${string}`);
    expect(again?.state).toBe('reverted');
    expect(again?.items[0]).toMatchObject({ id: a.id, status: 'failed', error: 'reverted' });
    const other = txStatus(t.state, 84532, t.chain.sent[2]?.hash as `0x${string}`);
    expect(other?.items[0]).toMatchObject({ id: b.id, status: 'recorded' });
    expect(queueDepth(t.state)).toBe(0);
  });

  it('M1-10a-b: a shared revert with no identifiable cause resubmits each signer apart, so one diverging signer costs the others nothing', async () => {
    const t = setup();
    const a1 = fakeRecordItem(A);
    const b = fakeRecordItem(B);
    const a2 = fakeRecordItem(A);
    const c = fakeRecordItem(C);
    await t.submit([a1, b, a2, c]);
    expect(t.chain.sent).toHaveLength(1);
    // B diverges at inclusion only, on every transaction that carries it.
    t.chain.failAtInclusion.add(b.id);
    t.chain.includeAll();
    await t.poll(NOW + 10);
    const resent = t.chain.sent.slice(1);
    expect(resent.map((tx) => tx.signers)).toEqual([[A, A], [B], [C]]);
    expect(resent.map((tx) => tx.ids)).toEqual([[a1.id, a2.id], [b.id], [c.id]]);
    t.chain.includeAll();
    await t.poll(NOW + 20);
    await t.poll(NOW + 30);
    expect(t.chain.sent).toHaveLength(4);
    const byId = new Map<string, unknown>();
    for (const tx of resent) {
      for (const item of txStatus(t.state, 84532, tx.hash)?.items ?? []) byId.set(item.id, item);
    }
    expect(byId.get(a1.id)).toMatchObject({ status: 'recorded' });
    expect(byId.get(a2.id)).toMatchObject({ status: 'recorded' });
    expect(byId.get(c.id)).toMatchObject({ status: 'recorded' });
    expect(byId.get(b.id)).toMatchObject({ status: 'failed', error: 'reverted' });
    expect(queueDepth(t.state)).toBe(0);
  });

  it('M1-10a-b: with an identified cause the rest are still resubmitted together, once', async () => {
    const t = setup();
    const a = fakeRecordItem(A);
    const b = fakeRecordItem(B);
    const c = fakeRecordItem(C);
    await t.submit([a, b, c]);
    t.chain.failAtInclusion.add(b.id);
    t.chain.simulationErrors.set(b.id, 'InsufficientCredits');
    t.chain.includeAll();
    await t.poll(NOW + 10);
    expect(t.chain.sent.slice(1).map((tx) => tx.ids)).toEqual([[a.id, c.id]]);
  });

  it('M-1: a solo transaction that reverts while its item still passes simulation is not resent; the signer is refused for a while', async () => {
    const t = setup({ soloAfterRevertSeconds: 600 });
    t.chain.code.add(S);
    const s = fakeRecordItem(S);
    await t.submit([s]);
    t.chain.failAtInclusion.add(s.id); // the account answers differently at inclusion only
    t.chain.includeAll();
    await t.poll(NOW + 10);
    expect(t.chain.sent).toHaveLength(1);
    const status = txStatus(t.state, 84532, t.chain.sent[0]?.hash as `0x${string}`);
    expect(status?.items[0]).toMatchObject({ status: 'failed', error: 'reverted' });
    // Its new items are refused without any chain request or send, until the period ends.
    const [refused] = await t.submit([fakeRecordItem(S)], NOW + 20);
    expect(refused).toMatchObject({ status: 'failed', error: 'signer_refused' });
    expect(t.chain.sent).toHaveLength(1);
    await t.poll(NOW + 10 + 601);
    const [later] = await t.submit([fakeRecordItem(S)], NOW + 10 + 602);
    expect(later?.status).toBe('submitted');
  });

  it('sends a signer that caused a revert alone for soloAfterRevertSeconds', async () => {
    const t = setup({ soloAfterRevertSeconds: 600 });
    const b = fakeRecordItem(B);
    await t.submit([fakeRecordItem(A), b]);
    t.chain.failAtInclusion.add(b.id);
    t.chain.simulationErrors.set(b.id, 'InsufficientCredits');
    t.chain.includeAll();
    await t.poll(NOW + 10);
    t.chain.includeAll();
    await t.poll(NOW + 20);
    const before = t.chain.sent.length;
    // Within the cooling-off: B's new items go alone, A and C still batch together.
    await t.submit([fakeRecordItem(A), fakeRecordItem(B), fakeRecordItem(C)], NOW + 30);
    const fresh = t.chain.sent.slice(before);
    expect(fresh.map((tx) => [...tx.signers].sort())).toEqual([[A, C], [B]]);
    // After it, B batches again.
    const later = t.chain.sent.length;
    await t.submit([fakeRecordItem(A), fakeRecordItem(B)], NOW + 10 + 601);
    expect(t.chain.sent.slice(later).map((tx) => tx.signers)).toEqual([[A, B]]);
  });
});

describe('code-bearing signers (FA-1)', () => {
  it('solo mode: a code-bearing signer is solo from its first item, with no prior revert', async () => {
    const t = setup();
    t.chain.code.add(S);
    const results = await t.submit([
      fakeRecordItem(A),
      fakeRecordItem(S),
      fakeRecordItem(B),
      fakeRecordItem(S),
    ]);
    expect(results.every((r) => r.status === 'submitted')).toBe(true);
    expect(t.chain.sent.map((tx) => tx.signers)).toEqual([
      [A, B],
      [S, S],
    ]);
  });

  it('solo mode: an ERC-1271 answer that changes at inclusion reverts no other signer’s item', async () => {
    const t = setup();
    t.chain.code.add(S);
    const s = fakeRecordItem(S);
    const a = fakeRecordItem(A);
    const b = fakeRecordItem(B);
    await t.submit([a, s, b]);
    t.chain.failAtInclusion.add(s.id); // isValidSignature answers differently at inclusion
    t.chain.simulationErrors.set(s.id, 'InvalidSignature');
    t.chain.includeAll();
    await t.poll();
    const reverted = t.chain.sent.filter(
      (tx) => txStatus(t.state, 84532, tx.hash)?.state === 'reverted',
    );
    expect(reverted).toHaveLength(1);
    expect(reverted[0]?.signers).toEqual([S]);
    const other = t.chain.sent.find((tx) => tx.ids.includes(a.id));
    expect(
      txStatus(t.state, 84532, other?.hash as `0x${string}`)?.items.map((i) => i.status),
    ).toEqual(['recorded', 'recorded']);
  });

  it('one-per-batch mode: at most one code-bearing item per batch', async () => {
    const t = setup({ codeSignerMode: 'one-per-batch' });
    const s1 = signerAddress(5);
    const s2 = signerAddress(6);
    t.chain.code.add(s1);
    t.chain.code.add(s2);
    await t.submit([fakeRecordItem(A), fakeRecordItem(s1), fakeRecordItem(B), fakeRecordItem(s2)]);
    for (const tx of t.chain.sent) {
      expect(tx.signers.filter((x) => x === s1 || x === s2).length).toBeLessThanOrEqual(1);
    }
    expect(t.chain.sent.flatMap((tx) => tx.signers).sort()).toEqual([A, B, s1, s2].sort());
  });

  it('one-per-batch mode: after a revert the others land on the one resubmission without it', async () => {
    const t = setup({ codeSignerMode: 'one-per-batch' });
    t.chain.code.add(S);
    const a = fakeRecordItem(A);
    const s = fakeRecordItem(S);
    const b = fakeRecordItem(B);
    await t.submit([a, s, b]);
    expect(t.chain.sent).toHaveLength(1);
    // The account answers differently at inclusion; its simulation still passes.
    t.chain.failAtInclusion.add(s.id);
    t.chain.includeAll();
    await t.poll();
    expect(t.chain.sent).toHaveLength(2);
    expect(t.chain.sent[1]?.ids).toEqual([a.id, b.id]);
    t.chain.includeAll();
    await t.poll();
    const first = txStatus(t.state, 84532, t.chain.sent[0]?.hash as `0x${string}`);
    const byId = new Map(first?.items.map((i) => [i.id, i.status]));
    expect(byId.get(s.id)).toBe('failed');
    expect(byId.get(a.id)).toBe('recorded');
    expect(byId.get(b.id)).toBe('recorded');
  });
});

describe('a paused Notary (05 §3.3)', () => {
  it('holds items, not failed, and sends them after unpause', async () => {
    const t = setup();
    t.chain.paused = true;
    const item = fakeRecordItem(A, NOW + 1_000);
    const [held] = await t.submit([item]);
    expect(held).toMatchObject({ status: 'held' });
    expect(t.chain.sent).toHaveLength(0);
    expect(queueDepth(t.state)).toBe(1);
    expect(await t.poll(NOW + 100)).toBe(true);
    expect(t.chain.sent).toHaveLength(0);
    t.chain.paused = false;
    await t.poll(NOW + 200);
    expect(t.chain.sent).toHaveLength(1);
    t.chain.includeAll();
    await t.poll(NOW + 300);
    const status = txStatus(t.state, 84532, t.chain.sent[0]?.hash as `0x${string}`);
    expect(status?.items[0]?.status).toBe('recorded');
  });

  it('fails a held item with Expired once its deadline passes', async () => {
    const t = setup();
    t.chain.paused = true;
    await t.submit([fakeRecordItem(A, NOW + 50)]);
    await t.poll(NOW + 51);
    expect(queueDepth(t.state)).toBe(0);
    expect(t.chain.sent).toHaveLength(0);
  });

  it('holds the items of a transaction that reverted because of a pause, without using up their retry', async () => {
    const t = setup();
    const a = fakeRecordItem(A, NOW + 5_000);
    await t.submit([a]);
    t.chain.paused = true;
    t.chain.includeAll();
    await t.poll(NOW + 10);
    expect(txStatus(t.state, 84532, t.chain.sent[0]?.hash as `0x${string}`)?.items[0]?.status).toBe(
      'held',
    );
    t.chain.paused = false;
    await t.poll(NOW + 20);
    t.chain.includeAll();
    await t.poll(NOW + 30);
    expect(t.chain.sent).toHaveLength(2);
    expect(txStatus(t.state, 84532, t.chain.sent[1]?.hash as `0x${string}`)?.items[0]?.status).toBe(
      'recorded',
    );
  });
});

describe('nonces', () => {
  it('serialises nonces across concurrent submissions', async () => {
    const t = setup();
    await Promise.all(
      [A, B, C, S, signerAddress(9)].map((signer) => t.submit([fakeRecordItem(signer)])),
    );
    expect(t.chain.sent.map((tx) => tx.nonce).sort((a, b) => a - b)).toEqual([7, 8, 9, 10, 11]);
  });

  it('reads the nonce again after a failed send and reports the items failed (unavailable)', async () => {
    const t = setup();
    t.chain.sendFails = true;
    const [r] = await t.submit([fakeRecordItem(A)]);
    expect(r).toMatchObject({ status: 'failed', error: 'unavailable' });
    t.chain.sendFails = false;
    t.chain.nonce = 12;
    await t.submit([fakeRecordItem(B)]);
    expect(t.chain.sent[0]?.nonce).toBe(12);
  });
});

describe('per-item gas ceiling (IR-M1-10a-1 H-1)', () => {
  it('refuses before sending an item whose own simulation burns more than maxItemGas', async () => {
    const t = setup({ maxItemGas: 700_000n });
    t.chain.code.add(S);
    const burner = fakeRecordItem(S); // isValidSignature burns gas, then succeeds
    t.chain.itemGas.set(burner.id, 3_000_000n);
    const ok = fakeRecordItem(A);
    const results = await t.submit([burner, ok]);
    expect(results[0]).toMatchObject({ status: 'failed', error: 'gas_too_high' });
    expect(t.chain.sent).toHaveLength(1);
    expect(t.chain.sent[0]?.ids).toEqual([ok.id]);
  });

  it('never sets a batch gas limit above the sum of its items’ own gas plus the margin', async () => {
    const t = setup();
    const items = [fakeRecordItem(A), fakeRecordItem(B), fakeRecordItem(C)];
    await t.submit(items);
    const tx = t.chain.sent[0];
    expect(tx?.gasLimit).toBeLessThanOrEqual(FAKE_ITEM_GAS * 3n + 25_000n);
    expect(tx?.gasLimit).toBe(fakeBatchGas(3) + 25_000n);
  });

  it('splits a batch whose simulated gas is above the sum of its items’ own gas', async () => {
    const t = setup();
    t.chain.batchExtraGas = 500_000n;
    const items = [fakeRecordItem(A), fakeRecordItem(B), fakeRecordItem(C)];
    const results = await t.submit(items);
    expect(results.every((r) => r.status === 'submitted')).toBe(true);
    expect(t.chain.sent.map((tx) => tx.ids.length)).toEqual([1, 1, 1]);
    for (const tx of t.chain.sent) expect(tx.gasLimit).toBe(tx.simulatedGas + 25_000n);
  });

  it('checks the ceiling again when a held item is re-simulated', async () => {
    const t = setup();
    t.chain.paused = true;
    const item = fakeRecordItem(A, NOW + 5_000);
    await t.submit([item]);
    t.chain.paused = false;
    t.chain.itemGas.set(item.id, 900_000n);
    await t.poll(NOW + 10);
    expect(t.chain.sent).toHaveLength(0);
    expect(queueDepth(t.state)).toBe(0);
  });
});

describe('infrastructure errors (IR-M1-10a-1 L-1)', () => {
  it('M1-10a-b: an RPC failure while re-simulating after a revert keeps the items in flight, retried next round, with no cool-off', async () => {
    const t = setup();
    const a = fakeRecordItem(A);
    const b = fakeRecordItem(B);
    await t.submit([a, b]);
    t.chain.failAtInclusion.add(a.id);
    t.chain.readFails = true; // the re-simulation after the revert cannot be read
    t.chain.includeAll();
    await t.poll(NOW + 10);
    await t.poll(NOW + 20); // still unreadable: nothing is failed, nothing is sent
    expect(t.chain.sent).toHaveLength(1);
    const status = txStatus(t.state, 84532, t.chain.sent[0]?.hash as `0x${string}`);
    expect(status?.items.map((i) => i.status)).toEqual(['held', 'held']);
    expect(status?.items.map((i) => i.error)).toEqual([undefined, undefined]);
    expect(queueDepth(t.state)).toBe(2);
    // A client asking again while they are in flight sends nothing new.
    const again = await t.submit([a, b], NOW + 25);
    expect(again.map((r) => r.status)).toEqual(['held', 'held']);
    expect(t.chain.sent).toHaveLength(1);
    // The chain answers again and the divergence is gone: both go out once, still together
    // (neither signer was put in the solo cooling-off).
    t.chain.readFails = false;
    t.chain.failAtInclusion.delete(a.id);
    await t.poll(NOW + 30);
    expect(t.chain.sent).toHaveLength(2);
    expect(t.chain.sent[1]?.ids).toEqual([a.id, b.id]);
    t.chain.includeAll();
    await t.poll(NOW + 40);
    await t.poll(NOW + 50);
    expect(t.chain.sent).toHaveLength(2);
    const landed = txStatus(t.state, 84532, t.chain.sent[1]?.hash as `0x${string}`);
    expect(landed?.items.map((i) => i.status)).toEqual(['recorded', 'recorded']);
  });

  it('M1-10a-b: an RPC failure on the resubmission’s batch simulation keeps the items in flight', async () => {
    const t = setup();
    const a = fakeRecordItem(A);
    const b = fakeRecordItem(B);
    const c = fakeRecordItem(C);
    await t.submit([a, b, c]);
    t.chain.failAtInclusion.add(b.id);
    t.chain.simulationErrors.set(b.id, 'InsufficientCredits');
    t.chain.batchReadFails = true; // per-item reads work, the batch estimate does not
    t.chain.includeAll();
    await t.poll(NOW + 10);
    expect(t.chain.sent).toHaveLength(1);
    const status = txStatus(t.state, 84532, t.chain.sent[0]?.hash as `0x${string}`);
    const byId = new Map(status?.items.map((i) => [i.id, i]));
    expect(byId.get(b.id)).toMatchObject({ status: 'failed', error: 'InsufficientCredits' });
    expect(byId.get(a.id)?.status).toBe('held');
    expect(byId.get(c.id)?.status).toBe('held');
    t.chain.batchReadFails = false;
    await t.poll(NOW + 20);
    expect(t.chain.sent.slice(1).map((tx) => tx.ids)).toEqual([[a.id, c.id]]);
  });

  it('a pending held item whose re-simulation cannot be read stays held (no cool-off)', async () => {
    const t = setup();
    t.chain.paused = true;
    const a = fakeRecordItem(A);
    await t.submit([a]);
    t.chain.paused = false;
    t.chain.readFails = true;
    await t.poll(NOW + 10);
    expect(queueDepth(t.state)).toBe(1);
    t.chain.readFails = false;
    await t.poll(NOW + 20);
    expect(t.chain.sent.map((tx) => tx.ids)).toEqual([[a.id]]);
  });
});

describe('stuck and dropped transactions (IR-M1-10a-1 M-2)', () => {
  it('replaces a stuck transaction at the same nonce with raised fees, at most maxReplacements times', async () => {
    const t = setup({ stuckAfterSeconds: 100, maxReplacements: 2 });
    const a = fakeRecordItem(A, NOW + 100_000);
    await t.submit([a]);
    const first = t.chain.sent[0];
    await t.poll(NOW + 50); // not stuck yet
    expect(t.chain.sent).toHaveLength(1);
    await t.poll(NOW + 100);
    await t.poll(NOW + 200);
    expect(t.chain.sent).toHaveLength(3);
    expect(t.chain.sent.map((tx) => tx.nonce)).toEqual([first?.nonce, first?.nonce, first?.nonce]);
    expect(t.chain.sent.map((tx) => tx.feePercent)).toEqual([
      100,
      replacementFeePercent(1),
      replacementFeePercent(2),
    ]);
    expect(replacementFeePercent(1)).toBeGreaterThanOrEqual(110);
    expect(t.chain.sent.every((tx) => tx.gasLimit === first?.gasLimit)).toBe(true);
    // The second replacement lands: the original hash reports it.
    t.chain.include(t.chain.sent[2]?.hash as `0x${string}`);
    await t.poll(NOW + 210);
    const status = txStatus(t.state, 84532, first?.hash as `0x${string}`);
    expect(status?.state).toBe('included');
    expect(status?.items[0]).toMatchObject({ status: 'recorded', txHash: t.chain.sent[2]?.hash });
  });

  it('gives up a transaction never included, queues its items again and reads the nonce from the chain', async () => {
    const t = setup({ stuckAfterSeconds: 100, maxReplacements: 1 });
    const a = fakeRecordItem(A, NOW + 100_000);
    await t.submit([a]);
    const first = t.chain.sent[0];
    await t.poll(NOW + 100); // one replacement
    expect(t.chain.sent).toHaveLength(2);
    t.chain.dropPending(); // the nodes forget both; the pending nonce falls back
    await t.poll(NOW + 200); // gives up, re-queues, re-simulates and sends again
    const status = txStatus(t.state, 84532, first?.hash as `0x${string}`);
    expect(status?.state).toBe('dropped');
    expect(t.chain.sent).toHaveLength(3);
    const resent = t.chain.sent[2];
    expect(resent?.ids).toEqual([a.id]);
    expect(resent?.nonce).toBe(first?.nonce); // the lost nonce is used again, not skipped
    expect(resent?.feePercent).toBe(100);
    t.chain.includeAll();
    await t.poll(NOW + 210);
    expect(txStatus(t.state, 84532, resent?.hash as `0x${string}`)?.items[0]?.status).toBe(
      'recorded',
    );
    // A later item gets the next nonce: nothing is blocked.
    await t.submit([fakeRecordItem(B)], NOW + 220);
    expect(t.chain.sent.at(-1)?.nonce).toBe((first?.nonce ?? 0) + 1);
  });

  it('M1-10a-b: giving up reconciles against the latest nonce, so a transaction still in some mempool leaves no gap', async () => {
    const t = setup({ stuckAfterSeconds: 100, maxReplacements: 1 });
    const a = fakeRecordItem(A, NOW + 100_000);
    await t.submit([a]);
    const first = t.chain.sent[0];
    await t.poll(NOW + 100); // one replacement
    expect(t.chain.sent).toHaveLength(2);
    // Never mined, yet still in a node's mempool: the pending nonce stays one above it.
    expect(await t.chain.pendingNonce()).toBe((first?.nonce ?? 0) + 1);
    expect(await t.chain.latestNonce()).toBe(first?.nonce);
    await t.poll(NOW + 200); // gives up, re-queues, re-simulates and sends again
    expect(txStatus(t.state, 84532, first?.hash as `0x${string}`)?.state).toBe('dropped');
    expect(t.chain.sent).toHaveLength(3);
    const resent = t.chain.sent[2];
    expect(resent?.ids).toEqual([a.id]);
    // The pending nonce would skip it and leave a gap that blocks every later send.
    expect(resent?.nonce).toBe(first?.nonce);
    t.chain.includeAll();
    await t.poll(NOW + 210);
    expect(txStatus(t.state, 84532, resent?.hash as `0x${string}`)?.items[0]?.status).toBe(
      'recorded',
    );
    await t.submit([fakeRecordItem(B)], NOW + 220);
    expect(t.chain.sent.at(-1)?.nonce).toBe((first?.nonce ?? 0) + 1);
  });

  it('M1-10a-b: when the latest nonce cannot be read on giving up, the given-up nonce is used again', async () => {
    const t = setup({ stuckAfterSeconds: 100, maxReplacements: 0 });
    const a = fakeRecordItem(A, NOW + 100_000);
    await t.submit([a]);
    const first = t.chain.sent[0];
    t.chain.nonceReadFails = true;
    await t.poll(NOW + 100);
    expect(t.chain.sent).toHaveLength(2);
    expect(t.chain.sent[1]?.ids).toEqual([a.id]);
    expect(t.chain.sent[1]?.nonce).toBe(first?.nonce);
  });

  it('reports an item of a dropped transaction that landed after all as skipped, without resending it', async () => {
    const t = setup({ stuckAfterSeconds: 100, maxReplacements: 0 });
    const a = fakeRecordItem(A, NOW + 100_000);
    await t.submit([a]);
    t.chain.dropPending();
    t.chain.onChain.add(a.id); // it was mined somewhere we did not see
    await t.poll(NOW + 100);
    expect(t.chain.sent).toHaveLength(1);
    expect(txStatus(t.state, 84532, t.chain.sent[0]?.hash as `0x${string}`)?.items[0]?.status).toBe(
      'skipped',
    );
  });
});
