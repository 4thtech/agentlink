// M1-1c: the 04 §3.1 envelope. Strict v1 structure and §2.4.1 encodings (rejected, never
// normalised), envelopeHash over everything but `sig`, the AEAD additional data over the header,
// and the BIP-340 signature under the `agentlink/envelope/v1` tag. The cross-runtime vectors are in
// test-vectors/aead-envelope; these tests pin the API rules around them.
import { describe, expect, it } from 'vitest';
import {
  AEAD_CT_MAX_ENCODED_LENGTH,
  AEAD_CT_MAX_LENGTH,
  CryptoInputError,
  MAX_RECIPIENTS,
  TAGS,
  canonicalize,
  canonicalizeToBytes,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  envelopeAad,
  envelopeHash,
  envelopeSignatureInput,
  parseEnvelope,
  parseEnvelopeHeader,
  parseUnsignedEnvelope,
  randomBytes,
  sha256,
  taggedHash,
  verifyEnvelope,
  type Envelope,
  type EnvelopeHeader,
  type UnsignedEnvelope,
} from './index.js';
import { bip340PublicKey, bip340Sign, signEnvelopeHash } from './keystore.js';

type Json = Record<string, unknown>;

const b64 = (length: number): string => encodeBase64url(randomBytes(length));

function sampleHeader(from = encodeHex(randomBytes(32))): Json {
  return {
    v: 1,
    id: b64(16),
    thread: b64(16),
    from,
    createdAt: 1760000000,
    recipients: [1, 2, 3, 4].map(() => ({ kid: b64(16), enc: b64(32), wk: b64(48) })),
  };
}

function sampleUnsigned(from?: string): Json {
  return { ...sampleHeader(from), aead: { alg: 'A256GCM', iv: b64(12), ct: b64(40) } };
}

function sampleSigned(): Json {
  return { ...sampleUnsigned(), sig: encodeHex(randomBytes(64)) };
}

/** A signed envelope from a real key, so verifyEnvelope accepts it. */
function signedBy(secretKey: Uint8Array, unsigned?: Json): Json {
  const body = unsigned ?? sampleUnsigned(encodeHex(bip340PublicKey(secretKey)));
  const sig = signEnvelopeHash(secretKey, envelopeHash(body as unknown as UnsignedEnvelope));
  return { ...body, sig: encodeHex(sig) };
}

const withoutSig = (envelope: Json): Json =>
  Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'sig'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const SECRET = randomBytes(32);

function refusal(run: () => unknown): CryptoInputError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CryptoInputError);
  return caught as CryptoInputError;
}

/** Applies `change` to a deep copy of `base` at `path`. */
function changed(base: Json, path: readonly (string | number)[], value: unknown): Json {
  const copy = clone(base);
  let target = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete target[last];
  else target[last] = value;
  return copy;
}

describe('parseEnvelope: 04 §3.1 structure and §2.4.1 encodings', () => {
  it('accepts a well-formed signed envelope and returns an equal copy', () => {
    const input = sampleSigned();
    const parsed = parseEnvelope(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.recipients).not.toBe(input.recipients);
  });

  it('returns a frozen copy, so later changes to the input cannot reach it', () => {
    const input = sampleSigned();
    const parsed = parseEnvelope(input);
    (input.recipients as Json[])[0]!.kid = b64(16);
    input.createdAt = 1;
    expect(parsed.createdAt).toBe(1760000000);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.recipients)).toBe(true);
    expect(Object.isFrozen(parsed.recipients[0])).toBe(true);
    expect(Object.isFrozen(parsed.aead)).toBe(true);
  });

  it('accepts createdAt 0 and 2^53 - 1, one recipient and an empty-plaintext ct (16 bytes)', () => {
    const base = sampleSigned();
    expect(() => parseEnvelope(changed(base, ['createdAt'], 0))).not.toThrow();
    expect(() => parseEnvelope(changed(base, ['createdAt'], 2 ** 53 - 1))).not.toThrow();
    const one = changed(base, ['recipients'], [(base.recipients as Json[])[0]]);
    expect(() => parseEnvelope(one)).not.toThrow();
    expect(() => parseEnvelope(changed(base, ['aead', 'ct'], b64(16)))).not.toThrow();
  });

  const base = sampleSigned();
  const upper = (base.from as string).toUpperCase();
  const cases: [string, Json][] = [
    ['v = 2', changed(base, ['v'], 2)],
    ['v = "1"', changed(base, ['v'], '1')],
    ['v = true', changed(base, ['v'], true)],
    ['an unknown top-level key', changed(base, ['note'], 'x')],
    ['an unknown aead key', changed(base, ['aead', 'tag'], 'x')],
    ['an unknown recipient key', changed(base, ['recipients', 0, 'note'], 'x')],
    ['id missing', changed(base, ['id'], undefined)],
    ['thread missing', changed(base, ['thread'], undefined)],
    ['from missing', changed(base, ['from'], undefined)],
    ['createdAt missing', changed(base, ['createdAt'], undefined)],
    ['recipients missing', changed(base, ['recipients'], undefined)],
    ['aead missing', changed(base, ['aead'], undefined)],
    ['sig missing', changed(base, ['sig'], undefined)],
    ['kid missing', changed(base, ['recipients', 1, 'kid'], undefined)],
    ['iv missing', changed(base, ['aead', 'iv'], undefined)],
    ['id of 15 bytes', changed(base, ['id'], b64(15))],
    ['id of 17 bytes', changed(base, ['id'], b64(17))],
    ['id padded', changed(base, ['id'], `${base.id as string}==`)],
    ['id in standard base64', changed(base, ['id'], '+/' + (base.id as string).slice(2))],
    ['thread of 17 bytes', changed(base, ['thread'], b64(17))],
    ['from upper-case', changed(base, ['from'], upper)],
    ['from with 0x', changed(base, ['from'], `0x${base.from as string}`)],
    ['from of 31 bytes', changed(base, ['from'], encodeHex(randomBytes(31)))],
    ['createdAt = 2^53', changed(base, ['createdAt'], 2 ** 53)],
    ['createdAt negative', changed(base, ['createdAt'], -1)],
    ['createdAt fractional', changed(base, ['createdAt'], 1.5)],
    ['createdAt a string', changed(base, ['createdAt'], '1760000000')],
    ['recipients empty', changed(base, ['recipients'], [])],
    ['recipients an object', changed(base, ['recipients'], { 0: {} })],
    ['a recipient that is null', changed(base, ['recipients', 0], null)],
    ['kid of 15 bytes', changed(base, ['recipients', 0, 'kid'], b64(15))],
    ['enc of 31 bytes', changed(base, ['recipients', 0, 'enc'], b64(31))],
    ['enc of 33 bytes', changed(base, ['recipients', 0, 'enc'], b64(33))],
    ['wk of 47 bytes', changed(base, ['recipients', 2, 'wk'], b64(47))],
    ['wk of 49 bytes', changed(base, ['recipients', 2, 'wk'], b64(49))],
    ['alg A128GCM', changed(base, ['aead', 'alg'], 'A128GCM')],
    ['alg lower-case', changed(base, ['aead', 'alg'], 'a256gcm')],
    ['iv of 11 bytes', changed(base, ['aead', 'iv'], b64(11))],
    ['iv of 13 bytes', changed(base, ['aead', 'iv'], b64(13))],
    ['ct of 15 bytes', changed(base, ['aead', 'ct'], b64(15))],
    ['ct a number', changed(base, ['aead', 'ct'], 7)],
    ['sig upper-case', changed(base, ['sig'], (base.sig as string).toUpperCase())],
    ['sig with 0x', changed(base, ['sig'], `0x${base.sig as string}`)],
    ['sig of 63 bytes', changed(base, ['sig'], encodeHex(randomBytes(63)))],
  ];
  it.each(cases)('rejects %s, never normalising it', (_name, envelope) => {
    const error = refusal(() => parseEnvelope(envelope));
    expect(error.code).toBe('invalid_envelope');
  });

  it('rejects values that are not plain JSON data', () => {
    const good = sampleSigned();
    const withProto = Object.assign(Object.create({ inherited: 1 }) as Json, good);
    const inheritedKey = Object.create(good) as Json;
    const getter = { ...good };
    Object.defineProperty(getter, 'createdAt', { get: () => 1760000000, enumerable: true });
    const symbolKey = { ...good, [Symbol('x')]: 1 };
    const sparse = clone(good);
    (sparse.recipients as unknown[]).length = 5;
    for (const value of [null, undefined, 1, 'x', [], [good], withProto, inheritedKey, getter]) {
      expect(refusal(() => parseEnvelope(value)).code).toBe('invalid_envelope');
    }
    expect(refusal(() => parseEnvelope(symbolKey)).code).toBe('invalid_envelope');
    expect(refusal(() => parseEnvelope(sparse)).code).toBe('invalid_envelope');
  });

  it('never puts input values into the error message (I-7)', () => {
    const secretLooking = encodeHex(randomBytes(32)).toUpperCase();
    const error = refusal(() => parseEnvelope(changed(base, ['from'], secretLooking)));
    expect(error.message).not.toContain(secretLooking);
    expect(error.message.toLowerCase()).not.toContain(secretLooking.toLowerCase());
  });
});

describe('parser limits: 1 to 8 recipients with distinct kids, ct ≤ 17 152 bytes (04 §3.1.1, G-2)', () => {
  const entry = (): Json => ({ kid: b64(16), enc: b64(32), wk: b64(48) });
  const entries = (count: number): Json[] => Array.from({ length: count }, entry);
  const base = sampleSigned();

  it('fixes the limits of the 04 §3.1.1 table', () => {
    expect(MAX_RECIPIENTS).toBe(8);
    expect(AEAD_CT_MAX_LENGTH).toBe(17_152);
    // The base64url length of 17 152 bytes, without padding.
    expect(AEAD_CT_MAX_ENCODED_LENGTH).toBe(22_870);
    expect(b64(AEAD_CT_MAX_LENGTH)).toHaveLength(AEAD_CT_MAX_ENCODED_LENGTH);
  });

  it('accepts the worst case: 8 recipients, a ct of 17 152 bytes, createdAt 2^53 - 1 (24 509 bytes as JCS)', () => {
    let worst = changed(base, ['recipients'], entries(8));
    worst = changed(worst, ['aead', 'ct'], b64(17_152));
    worst = changed(worst, ['createdAt'], 2 ** 53 - 1);
    const parsed = parseEnvelope(worst);
    expect(parsed.recipients).toHaveLength(8);
    const jcs = canonicalizeToBytes(parsed);
    expect(jcs.length).toBe(24_509);
    expect(jcs.length).toBeLessThanOrEqual(24_576);
    expect(() => parseUnsignedEnvelope(withoutSig(worst))).not.toThrow();
    expect(() => envelopeHash(worst as unknown as Envelope)).not.toThrow();
  });

  const twins = entries(4);
  twins[3] = { ...twins[3], kid: twins[0]!.kid };
  const limitCases: [string, Json][] = [
    ['9 recipients', changed(base, ['recipients'], entries(9))],
    ['100 recipients', changed(base, ['recipients'], entries(100))],
    ['a ct of 17 153 bytes', changed(base, ['aead', 'ct'], b64(17_153))],
    ['a ct of 22 871 characters', changed(base, ['aead', 'ct'], 'A'.repeat(22_871))],
    ['two recipients with the same kid', changed(base, ['recipients'], twins)],
    [
      'two identical recipients',
      changed(base, ['recipients'], [twins[0], twins[1], { ...twins[0] }]),
    ],
  ];
  it.each(limitCases)('rejects %s', (_name, envelope) => {
    expect(refusal(() => parseEnvelope(envelope)).code).toBe('invalid_envelope');
    expect(refusal(() => parseUnsignedEnvelope(withoutSig(envelope))).code).toBe(
      'invalid_envelope',
    );
    expect(refusal(() => envelopeHash(envelope as unknown as Envelope)).code).toBe(
      'invalid_envelope',
    );
    expect(refusal(() => verifyEnvelope(envelope as unknown as Envelope)).code).toBe(
      'invalid_envelope',
    );
  });

  it('applies the recipient limits to the header alone too', () => {
    const header = withoutSig(changed(base, ['recipients'], entries(9)));
    delete header.aead;
    expect(refusal(() => parseEnvelopeHeader(header)).code).toBe('invalid_envelope');
    expect(refusal(() => envelopeAad(header as unknown as EnvelopeHeader)).code).toBe(
      'invalid_envelope',
    );
    const twinHeader = withoutSig(changed(base, ['recipients'], twins));
    delete twinHeader.aead;
    expect(refusal(() => parseEnvelopeHeader(twinHeader)).code).toBe('invalid_envelope');
  });

  it('checks the ct length on the string, before decoding it', () => {
    // Not base64url at all: a parser that decoded first would report the encoding instead.
    for (const ct of ['!'.repeat(22_871), '!'.repeat(1_000_000)]) {
      const error = refusal(() => parseEnvelope(changed(base, ['aead', 'ct'], ct)));
      expect(error.code).toBe('invalid_envelope');
      expect(error.message).toMatch(/aead\.ct is longer than 17152 bytes/);
    }
    // At the limit, the encoding is still checked.
    const error = refusal(() => parseEnvelope(changed(base, ['aead', 'ct'], '!'.repeat(22_870))));
    expect(error.message).toMatch(/aead\.ct must be base64url/);
  });

  it('checks the recipient count before reading any entry', () => {
    const nine = changed(
      base,
      ['recipients'],
      Array.from({ length: 9 }, () => null),
    );
    expect(refusal(() => parseEnvelope(nine)).message).toMatch(/recipients must have 1 to 8/);
    const huge = changed(base, ['recipients'], []);
    (huge.recipients as unknown[]).length = 1_000_000;
    expect(refusal(() => parseEnvelope(huge)).message).toMatch(/recipients must have 1 to 8/);
  });
});

describe('parseUnsignedEnvelope and parseEnvelopeHeader', () => {
  it('parseUnsignedEnvelope accepts an envelope without sig and refuses one with sig', () => {
    const unsigned = sampleUnsigned();
    expect(parseUnsignedEnvelope(unsigned)).toEqual(unsigned);
    expect(refusal(() => parseUnsignedEnvelope(sampleSigned())).code).toBe('invalid_envelope');
  });

  it('parseEnvelopeHeader accepts exactly the six header fields', () => {
    const header = sampleHeader();
    expect(parseEnvelopeHeader(header)).toEqual(header);
    expect(refusal(() => parseEnvelopeHeader(sampleUnsigned())).code).toBe('invalid_envelope');
    expect(refusal(() => parseEnvelopeHeader(changed(header, ['v'], 2))).code).toBe(
      'invalid_envelope',
    );
  });
});

describe('envelopeHash = sha256(JCS(envelope without sig))', () => {
  it('is the SHA-256 of the RFC 8785 form without sig, signed or not', () => {
    const signed = sampleSigned();
    const unsigned = withoutSig(signed);
    const expected = sha256(canonicalizeToBytes(unsigned));
    expect(envelopeHash(signed as unknown as Envelope)).toEqual(expected);
    expect(envelopeHash(unsigned as unknown as UnsignedEnvelope)).toEqual(expected);
  });

  it('ignores sig and changes with every covered field', () => {
    const signed = sampleSigned();
    const reference = encodeHex(envelopeHash(signed as unknown as Envelope));
    const reversed = [...(signed.recipients as Json[])].reverse();
    const variants: Json[] = [
      changed(signed, ['createdAt'], 1760000001),
      changed(signed, ['recipients'], reversed),
      changed(signed, ['thread'], b64(16)),
      changed(signed, ['id'], b64(16)),
      changed(signed, ['from'], encodeHex(randomBytes(32))),
      changed(signed, ['recipients', 0, 'kid'], b64(16)),
      changed(signed, ['recipients', 3, 'enc'], b64(32)),
      changed(signed, ['recipients', 1, 'wk'], b64(48)),
      changed(signed, ['aead', 'iv'], b64(12)),
      changed(signed, ['aead', 'ct'], b64(40)),
    ];
    for (const variant of variants) {
      expect(encodeHex(envelopeHash(variant as unknown as Envelope))).not.toBe(reference);
    }
    const otherSig = changed(signed, ['sig'], encodeHex(randomBytes(64)));
    expect(encodeHex(envelopeHash(otherSig as unknown as Envelope))).toBe(reference);
  });

  it('refuses a malformed envelope instead of hashing it', () => {
    const bad = changed(sampleSigned(), ['from'], 'ABCD');
    expect(refusal(() => envelopeHash(bad as unknown as Envelope)).code).toBe('invalid_envelope');
  });
});

describe('envelopeAad = sha256(JCS({v, id, thread, from, createdAt, recipients}))', () => {
  it('hashes the six header fields, from a header or from a whole envelope', () => {
    const signed = sampleSigned();
    const header: Json = {};
    for (const key of ['v', 'id', 'thread', 'from', 'createdAt', 'recipients']) {
      header[key] = signed[key];
    }
    const expected = sha256(canonicalizeToBytes(header));
    expect(envelopeAad(header as unknown as EnvelopeHeader)).toEqual(expected);
    expect(envelopeAad(signed as unknown as Envelope)).toEqual(expected);
    const unsigned = withoutSig(signed);
    expect(envelopeAad(unsigned as unknown as UnsignedEnvelope)).toEqual(expected);
  });

  it('does not depend on aead or sig, and changes with every header field', () => {
    const signed = sampleSigned();
    const reference = encodeHex(envelopeAad(signed as unknown as Envelope));
    const same = changed(
      changed(signed, ['aead', 'ct'], b64(40)),
      ['sig'],
      encodeHex(randomBytes(64)),
    );
    expect(encodeHex(envelopeAad(same as unknown as Envelope))).toBe(reference);
    const reversed = [...(signed.recipients as Json[])].reverse();
    for (const variant of [
      changed(signed, ['createdAt'], 1760000001),
      changed(signed, ['recipients'], reversed),
      changed(signed, ['thread'], b64(16)),
      changed(signed, ['id'], b64(16)),
      changed(signed, ['from'], encodeHex(randomBytes(32))),
    ]) {
      expect(encodeHex(envelopeAad(variant as unknown as Envelope))).not.toBe(reference);
    }
  });

  it('refuses a header with an extra or a malformed field', () => {
    const header = sampleHeader();
    expect(refusal(() => envelopeAad({ ...header, x: 1 } as unknown as EnvelopeHeader)).code).toBe(
      'invalid_envelope',
    );
    const bad = changed(header, ['createdAt'], -5);
    expect(refusal(() => envelopeAad(bad as unknown as EnvelopeHeader)).code).toBe(
      'invalid_envelope',
    );
  });
});

describe('envelope signature: BIP-340 over taggedHash("agentlink/envelope/v1", envelopeHash)', () => {
  it('envelopeSignatureInput is the tagged hash under the envelope tag', () => {
    const digest = randomBytes(32);
    expect(envelopeSignatureInput(digest)).toEqual(taggedHash(TAGS.envelope, digest));
    expect(TAGS.envelope).toBe('agentlink/envelope/v1');
    expect(refusal(() => envelopeSignatureInput(randomBytes(31))).code).toBe('invalid_length');
  });

  it('signEnvelopeHash signs the tagged input; verifyEnvelope accepts it', () => {
    const envelope = signedBy(SECRET);
    const digest = envelopeHash(envelope as unknown as Envelope);
    const aux = randomBytes(32);
    expect(signEnvelopeHash(SECRET, digest, aux)).toEqual(
      bip340Sign(SECRET, envelopeSignatureInput(digest), aux),
    );
    expect(verifyEnvelope(envelope as unknown as Envelope)).toBe(true);
  });

  it('signEnvelopeHash refuses a digest that is not 32 bytes', () => {
    expect(refusal(() => signEnvelopeHash(SECRET, randomBytes(33))).code).toBe('invalid_length');
  });

  it('rejects any change to a covered field, including recipient order and createdAt', () => {
    const envelope = signedBy(SECRET);
    const reversed = [...(envelope.recipients as Json[])].reverse();
    for (const variant of [
      changed(envelope, ['createdAt'], 1760000001),
      changed(envelope, ['recipients'], reversed),
      changed(envelope, ['thread'], b64(16)),
      changed(envelope, ['id'], b64(16)),
      changed(envelope, ['recipients', 0, 'wk'], b64(48)),
      changed(envelope, ['aead', 'iv'], b64(12)),
      changed(envelope, ['aead', 'ct'], b64(40)),
    ]) {
      expect(verifyEnvelope(variant as unknown as Envelope)).toBe(false);
    }
  });

  it('rejects another signer, the untagged hash, the owner-action tag and a NIP-01 id', () => {
    const other = randomBytes(32);
    const unsigned = sampleUnsigned(encodeHex(bip340PublicKey(SECRET)));
    const digest = envelopeHash(unsigned as unknown as UnsignedEnvelope);
    // The NIP-01 id of a kind 14 rumor carrying this envelope (04 §3.1.1 domain table).
    const from = unsigned.from as string;
    const content = canonicalize(unsigned);
    const event = [0, from, unsigned.createdAt, 14, [['agentlink', '1']], content];
    const nip01Id = sha256(encodeUtf8(JSON.stringify(event)));
    const sigs = [
      bip340Sign(other, envelopeSignatureInput(digest)),
      bip340Sign(SECRET, digest),
      bip340Sign(SECRET, taggedHash(TAGS.ownerAction, digest)),
      bip340Sign(SECRET, nip01Id),
    ];
    for (const sig of sigs) {
      expect(verifyEnvelope({ ...unsigned, sig: encodeHex(sig) } as unknown as Envelope)).toBe(
        false,
      );
    }
    // `from` swapped for the signer's key after signing: from is covered by the hash.
    const byOther = signedBy(other, unsigned);
    const swapped = { ...byOther, from: encodeHex(bip340PublicKey(other)) };
    expect(verifyEnvelope(swapped as unknown as Envelope)).toBe(false);
  });

  it('returns false for a from that is not a curve point, and refuses a malformed envelope', () => {
    const envelope = signedBy(SECRET);
    // x = p + 3 is not below p, so it is no x-only key; the hex form is still well formed.
    const offCurve = changed(envelope, ['from'], 'f'.repeat(64));
    expect(verifyEnvelope(offCurve as unknown as Envelope)).toBe(false);
    const malformed = changed(envelope, ['sig'], (envelope.sig as string).toUpperCase());
    expect(refusal(() => verifyEnvelope(malformed as unknown as Envelope)).code).toBe(
      'invalid_envelope',
    );
  });
});
