// SEC-RECEIPTS-DEFAULT: the sender's check of a stored "received" ack (02 F-23; 04 §3.4).
import type { Payload } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { ACK_KIND_RECEIVED, DEVICE_RECEIPT_LABEL, ackPayload, classifyAck } from './acks.js';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_ID = 'BBBBBBBBBBBBBBBBBBBBBB';
const HASH = `0x${'11'.repeat(32)}`;
const KEY_NOW = 'a'.repeat(64);
const KEY_EARLIER = 'b'.repeat(64);
const KEY_UNSEEN = 'c'.repeat(64);

const ack = (body: Record<string, unknown>, replyTo: string = ID): Payload =>
  ({ type: 'ack', body, replyTo, files: [] }) as unknown as Payload;

const base = {
  envelopeId: ID,
  envelopeHash: HASH,
  contactKeys: [KEY_NOW, KEY_EARLIER],
} as const;

describe('ackPayload (v2 body)', () => {
  it('binds the envelope ID and its envelopeHash', () => {
    expect(ackPayload(ID, HASH)).toEqual({
      type: 'ack',
      body: { kind: ACK_KIND_RECEIVED, envelopeId: ID, envelopeHash: HASH },
      replyTo: ID,
      files: [],
    });
  });
});

describe('classifyAck', () => {
  it('a v2 ack with the matching hash from a current key is verified', () => {
    expect(
      classifyAck({
        ...base,
        fromKey: KEY_NOW,
        payload: ack({ kind: 'received', envelopeId: ID, envelopeHash: HASH }),
      }),
    ).toBe('verified');
  });

  it('a v2 ack signed under an earlier epoch the contact held at ack time still counts', () => {
    expect(
      classifyAck({
        ...base,
        fromKey: KEY_EARLIER,
        payload: ack({ kind: 'received', envelopeId: ID, envelopeHash: HASH }),
      }),
    ).toBe('verified');
  });

  it('an ack from a key the contact never held is refused (wrong epoch)', () => {
    expect(
      classifyAck({
        ...base,
        fromKey: KEY_UNSEEN,
        payload: ack({ kind: 'received', envelopeId: ID, envelopeHash: HASH }),
      }),
    ).toBeUndefined();
  });

  it('a v2 ack with another hash, or a malformed hash, is refused', () => {
    for (const envelopeHash of [`0x${'22'.repeat(32)}`, 'nope', 42, null]) {
      expect(
        classifyAck({
          ...base,
          fromKey: KEY_NOW,
          payload: ack({ kind: 'received', envelopeId: ID, envelopeHash }),
        }),
      ).toBeUndefined();
    }
  });

  it('a body with any other key is refused (strict v2 and v1 bodies)', () => {
    for (const body of [
      { kind: 'received', envelopeId: ID, envelopeHash: HASH, extra: 1 },
      { kind: 'received', envelopeId: ID, opened: true },
      { kind: 'received', envelopeId: ID, envelopeHash: HASH, recordId: 'nope' },
    ]) {
      expect(classifyAck({ ...base, fromKey: KEY_NOW, payload: ack(body) })).toBeUndefined();
    }
    expect(
      classifyAck({
        ...base,
        fromKey: KEY_NOW,
        payload: ack({ kind: 'received', envelopeId: ID, envelopeHash: HASH, recordId: HASH }),
      }),
    ).toBe('verified');
  });

  it('an id-only ack from an older app is accepted as weaker', () => {
    expect(
      classifyAck({
        ...base,
        fromKey: KEY_NOW,
        payload: ack({ kind: 'received', envelopeId: ID }),
      }),
    ).toBe('older_app');
  });

  it('an ack naming another envelope, another kind or another reply is refused', () => {
    const cases = [
      ack({ kind: 'received', envelopeId: OTHER_ID, envelopeHash: HASH }),
      ack({ kind: 'opened', envelopeId: ID, envelopeHash: HASH }),
      ack({ kind: 'received', envelopeId: ID, envelopeHash: HASH }, OTHER_ID),
      { type: 'text', body: 'received', replyTo: ID, files: [] } as unknown as Payload,
    ];
    for (const payload of cases) {
      expect(classifyAck({ ...base, fromKey: KEY_NOW, payload })).toBeUndefined();
    }
  });
});

describe('proof pack label', () => {
  it('names the off-chain ack an automatic device receipt', () => {
    expect(DEVICE_RECEIPT_LABEL).toBe('automatic device receipt');
  });
});
