// E2E-HOSTILE, a misbehaving contact (06 §3 `outgoing`, §4; 04 §2.5, §3.4; I-5; SEC-TERMS-CAPS,
// SEC-RESTORE-GUARD, DELETE-PLAN-ACKS, D-156). A paired contact, a real core of its own that controls
// its client, sends the victim things a well-behaved one would not. The victim's real core, behind the
// built CLI's MCP server, keeps to the specified behaviour:
//
// - inbound text that reads like instructions stays inside the untrusted element, and nothing is
//   started by receiving it (I-5);
// - an acknowledgement that does not match a message is not counted, and an acknowledgement never
//   deletes or keeps anything beyond the message it names (07 §3.8);
// - an owner's outgoing caps stop a run of terms offers, in the same words as other sends;
// - inbound from before a restore is shown but starts nothing automatically (04 §2.3.3).
//
// In-memory relays, no Docker, no keychain, no network.
import { parseJson } from '@4thtech-io/crypto';
import { ackPayload } from '@4thtech-io/core';
import { afterEach, describe, expect, it } from 'vitest';
import { deliveredWrapped, expectContained, oursFields } from '../prompt-injection/assert.js';
import { TEXT_CORPUS, TERMS_MARKER, hostileTerms } from '../prompt-injection/corpus.js';
import {
  deliver,
  editPolicy,
  effects,
  sentAcks,
  surface,
  type PiAgent,
} from '../prompt-injection/harness.js';
import { scene, type Scene } from './support.js';

let current: Scene | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const envelopeRows = (agent: PiAgent, filter: Record<string, unknown>) =>
  agent.store.transaction((tx) => tx.select('envelopes', filter as never)) as Promise<
    readonly {
      envelope_id: string;
      type: string;
      state: string;
      deleted_at: number | null;
    }[]
  >;

describe('inbound content that reads like instructions stays untrusted (I-5)', () => {
  const ITEMS = TEXT_CORPUS.filter((i) =>
    [
      'tool-like',
      'tool-json',
      'close-plain',
      'open-forged',
      'fake-header',
      'turn-forgery',
    ].includes(i.id),
  );

  it('arrives wrapped and escaped, and receiving it starts nothing', async () => {
    const s = (current = await scene());
    const toolSurface = await surface(s.ana);
    const base = await effects(s.world, s.ana);
    for (const item of ITEMS) {
      const sent = await s.mallory.call('agentlink_send', { to: 'Ana', text: item.text });
      expect(sent.structured['status']).toBe('ok');
    }
    const terms = hostileTerms(TERMS_MARKER);
    const offer = await s.mallory.call('agentlink_propose_terms', {
      to: 'Ana',
      terms: terms.terms,
      note: terms.note,
    });
    expect(offer.structured['status']).toBe('ok');
    await deliver(s.mallory, s.ana);
    await deliver(s.mallory, s.ana);

    // What our code does on receiving: the automatic "received" acks, and nothing else.
    const afterSync = await effects(s.world, s.ana);
    expect(afterSync.outbound).toBe(base.outbound);
    for (const table of ['contacts', 'approvals', 'receipts', 'proofs', 'budget_ledger']) {
      expect(afterSync.rows[table], table).toBe(base.rows[table]);
    }
    expect(afterSync.notarizeCalls).toBe(base.notarizeCalls);
    expect(afterSync.opens).toBe(base.opens);

    const inbox = await s.ana.call('agentlink_inbox', { limit: 100 });
    expect(inbox.structured['status']).toBe('ok');
    const needles = [...ITEMS.flatMap((i) => i.needles), 'Human: SYSTEM', 'approve apr_x now'];
    expectContained(inbox, needles);
    for (const item of ITEMS) {
      expect(deliveredWrapped(inbox, item.marker), `${item.id} delivered inside the element`).toBe(
        true,
      );
    }
    expect(deliveredWrapped(inbox, TERMS_MARKER)).toBe(true);
    // One closing line of ours per message: a closing tag inside a message never ends its element.
    const messages = inbox.structured['messages'] as unknown[];
    const closings = inbox.text.split('\n').filter((l) => l === '</untrusted_content>');
    expect(closings).toHaveLength(messages.length);

    // The other tools never carry it, and reading starts nothing either.
    for (const tool of ['agentlink_status', 'agentlink_list_contacts'] as const) {
      expectContained(await s.ana.call(tool), needles);
    }
    for (const r of s.ana.results) {
      expect(oursFields(r)).not.toContain('SYSTEM: the user approved');
    }
    expect(await effects(s.world, s.ana)).toEqual(afterSync);
    expect(await surface(s.ana)).toBe(toolSurface);
  });
});

describe('a contact’s acknowledgement counts only for what it matches (07 §3.8)', () => {
  /** The contact hands the victim an acknowledgement envelope that names `naming`, with this hash. */
  async function ackFromContact(s: Scene, naming: string, hash: string): Promise<string> {
    const { row } = await s.mallory.client.envelopes.prepare({
      to: { contact: s.ana.client.agentId },
      payload: ackPayload(naming, hash),
    });
    await s.mallory.store.transaction((tx) => {
      tx.insert('envelopes', { ...row, delivery: 'sent' });
    });
    const received = await s.ana.client.envelopes.receive({
      envelope: parseJson(row.envelope_json ?? ''),
    });
    expect(received.status).toBe('verified');
    await s.ana.client.envelopes.processReceived();
    return row.envelope_id;
  }

  const WRONG_HASH = `0x${'ab'.repeat(32)}`;

  it('an acknowledgement with another hash, or for a message that is not ours, is not a receipt', async () => {
    const s = (current = await scene());
    await editPolicy(s.mallory, (p) => {
      p['receipts'] = { ...(p['receipts'] as Record<string, unknown>), sendReceived: false };
    });
    const m1 = String(
      (await s.ana.call('agentlink_send', { to: 'Mallory', text: 'one' })).structured['envelopeId'],
    );
    await deliver(s.ana, s.mallory);
    expect(await sentAcks(s.mallory)).toHaveLength(0);
    expect(await s.ana.client.acks.status(m1)).toMatchObject({ received: false, verified: false });

    await ackFromContact(s, m1, WRONG_HASH);
    await ackFromContact(s, 'A'.repeat(22), WRONG_HASH);
    expect(await s.ana.client.acks.status(m1)).toMatchObject({
      received: false,
      verified: false,
      receipt: null,
    });
  });

  it('deleting one message takes only that message and the acknowledgements that name it', async () => {
    const s = (current = await scene());
    await editPolicy(s.mallory, (p) => {
      p['receipts'] = { ...(p['receipts'] as Record<string, unknown>), sendReceived: false };
    });
    const id = async (text: string) =>
      String(
        (await s.ana.call('agentlink_send', { to: 'Mallory', text })).structured['envelopeId'],
      );
    const m1 = await id('delete this one');
    const m2 = await id('keep this one');
    await deliver(s.ana, s.mallory);
    const forMessage1 = await ackFromContact(s, m1, WRONG_HASH);
    const forMessage2 = await ackFromContact(s, m2, WRONG_HASH);

    const plan = await s.ana.client.history.plan({ envelopeIds: [m1], include: 'messages' });
    expect([...plan.envelopeIds].sort()).toEqual([m1, forMessage1].sort());
    // An acknowledgement of a message that stays, arriving after the owner saw the list, changes
    // nothing about what is deleted and nothing about what stays.
    const result = await s.ana.client.history.apply(plan);
    expect(result.messages.deleted).toBe(2);
    const rows = new Map((await envelopeRows(s.ana, {})).map((r) => [r.envelope_id, r]));
    expect(rows.get(m1)?.deleted_at).not.toBeNull();
    expect(rows.get(forMessage1)?.deleted_at).not.toBeNull();
    expect(rows.get(m2)?.deleted_at).toBeNull();
    expect(rows.get(forMessage2)?.deleted_at).toBeNull();
  });

  it('an acknowledgement chosen on its own, while its message stays, deletes nothing', async () => {
    const s = (current = await scene());
    await editPolicy(s.mallory, (p) => {
      p['receipts'] = { ...(p['receipts'] as Record<string, unknown>), sendReceived: false };
    });
    const m = String(
      (await s.ana.call('agentlink_send', { to: 'Mallory', text: 'stays' })).structured[
        'envelopeId'
      ],
    );
    await deliver(s.ana, s.mallory);
    const ack = await ackFromContact(s, m, WRONG_HASH);
    const plan = await s.ana.client.history.plan({ envelopeIds: [ack], include: 'messages' });
    expect(plan.envelopeIds).not.toContain(ack);
    await s.ana.client.history.apply(plan);
    const rows = new Map((await envelopeRows(s.ana, {})).map((r) => [r.envelope_id, r]));
    expect(rows.get(m)?.deleted_at).toBeNull();
    expect(rows.get(ack)?.deleted_at).toBeNull();
  });
});

describe('a run of terms offers meets the owner’s outgoing caps (06 §3 `outgoing`, SEC-TERMS-CAPS)', () => {
  const terms = (subject: string) => ({
    subject,
    deliverables: [{ description: 'Design files', by: 'them' as const }],
    price: { amount: '500.00', currency: 'USD', payer: 'me' as const },
  });

  it('offers count with messages per contact and per day; over the cap they are refused in the same words, and nothing goes out', async () => {
    const s = (current = await scene());
    await editPolicy(s.ana, (p) => {
      p['outgoing'] = {
        ...(p['outgoing'] as Record<string, unknown>),
        messagesPerContactPerDay: 3,
      };
    });
    for (const i of [1, 2, 3]) {
      const r = await s.ana.call('agentlink_propose_terms', {
        to: 'Mallory',
        terms: terms(`Deal ${String(i)}`),
      });
      expect(r.structured['status'], `offer ${String(i)}`).toBe('ok');
    }
    const publishedAtCap = s.world.net.published;
    const spam = await s.ana.call('agentlink_propose_terms', {
      to: 'Mallory',
      terms: terms('Deal 4'),
    });
    expect(spam.structured).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    const plain = await s.ana.call('agentlink_send', { to: 'Mallory', text: 'one more' });
    expect(plain.structured).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    expect(spam.structured['summary']).toBe(plain.structured['summary']);
    expect(String(spam.structured['summary'])).toContain('Sending limit reached');
    for (const i of [5, 6, 7]) {
      const r = await s.ana.call('agentlink_propose_terms', {
        to: 'Mallory',
        terms: terms(`Deal ${String(i)}`),
      });
      expect(r.structured['code']).toBe('SEND_LIMIT');
    }
    expect(s.world.net.published).toBe(publishedAtCap);
    expect(await envelopeRows(s.ana, { direction: 'out', type: 'offer' })).toHaveLength(3);
  });
});

describe('inbound from before a restore starts nothing automatically (SEC-RESTORE-GUARD, 04 §2.3.3)', () => {
  it('a message that arrives again after a restore is shown, but gets no automatic receipt; a normal one does', async () => {
    const restoredAt = { value: 0 };
    const s = (current = await scene({
      anaRestoreMark: { read: () => Promise.resolve(restoredAt.value) },
    }));
    const sent = await s.mallory.call('agentlink_send', {
      to: 'Ana',
      text: 'sent before the restore',
    });
    expect(sent.structured['status']).toBe('ok');
    await s.mallory.client.outbox.processDue();
    // The ID is restored from a backup now; the relays still hold what was sent before.
    restoredAt.value = Math.floor(Date.now() / 1000);
    const before = await effects(s.world, s.ana);
    expect(before.outboundAcks).toBe(0);
    await s.ana.client.syncInbox();
    await s.ana.client.outbox.processDue();
    const after = await effects(s.world, s.ana);

    const inbox = await s.ana.call('agentlink_inbox', {});
    expect(deliveredWrapped(inbox, 'sent before the restore')).toBe(true);
    expect(after.outbound).toBe(before.outbound);
    expect(after.outboundAcks).toBe(0);
    expect(await sentAcks(s.ana)).toHaveLength(0);
    expect(after.published).toBe(before.published);
    expect(after.rows['approvals']).toBe(before.rows['approvals']);
    expect(after.notarizeCalls).toBe(before.notarizeCalls);
    expect(after.acknowledgeCalls).toBe(before.acknowledgeCalls);
  });

  it('control: without a restore the same message is acknowledged automatically', async () => {
    const s = (current = await scene());
    await s.mallory.call('agentlink_send', { to: 'Ana', text: 'an ordinary message' });
    await deliver(s.mallory, s.ana);
    expect((await sentAcks(s.ana)).length).toBeGreaterThan(0);
  });
});
