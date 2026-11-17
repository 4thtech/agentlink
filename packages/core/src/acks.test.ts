// SEC-RECEIPTS-DEFAULT: the sender's check of a stored "received" ack (02 F-23; 04 §3.4).
import { payloadSchema, type Payload } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { ACK_KIND_RECEIVED, DEVICE_RECEIPT_LABEL, ackPayload, classifyAck } from './acks.js';
import { ACK_DELAY_MAX_SECONDS, ACK_DELAY_MIN_SECONDS } from './constants.js';
import { ackDelaySeconds } from './outbox.js';

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

describe('ack delay (D-156)', () => {
  it('is 5 to 90 s whatever the random bytes', () => {
    expect(ackDelaySeconds(new Uint8Array([0, 0, 0, 0]))).toBe(ACK_DELAY_MIN_SECONDS);
    expect(ackDelaySeconds(new Uint8Array([0, 0, 0, 85]))).toBe(ACK_DELAY_MAX_SECONDS);
    for (let i = 0; i < 500; i += 1) {
      const d = ackDelaySeconds();
      expect(d).toBeGreaterThanOrEqual(ACK_DELAY_MIN_SECONDS);
      expect(d).toBeLessThanOrEqual(ACK_DELAY_MAX_SECONDS);
    }
  });
});

describe('proof pack label', () => {
  it('names the off-chain ack an automatic device receipt', () => {
    expect(DEVICE_RECEIPT_LABEL).toBe('automatic device receipt');
  });
});

// L2: the receiving side of a 0.5.9 app, as it shipped (acks.ts `status` and ui-messages `ackedOf`):
// the payload's strict schema, then `kind`, `envelopeId` and `replyTo`. A v2 body (with and without
// `recordId`) must count there, so an older peer still shows "received".
describe('0.5.9 compatibility fixture', () => {
  const countsIn059 = (payload: unknown, envelopeId: string): boolean => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success || parsed.data.type !== 'ack') return false;
    const body = parsed.data.body;
    return (
      parsed.data.replyTo === envelopeId &&
      typeof body === 'object' &&
      body.kind === ACK_KIND_RECEIVED &&
      body.envelopeId === envelopeId
    );
  };

  it('a 0.5.9 app reads the v2 ack as received', () => {
    expect(countsIn059(ackPayload(ID, HASH), ID)).toBe(true);
    expect(countsIn059(ackPayload(ID, HASH, `0x${'33'.repeat(32)}`), ID)).toBe(true);
    // The fixture itself refuses what 0.5.9 refused.
    expect(countsIn059({ ...ackPayload(ID, HASH), replyTo: OTHER_ID }, ID)).toBe(false);
  });
});
