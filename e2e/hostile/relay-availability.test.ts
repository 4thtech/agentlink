// E2E-HOSTILE, hostile relays (07 §4.2, §4.3; 06 §2.2 `availability`; SEC-RELAY-READBACK, D-156 (7)):
// a message counts as sent without a caveat only once a relay that said OK serves it back by its ID
// (the same event, on a fresh connection). A relay that says OK and then does not serve the message,
// serves a different or altered one, or never answers the look-up never earns a plain "Sent": the
// answer is "Sent, availability unknown", in the tool result, in its words and in the stored row.
//
// The relays are the in-memory relay network of the prompt-injection harness with a misbehaving mode
// (support.ts); the agents are real cores behind the built CLI's MCP server. No Docker, no keychain,
// no network.
import { afterEach, describe, expect, it } from 'vitest';
import { scene, type RelayMode, type Scene } from './support.js';

let current: Scene | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function sendThrough(mode: RelayMode, text: string) {
  const s = (current = await scene());
  s.net.mode = mode;
  const sent = await s.ana.call('agentlink_send', { to: 'Mallory', text });
  const envelopeId = String(sent.structured['envelopeId']);
  const row = await s.ana.store.transaction((tx) =>
    tx.get('envelopes', { envelope_id: envelopeId, direction: 'out' } as never),
  );
  return { s, sent, row: row as unknown as { delivery: string; availability: string | null } };
}

describe('a relay that serves the message back confirms it', () => {
  it('honest relays: sent, with no availability caveat, and the contact receives it', async () => {
    const { s, sent, row } = await sendThrough('honest', 'a message the relays serve back');
    expect(sent.structured['status']).toBe('ok');
    expect(sent.structured['delivery']).toBe('sent');
    expect(sent.structured['availability']).toBeUndefined();
    expect(row.availability).toBe('confirmed');
    await s.mallory.client.syncInbox();
    const inbox = await s.mallory.call('agentlink_inbox', {});
    expect(inbox.text).toContain('a message the relays serve back');
  });
});

describe('a misbehaving relay never earns a plain "Sent"', () => {
  const unknownAvailability = (
    sent: Awaited<ReturnType<typeof sendThrough>>['sent'],
    row: { availability: string | null },
  ): void => {
    expect(sent.structured['status']).toBe('ok');
    expect(sent.structured['delivery']).toBe('sent');
    expect(sent.structured['availability']).toBe('unknown');
    expect(String(sent.structured['summary'])).toContain('availability unknown');
    expect(String(sent.structured['summary'])).toContain(
      'could not yet confirm that the message network holds it',
    );
    expect(row.availability).toBe('unknown');
    expect(row.availability).not.toBe('confirmed');
  };

  it('a relay that answers OK but keeps nothing: availability unknown, and nothing is delivered', async () => {
    const { s, sent, row } = await sendThrough('ok-without-storing', 'kept by no relay');
    unknownAvailability(sent, row);
    await s.mallory.client.syncInbox();
    const inbox = await s.mallory.call('agentlink_inbox', {});
    expect(inbox.text).not.toContain('kept by no relay');
  });

  it('a relay that serves a different event under the same ID: availability unknown, never confirmed', async () => {
    const { sent, row } = await sendThrough('serves-another-event', 'served back altered');
    unknownAvailability(sent, row);
  });

  it('a relay that never answers the look-up: availability unknown within the time bound', async () => {
    const started = Date.now();
    const { sent, row } = await sendThrough('ignores-lookups', 'nobody answers the look-up');
    unknownAvailability(sent, row);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('a later pass with misbehaving relays never upgrades the row to confirmed', async () => {
    const { s, row } = await sendThrough('ok-without-storing', 'still not confirmed later');
    expect(row.availability).toBe('unknown');
    s.advance(600);
    await s.ana.client.outbox.processDue();
    const rows = await s.ana.store.transaction((tx) =>
      tx.select('envelopes', { direction: 'out', type: 'text' } as never),
    );
    for (const r of rows as unknown as { availability: string | null }[]) {
      expect(r.availability).not.toBe('confirmed');
    }
  });
});
