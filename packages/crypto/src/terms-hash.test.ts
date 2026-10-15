// M1-21 (D-32): termsHash = sha256(JCS(terms)), RFC 8785, bare 64 lower-case hex (04 §2.4.1, §3.4).
// The shape and canonical form of `terms` are checked by @agentlink/types (`termsSchema`) before
// hashing; this helper hashes exactly the JSON value it is given.
import { describe, expect, it } from 'vitest';
import { CryptoInputError, parseJson, termsHash, verifyTermsHash } from './index.js';

const A = `0x${'1a'.repeat(20)}`;
const B = `0x${'3d'.repeat(20)}`;

const terms = (): Record<string, unknown> => ({
  termsId: 'TTTTTTTTTTTTTTTTTTTTTA',
  version: 1,
  parties: [A, B],
  subject: 'Spec v2 – milestone 3',
  deliverables: [{ id: 'd1', description: 'Revised spec', by: B, plaintextSha256: null }],
  price: { amount: '1500.00', currency: 'EUR', payer: A },
  deadlines: [{ ref: 'd1', due: '2026-11-30T17:00:00Z' }],
  validUntil: 1760600000,
  previousTermsHash: null,
});

// Known answer: SHA-256 of the RFC 8785 text of `terms()` (keys sorted, no whitespace, UTF-8), computed
// outside this package with Python's hashlib over json.dumps(sort_keys=True, separators=(',', ':'),
// ensure_ascii=False), which equals JCS for this value (strings and small integers only).
const KAT = '336e1839b21de6adc7f650028a9dec9f7f45647c1c9a4dbd1e7da228fe2e0fc9';

describe('termsHash (04 §3.4)', () => {
  it('is sha256 over the JCS form, as bare lower-case hex', () => {
    expect(termsHash(terms())).toBe(KAT);
    expect(termsHash(terms())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order or whitespace', () => {
    const reordered = Object.fromEntries(Object.entries(terms()).reverse());
    expect(termsHash(reordered)).toBe(KAT);
    const spaced = JSON.stringify(terms(), null, 2).replace(/\n/g, '\r\n ');
    expect(termsHash(parseJson(spaced))).toBe(KAT);
  });

  it('changes when any covered field changes', () => {
    const edits: [string, (t: Record<string, unknown>) => void][] = [
      ['termsId', (t) => (t.termsId = 'UUUUUUUUUUUUUUUUUUUUUA')],
      ['version', (t) => (t.version = 2)],
      ['parties order', (t) => (t.parties = [B, A])],
      ['subject', (t) => (t.subject = 'Spec v2 - milestone 3')],
      ['deliverable id', (t) => ((t.deliverables as Record<string, unknown>[])[0]!.id = 'd2')],
      [
        'description',
        (t) => ((t.deliverables as Record<string, unknown>[])[0]!.description = 'Revised spec.'),
      ],
      ['by', (t) => ((t.deliverables as Record<string, unknown>[])[0]!.by = A)],
      [
        'plaintextSha256',
        (t) =>
          ((t.deliverables as Record<string, unknown>[])[0]!.plaintextSha256 = 'ab'.repeat(32)),
      ],
      ['amount', (t) => ((t.price as Record<string, unknown>).amount = '1500.0')],
      ['currency', (t) => ((t.price as Record<string, unknown>).currency = 'USD')],
      ['payer', (t) => ((t.price as Record<string, unknown>).payer = B)],
      ['no price', (t) => delete t.price],
      ['due', (t) => ((t.deadlines as Record<string, unknown>[])[0]!.due = '2026-11-30T17:00:01Z')],
      ['no deadlines', (t) => (t.deadlines = [])],
      ['validUntil', (t) => (t.validUntil = 1760600001)],
      ['previousTermsHash', (t) => (t.previousTermsHash = 'cd'.repeat(32))],
    ];
    const seen = new Set([KAT]);
    for (const [name, edit] of edits) {
      const t = terms();
      edit(t);
      const h = termsHash(t);
      expect(seen.has(h), name).toBe(false);
      seen.add(h);
    }
  });

  it('refuses anything that is not a JSON object', () => {
    for (const v of [null, undefined, 1, 'terms', [], [terms()], true, new Date(0), new Map()]) {
      expect(() => termsHash(v)).toThrow(CryptoInputError);
    }
    const cyclic: Record<string, unknown> = terms();
    cyclic.self = cyclic;
    expect(() => termsHash(cyclic)).toThrow(CryptoInputError);
    expect(() => termsHash({ ...terms(), subject: 'x\uD800' })).toThrow(CryptoInputError);
    expect(() => termsHash({ ...terms(), validUntil: Number.NaN })).toThrow(CryptoInputError);
  });
});

describe('verifyTermsHash: an accept or reject binds the exact terms it answers', () => {
  it('is true only for the canonical spelling of the matching hash', () => {
    expect(verifyTermsHash(terms(), KAT)).toBe(true);
    expect(verifyTermsHash(terms(), KAT.toUpperCase())).toBe(false);
    expect(verifyTermsHash(terms(), `0x${KAT}`)).toBe(false);
    expect(verifyTermsHash(terms(), KAT.slice(1))).toBe(false);
    expect(verifyTermsHash(terms(), `${KAT.slice(0, 63)}0`)).toBe(false);
  });

  it('an accept whose termsHash is not the offer’s is rejected', () => {
    const offer = { terms: terms(), termsHash: KAT };
    const changed = { ...terms(), price: { amount: '1.00', currency: 'EUR', payer: A } };
    // An accept that quotes the offer's hash but carries other terms fails its own check.
    expect(verifyTermsHash(changed, offer.termsHash)).toBe(false);
    // An accept that carries its own consistent hash still does not match the offer's.
    const accept = { terms: changed, termsHash: termsHash(changed) };
    expect(verifyTermsHash(accept.terms, accept.termsHash)).toBe(true);
    expect(accept.termsHash === offer.termsHash).toBe(false);
  });

  it('never throws', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const [t, h] of [
      [null, KAT],
      [cyclic, KAT],
      [terms(), null],
      [terms(), 42],
      [[], KAT],
    ] as const) {
      expect(verifyTermsHash(t, h)).toBe(false);
    }
  });
});
