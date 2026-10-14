// Envelope v1 (04 §3.1, §3.2, §3.3, §3.5). All binary values are base64url without padding, except
// `from` and `sig` (lowercase hex). Byte lengths follow the HPKE suite of §3.3.
import { describe, expect, it } from 'vitest';
import {
  envelopeSchema,
  MAX_ENVELOPE_BYTES,
  unsignedEnvelopeSchema,
  utf8ByteLength,
} from './index.js';
import { expectAccept, expectReject, expectRoundTrip } from './testing/assert.js';
import {
  AGENT_NOSTR,
  b64u,
  BIP340_SIG,
  DELETE,
  edit,
  envelope,
  ID16,
  KEY32,
} from './testing/fixtures.js';

/** The largest ct (in bytes) that keeps the fixture envelope within MAX_ENVELOPE_BYTES. */
function maxCtBytes(): number {
  let n = 300;
  const fits = (k: number) =>
    utf8ByteLength(JSON.stringify(edit(envelope(), ['aead', 'ct'], b64u(k)))) <= MAX_ENVELOPE_BYTES;
  while (fits(n + 1)) n++;
  return n;
}

describe('Envelope round trips', () => {
  it('round-trips with 2 to 5 recipients', () => {
    expectRoundTrip(envelopeSchema, envelope());
    const e = envelope();
    expectRoundTrip(envelopeSchema, { ...e, recipients: e.recipients.slice(0, 2) });
    expectRoundTrip(envelopeSchema, {
      ...e,
      recipients: [...e.recipients, { kid: b64u(16, 'M'), enc: b64u(32, 'N'), wk: b64u(48, 'O') }],
    });
  });

  it('accepts an envelope at exactly the 24 KB limit and rejects one byte more', () => {
    const n = maxCtBytes();
    const atLimit = edit(envelope(), ['aead', 'ct'], b64u(n));
    expectAccept(envelopeSchema, atLimit);
    // b64u(n + 1) adds one or two characters; either way the envelope is over the limit.
    expectReject(envelopeSchema, edit(envelope(), ['aead', 'ct'], b64u(n + 1)));
    expect(utf8ByteLength(JSON.stringify(atLimit))).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
  });

  it('the unsigned form (for envelopeHash and AEAD data) is the envelope without sig', () => {
    const unsigned = edit(envelope(), ['sig'], DELETE);
    expectRoundTrip(unsignedEnvelopeSchema, unsigned);
    expectReject(unsignedEnvelopeSchema, envelope());
    expectReject(envelopeSchema, unsigned);
  });
});

describe('Envelope rejects every malformed field', () => {
  it.each(['v', 'id', 'thread', 'from', 'createdAt', 'recipients', 'aead', 'sig'])(
    'rejects an envelope without %s',
    (field) => {
      expectReject(envelopeSchema, edit(envelope(), [field], DELETE));
    },
  );

  it.each([
    ['v 2', ['v'], 2],
    ['v "1"', ['v'], '1'],
    ['id padded', ['id'], `${ID16}==`],
    ['id 15 bytes', ['id'], b64u(15)],
    ['id 17 bytes', ['id'], b64u(17)],
    ['id hex', ['id'], 'ab'.repeat(16)],
    ['id non-canonical tail', ['id'], `${ID16.slice(0, -1)}B`],
    ['thread 32 bytes', ['thread'], KEY32],
    ['from uppercase', ['from'], AGENT_NOSTR.toUpperCase()],
    ['from 0x-prefixed', ['from'], `0x${AGENT_NOSTR}`],
    ['from base64url', ['from'], KEY32],
    ['from 33 bytes', ['from'], `${AGENT_NOSTR}ab`],
    ['createdAt negative', ['createdAt'], -1],
    ['createdAt fractional', ['createdAt'], 1.5],
    ['createdAt 2^53', ['createdAt'], 2 ** 53],
    ['createdAt ISO string', ['createdAt'], '2026-10-14T00:00:00Z'],
    ['recipients empty', ['recipients'], []],
    ['recipients one', ['recipients'], [envelope().recipients[0]]],
    ['recipients object', ['recipients'], {}],
    ['kid 32 bytes', ['recipients', 0, 'kid'], KEY32],
    ['kid padded', ['recipients', 0, 'kid'], `${ID16}==`],
    ['enc 33 bytes', ['recipients', 0, 'enc'], b64u(33)],
    ['enc 65 bytes (uncompressed P-256, wrong KEM)', ['recipients', 0, 'enc'], b64u(65)],
    ['wk 32 bytes (no tag)', ['recipients', 0, 'wk'], KEY32],
    ['wk 49 bytes', ['recipients', 0, 'wk'], b64u(49)],
    ['recipient unknown key', ['recipients', 0, 'pubkey'], KEY32],
    ['recipient missing wk', ['recipients', 0, 'wk'], DELETE],
    ['alg other', ['aead', 'alg'], 'A128GCM'],
    ['alg lowercase', ['aead', 'alg'], 'a256gcm'],
    ['alg A256GCM-KC lowercase', ['aead', 'alg'], 'a256gcm-kc'],
    // 04 §3.1 (G-46, D-66): the earlier alg and a key commitment that is not exactly 32 bytes.
    ['alg A256GCM (the earlier form)', ['aead', 'alg'], 'A256GCM'],
    ['kc missing', ['aead', 'kc'], DELETE],
    ['kc 31 bytes', ['aead', 'kc'], b64u(31)],
    ['kc 33 bytes', ['aead', 'kc'], b64u(33)],
    ['kc 16 bytes', ['aead', 'kc'], ID16],
    ['kc empty', ['aead', 'kc'], ''],
    ['kc padded', ['aead', 'kc'], `${b64u(32)}=`],
    ['kc standard base64', ['aead', 'kc'], `+/${b64u(32).slice(2)}`],
    ['kc a number', ['aead', 'kc'], 7],
    ['alg ChaCha', ['aead', 'alg'], 'C20P'],
    ['iv 16 bytes', ['aead', 'iv'], ID16],
    ['iv 11 bytes', ['aead', 'iv'], b64u(11)],
    ['iv padded', ['aead', 'iv'], `${b64u(12)}==`],
    ['ct shorter than a tag', ['aead', 'ct'], b64u(15)],
    ['ct empty', ['aead', 'ct'], ''],
    ['ct padded', ['aead', 'ct'], `${b64u(301)}=`],
    ['ct standard base64', ['aead', 'ct'], `+/${b64u(300).slice(2)}`],
    ['aead unknown key', ['aead', 'tag'], b64u(16)],
    ['aead missing ct', ['aead', 'ct'], DELETE],
    ['sig uppercase', ['sig'], BIP340_SIG.toUpperCase()],
    ['sig 127 chars', ['sig'], BIP340_SIG.slice(1)],
    ['sig 0x', ['sig'], `0x${BIP340_SIG}`],
    ['sig base64url', ['sig'], b64u(64)],
    ['unknown key', ['payload'], 'plaintext!'],
    ['unknown key proof', ['proof'], true],
  ] as const)('rejects %s', (_l, path, value) => {
    expectReject(envelopeSchema, edit(envelope(), path, value));
  });

  it('rejects six recipients (04 §3.2: at most 5)', () => {
    const e = envelope();
    const extra = [
      { kid: b64u(16, 'M'), enc: b64u(32, 'N'), wk: b64u(48, 'O') },
      { kid: b64u(16, 'P'), enc: b64u(32, 'Q'), wk: b64u(48, 'R') },
    ];
    expectReject(envelopeSchema, { ...e, recipients: [...e.recipients, ...extra] });
  });

  it('rejects duplicate kids (the wrap is picked by kid)', () => {
    const e = envelope();
    const dup = { ...e.recipients[1], kid: e.recipients[0]?.kid };
    expectReject(envelopeSchema, { ...e, recipients: [e.recipients[0], dup] });
  });

  it('rejects non-objects without throwing', () => {
    for (const v of [null, undefined, 'envelope', 1, [], [envelope()], true]) {
      expect(() => envelopeSchema.safeParse(v)).not.toThrow();
      expectReject(envelopeSchema, v);
    }
  });
});
