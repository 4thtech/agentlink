// M1-21 (D-32, D-55): the `terms` schema, its canonical form, `TermsInput` and the pure negotiation
// chain rules (04 §3.4, 06 §2.2a). Hashing is in @agentlink/crypto (`termsHash`); nothing here hashes.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  TERMS_DEFAULT_VALIDITY_SECONDS,
  TERMS_LIMITS,
  TERMS_TOKEN_SYMBOLS,
  approvalActionSchema,
  evaluateIncomingOffer,
  isCanonicalTermsText,
  negotiationKey,
  newestOpenOffer,
  nextTermsLink,
  payloadSchema,
  sameTermsHash,
  termsAmountSchema,
  termsCurrencySchema,
  termsDueSchema,
  termsFromInput,
  termsInputJsonSchema,
  termsInputSchema,
  termsSchema,
  type StoredTermsOffer,
} from './index.js';
import { expectAccept, expectReject, expectRoundTrip } from './testing/assert.js';
import {
  AGENT_EVM,
  CONTACT_A,
  CONTACT_B,
  approvalActions,
  b64u,
  firstTerms,
  hex,
  payloads,
  terms,
  termsInput,
} from './testing/fixtures.js';

const H1 = hex(32, '01');
const H2 = hex(32, '02');
const H3 = hex(32, '03');
const H4 = hex(32, '04');
const ENV = (n: number) => b64u(16, String.fromCharCode(0x41 + n));

type Obj = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const withDeliverable = (over: Obj): Obj => {
  const t = terms();
  (t.deliverables as Obj[])[0] = { ...(t.deliverables as Obj[])[0], ...over };
  return t;
};
const withPrice = (over: Obj): Obj => {
  const t = terms();
  t.price = { ...(t.price as Obj), ...over };
  return t;
};
const withDeadline = (over: Obj): Obj => {
  const t = terms();
  (t.deadlines as Obj[])[0] = { ...(t.deadlines as Obj[])[0], ...over };
  return t;
};

// --- terms: shape ---------------------------------------------------------------------------------

describe('terms schema (04 §3.4, D-32)', () => {
  it('round-trips canonical terms unchanged', () => {
    expectRoundTrip(termsSchema, terms());
    expectRoundTrip(termsSchema, firstTerms());
    const noPrice = terms();
    delete noPrice.price;
    expectRoundTrip(termsSchema, noPrice);
    expectRoundTrip(termsSchema, terms({ deadlines: [] }));
    expectRoundTrip(termsSchema, withDeliverable({ plaintextSha256: H1 }));
  });

  it('is strict at every level: unknown keys are refused', () => {
    expectReject(termsSchema, terms({ extra: 1 }));
    expectReject(termsSchema, terms({ termsHash: H1 }));
    expectReject(termsSchema, withDeliverable({ extra: 1 }));
    expectReject(termsSchema, withPrice({ extra: 1 }));
    expectReject(termsSchema, withDeadline({ extra: 1 }));
  });

  it('requires every field except price', () => {
    for (const key of [
      'termsId',
      'version',
      'parties',
      'subject',
      'deliverables',
      'deadlines',
      'validUntil',
      'previousTermsHash',
    ]) {
      const t = terms();
      delete t[key];
      expectReject(termsSchema, t);
    }
    for (const key of ['id', 'description', 'by', 'plaintextSha256']) {
      const t = terms();
      delete ((t.deliverables as Obj[])[0] as Obj)[key];
      expectReject(termsSchema, t);
    }
    for (const key of ['amount', 'currency', 'payer']) {
      const t = terms();
      delete (t.price as Obj)[key];
      expectReject(termsSchema, t);
    }
    // One spelling: an absent price is absent, never null.
    expectReject(termsSchema, terms({ price: null }));
  });

  it('rejects non-objects without throwing', () => {
    for (const v of [null, undefined, 1, 'terms', [], [terms()], true]) {
      expect(termsSchema.safeParse(v).success).toBe(false);
    }
  });

  it('termsId is 16 bytes of canonical base64url (04 §2.4.1)', () => {
    expectReject(termsSchema, terms({ termsId: b64u(15, 'T') }));
    expectReject(termsSchema, terms({ termsId: b64u(17, 'T') }));
    expectReject(termsSchema, terms({ termsId: `${b64u(16, 'T')}==` }));
    expectReject(termsSchema, terms({ termsId: 'TTTTTTTTTTTTTTTTTTTTTB' })); // non-zero tail bits
  });

  it('version is a positive JSON integer; version 1 has no previous hash, later ones have one', () => {
    for (const version of [0, -1, 1.5, '1', 2 ** 53]) {
      expectReject(termsSchema, terms({ version }));
    }
    expectAccept(termsSchema, terms({ version: 1, previousTermsHash: null }));
    expectReject(termsSchema, terms({ version: 1, previousTermsHash: H1 }));
    expectReject(termsSchema, terms({ version: 2, previousTermsHash: null }));
  });

  it('validUntil is a positive JSON integer (unix seconds)', () => {
    for (const validUntil of [0, -1, 1.5, '1760600000', '2025-10-16T07:33:20Z', null]) {
      expectReject(termsSchema, terms({ validUntil }));
    }
  });

  it('hashes are 64 lower-case hex, bare (04 §2.4.1)', () => {
    for (const bad of [
      H1.toUpperCase(),
      `0x${H1}`,
      H1.slice(2),
      `${H1}00`,
      `${H1.slice(0, 63)}g`,
    ]) {
      expectReject(termsSchema, terms({ previousTermsHash: bad }));
      expectReject(termsSchema, withDeliverable({ plaintextSha256: bad }));
    }
  });

  it('parties are two distinct canonical agent IDs (0x + 40 lower-case hex)', () => {
    expectReject(termsSchema, terms({ parties: [AGENT_EVM] }));
    expectReject(termsSchema, terms({ parties: [AGENT_EVM, CONTACT_A, CONTACT_B] }));
    expectReject(termsSchema, terms({ parties: [AGENT_EVM, AGENT_EVM] }));
    expectReject(termsSchema, terms({ parties: [AGENT_EVM, CONTACT_A.toUpperCase()] }));
    expectReject(termsSchema, terms({ parties: [AGENT_EVM, `0x${'3D'.repeat(20)}`] }));
    expectReject(termsSchema, terms({ parties: [AGENT_EVM, CONTACT_A.slice(2)] }));
    // Either order is a valid spelling; it is hashed as written.
    expectAccept(
      termsSchema,
      terms({
        parties: [CONTACT_A, AGENT_EVM],
      }),
    );
  });

  it('payer and every deliverable `by` are one of the parties (04 §3.4)', () => {
    expectReject(termsSchema, withPrice({ payer: CONTACT_B }));
    expectReject(termsSchema, withDeliverable({ by: CONTACT_B }));
    expectAccept(termsSchema, withPrice({ payer: CONTACT_A }));
    expectAccept(termsSchema, withDeliverable({ by: AGENT_EVM }));
  });

  it('deliverable ids are unique, deadlines name a deliverable, once each', () => {
    const two = terms({
      deliverables: [
        { id: 'd1', description: 'one', by: CONTACT_A, plaintextSha256: null },
        { id: 'd1', description: 'two', by: CONTACT_A, plaintextSha256: null },
      ],
    });
    expectReject(termsSchema, two);
    expectReject(termsSchema, withDeadline({ ref: 'd2' }));
    expectReject(
      termsSchema,
      terms({
        deadlines: [
          { ref: 'd1', due: '2026-11-30T17:00:00Z' },
          { ref: 'd1', due: '2026-12-30T17:00:00Z' },
        ],
      }),
    );
    expectReject(termsSchema, terms({ deliverables: [] }));
  });
});

// --- terms: canonical form ------------------------------------------------------------------------

describe('canonical text (04 §3.4, IR-D55-1 F07): refused, never rewritten', () => {
  const BAD = [
    ['RLO', 'Spec ‮v2'],
    ['LRM', 'Spec‎ v2'],
    ['LRI', 'Spec ⁦v2⁩'],
    ['zero-width space', 'Spec​v2'],
    ['zero-width joiner', 'Spec‍v2'],
    ['BOM', '﻿Spec'],
    ['soft hyphen (Cf)', 'Spe­c'],
    ['tag character (Cf)', 'Spec\u{E0041}'],
    ['newline (C0)', 'Spec\nv2'],
    ['tab (C0)', 'Spec\tv2'],
    ['NUL (C0)', 'Spec\u0000'],
    ['DEL', 'Spec\u007F'],
    ['NEL (C1)', 'Spec\u0085v2'],
    ['CSI (C1)', 'Spec\u009B'],
    ['private use', 'Spec '],
    ['supplementary private use', 'Spec \u{F0000}'],
    ['lone surrogate', 'Spec \uD800'],
    ['NFD (e + combining acute)', 'Café'],
    ['not NFC (Angstrom sign)', 'Å'],
  ] as const;

  it.each(BAD)('%s is not canonical text', (_name, text) => {
    expect(isCanonicalTermsText(text)).toBe(false);
    expectReject(termsSchema, terms({ subject: text }));
    expectReject(termsSchema, withDeliverable({ description: text }));
    expectReject(termsSchema, withDeliverable({ id: `d${text}` }));
    expectReject(termsInputSchema, termsInput({ subject: text }));
  });

  it('an RLO in subject and a zero-width space in a deliverable are refused (card acceptance)', () => {
    expectReject(termsSchema, terms({ subject: 'Pay ‮0051 EUR' }));
    expectReject(termsSchema, withDeliverable({ description: 'Source​ code' }));
  });

  it('accepts NFC text in any script, with emoji and punctuation', () => {
    for (const text of ['Café', 'Спецификация v2', '仕様 第3段階', 'Deliver 🚀 — “now”', 'a']) {
      expect(isCanonicalTermsText(text)).toBe(true);
      expectAccept(termsSchema, terms({ subject: text }));
    }
  });

  it('never throws on non-strings', () => {
    for (const v of [null, undefined, 1, {}, []]) expect(isCanonicalTermsText(v)).toBe(false);
  });
});

describe('price.amount (04 §3.4: ^(0|[1-9][0-9]*)(\\.[0-9]{1,6})?$, > 0)', () => {
  it.each([
    '1500.00',
    '1500',
    '1',
    '0.000001',
    '0.5',
    '10',
    '1.000000',
    '123456789012345678901234',
  ])('accepts %s', (amount) => {
    expectAccept(termsAmountSchema, amount);
    expectAccept(termsSchema, withPrice({ amount }));
  });
  it.each([
    '0',
    '0.0',
    '0.000000',
    '1500.0000001',
    '01',
    '00.5',
    '1.',
    '.5',
    '+1',
    '-1',
    '1e3',
    ' 1',
    '1 ',
    '1,5',
    '١٢', // Arabic-Indic digits
    '',
    '1'.repeat(TERMS_LIMITS.amountLength + 1),
  ])('rejects %j', (amount) => {
    expectReject(termsAmountSchema, amount);
    expectReject(termsSchema, withPrice({ amount }));
  });
  it('rejects a JSON number', () => {
    expectReject(termsSchema, withPrice({ amount: 1500 }));
  });
});

describe('price.currency (04 §3.4: ISO 4217 shape or an allowlisted token symbol)', () => {
  it.each(['EUR', 'USD', 'JPY', ...TERMS_TOKEN_SYMBOLS])('accepts %s', (currency) => {
    expectAccept(termsCurrencySchema, currency);
    expectAccept(termsSchema, withPrice({ currency }));
  });
  it.each([
    'ЕUR', // Cyrillic Е
    'eur',
    'Eur',
    'EU',
    'EURO',
    'E R',
    'EUR ',
    'usdc',
    'USDc',
    'ＥＵＲ', // fullwidth
    '',
  ])('rejects %j', (currency) => {
    expectReject(termsCurrencySchema, currency);
    expectReject(termsSchema, withPrice({ currency }));
  });
});

describe('deadlines[].due (04 §3.4: YYYY-MM-DDTHH:MM:SSZ)', () => {
  it.each(['2026-11-30T17:00:00Z', '2028-02-29T00:00:00Z', '2026-12-31T23:59:59Z'])(
    'accepts %s',
    (due) => {
      expectAccept(termsDueSchema, due);
      expectAccept(termsSchema, withDeadline({ due }));
    },
  );
  it.each([
    '2026-11-30T17:00:00+00:00',
    '2026-11-30T18:00:00+01:00',
    '2026-11-30T17:00:00z',
    '2026-11-30t17:00:00Z',
    '2026-11-30 17:00:00Z',
    '2026-11-30T17:00:00.000Z',
    '2026-11-30T17:00Z',
    '2026-11-30',
    '2026-02-30T17:00:00Z',
    '2027-02-29T17:00:00Z',
    '2026-11-30T24:00:00Z',
    '2026-12-31T23:59:60Z',
    '2026-13-01T00:00:00Z',
    '２０２６-11-30T17:00:00Z',
  ])('rejects %j', (due) => {
    expectReject(termsDueSchema, due);
    expectReject(termsSchema, withDeadline({ due }));
  });
  it('rejects a number', () => {
    expectReject(termsSchema, withDeadline({ due: 1764522000 }));
  });
});

// --- terms: size limits ---------------------------------------------------------------------------

describe('size limits (inbound terms are untrusted, I-5)', () => {
  const deliverable = (i: number, description = 'x') => ({
    id: `d${i + 1}`,
    description,
    by: CONTACT_A,
    plaintextSha256: null,
  });

  it('bounds the subject', () => {
    expectAccept(termsSchema, terms({ subject: 'a'.repeat(TERMS_LIMITS.subjectCodePoints) }));
    expectAccept(termsSchema, terms({ subject: '😀'.repeat(TERMS_LIMITS.subjectCodePoints) }));
    expectReject(termsSchema, terms({ subject: 'a'.repeat(TERMS_LIMITS.subjectCodePoints + 1) }));
    expectReject(termsSchema, terms({ subject: '' }));
  });

  it('bounds deliverable ids and descriptions', () => {
    const maxId = 'd'.repeat(TERMS_LIMITS.deliverableIdCodePoints);
    expectAccept(
      termsSchema,
      terms({
        deliverables: [{ ...deliverable(0), id: maxId }],
        deadlines: [{ ref: maxId, due: '2026-11-30T17:00:00Z' }],
      }),
    );
    expectReject(termsSchema, withDeliverable({ id: `${maxId}d` }));
    expectReject(termsSchema, withDeliverable({ id: '' }));
    expectAccept(
      termsSchema,
      withDeliverable({ description: 'a'.repeat(TERMS_LIMITS.descriptionCodePoints) }),
    );
    expectReject(
      termsSchema,
      withDeliverable({ description: 'a'.repeat(TERMS_LIMITS.descriptionCodePoints + 1) }),
    );
    expectReject(termsSchema, withDeliverable({ description: '' }));
  });

  it('bounds the number of deliverables and deadlines', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => deliverable(i));
    expectAccept(termsSchema, terms({ deliverables: many(TERMS_LIMITS.deliverables) }));
    expectReject(termsSchema, terms({ deliverables: many(TERMS_LIMITS.deliverables + 1) }));
    const deadlines = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ref: `d${i + 1}`, due: '2026-11-30T17:00:00Z' }));
    expectAccept(
      termsSchema,
      terms({
        deliverables: many(TERMS_LIMITS.deadlines),
        deadlines: deadlines(TERMS_LIMITS.deadlines),
      }),
    );
  });

  it('bounds the whole terms object in UTF-8 bytes of its JSON form', () => {
    // Every field within its own limit, the whole over TERMS_LIMITS.maxBytes.
    const big = terms({
      deliverables: Array.from({ length: TERMS_LIMITS.deliverables }, (_, i) =>
        deliverable(i, '€'.repeat(TERMS_LIMITS.descriptionCodePoints)),
      ),
    });
    expect(JSON.stringify(big).length).toBeGreaterThan(TERMS_LIMITS.maxBytes / 3);
    expectReject(termsSchema, big);
    expect(TERMS_LIMITS.maxBytes).toBeLessThan(24 * 1024);
  });
});

// --- offer / accept / reject bodies ----------------------------------------------------------------

describe('offer / accept / reject carry strict terms (04 §3.4)', () => {
  it.each(['offer', 'accept', 'reject'])('%s parses with canonical terms', (type) => {
    expectRoundTrip(payloadSchema, payloads()[type]);
  });

  it.each(['offer', 'accept', 'reject'])('%s refuses non-canonical or loose terms', (type) => {
    const p = payloads()[type] as Obj;
    const body = p.body as Obj;
    expectReject(payloadSchema, {
      ...p,
      body: { ...body, terms: { termsId: b64u(16), version: 1 } },
    });
    expectReject(payloadSchema, {
      ...p,
      body: { ...body, terms: firstTerms({ subject: 'x‮y' }) },
    });
    expectReject(payloadSchema, {
      ...p,
      body: {
        ...body,
        terms: { ...firstTerms(), price: { amount: '0', currency: 'EUR', payer: AGENT_EVM } },
      },
    });
  });
});

// --- TermsInput ------------------------------------------------------------------------------------

describe('TermsInput (06 §2.2a, D-55)', () => {
  it('round-trips a valid input unchanged', () => {
    expectRoundTrip(termsInputSchema, termsInput());
    expectRoundTrip(termsInputSchema, {
      subject: 'x',
      deliverables: [{ description: 'y', by: 'me' }],
    });
    expectRoundTrip(
      termsInputSchema,
      termsInput({
        deliverables: [{ id: 'a', description: 'y', by: 'me', plaintextSha256: H1 }],
        deadlines: [{ ref: 'a', due: '2026-11-30T17:00:00Z' }],
      }),
    );
  });

  it.each(['termsId', 'version', 'parties', 'previousTermsHash', 'termsHash', 'note', 'extra'])(
    'rejects the core-filled or unknown key %s',
    (key) => {
      expectReject(termsInputSchema, termsInput({ [key]: key === 'version' ? 1 : H1 }));
    },
  );

  it('rejects unknown keys in nested objects', () => {
    const t = termsInput();
    ((t.deliverables as Obj[])[0] as Obj).extra = 1;
    expectReject(termsInputSchema, t);
    expectReject(
      termsInputSchema,
      termsInput({ price: { amount: '1', currency: 'EUR', payer: 'me', x: 1 } }),
    );
    expectReject(
      termsInputSchema,
      termsInput({ deadlines: [{ ref: 'd1', due: '2026-11-30T17:00:00Z', x: 1 }] }),
    );
  });

  it('`by` and `payer` are "me" or "them", never an agent ID', () => {
    expectReject(
      termsInputSchema,
      termsInput({ deliverables: [{ description: 'y', by: AGENT_EVM }] }),
    );
    expectReject(termsInputSchema, termsInput({ deliverables: [{ description: 'y', by: 'Me' }] }));
    expectReject(
      termsInputSchema,
      termsInput({ price: { amount: '1', currency: 'EUR', payer: CONTACT_A } }),
    );
  });

  it('applies the same canonical-form rules and size limits as terms', () => {
    expectReject(
      termsInputSchema,
      termsInput({ price: { amount: '1500.0000001', currency: 'EUR', payer: 'me' } }),
    );
    expectReject(
      termsInputSchema,
      termsInput({ price: { amount: '1', currency: 'ЕUR', payer: 'me' } }),
    );
    expectReject(
      termsInputSchema,
      termsInput({ deadlines: [{ ref: 'd1', due: '2026-11-30T18:00:00+01:00' }] }),
    );
    expectReject(
      termsInputSchema,
      termsInput({ subject: 'a'.repeat(TERMS_LIMITS.subjectCodePoints + 1) }),
    );
    expectReject(termsInputSchema, termsInput({ deliverables: [] }));
    expectReject(
      termsInputSchema,
      termsInput({
        deliverables: [{ description: 'y', by: 'me', plaintextSha256: H1.toUpperCase() }],
      }),
    );
    expectReject(termsInputSchema, termsInput({ validUntil: 1760600000 }));
    expectReject(termsInputSchema, termsInput({ validUntil: '2025-10-16T09:33:20+02:00' }));
    expectReject(termsInputSchema, termsInput({ price: null }));
  });

  it('has a JSON Schema for the MCP tools: strict objects, the same fields, no core-filled ones', () => {
    const schema = termsInputJsonSchema as Obj;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties as Record<string, Obj>;
    expect(Object.keys(props).sort()).toEqual(
      ['deadlines', 'deliverables', 'price', 'subject', 'validUntil'].sort(),
    );
    expect(schema.required).toEqual(expect.arrayContaining(['subject', 'deliverables']));
    expect((schema.required as string[]).length).toBe(2);
    // Every object at every depth is closed.
    const walk = (node: unknown) => {
      if (node === null || typeof node !== 'object') return;
      const o = node as Obj;
      if (o.type === 'object') expect(o.additionalProperties, JSON.stringify(o)).toBe(false);
      for (const v of Object.values(o)) walk(v);
    };
    walk(schema);
    const deliverableItems = (props.deliverables as Obj).items as Obj;
    const dProps = deliverableItems.properties as Record<string, Obj>;
    expect(dProps.by?.enum).toEqual(['me', 'them']);
    expect((props.price?.properties as Record<string, Obj>).payer?.enum).toEqual(['me', 'them']);
    expect(JSON.stringify(schema)).not.toMatch(/termsId|previousTermsHash|parties|"version"/);
    // It is plain JSON (it travels in the MCP tool list).
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe('termsFromInput: the mapping to terms with the core-filled fields', () => {
  const NOW = 1_760_000_000;
  const ctx = (over: Obj = {}) => ({
    termsId: b64u(16, 'T'),
    version: 1,
    previousTermsHash: null as string | null,
    self: AGENT_EVM,
    counterparty: CONTACT_A,
    now: NOW,
    ...over,
  });
  const ok = (input: unknown, c = ctx()) => {
    const r = termsFromInput(input, c);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    return r.data as Obj;
  };

  it('fills termsId, version, parties and previousTermsHash and maps me/them to agent IDs', () => {
    const t = ok(termsInput());
    expect(t).toStrictEqual(
      firstTerms({
        validUntil: 1760600000,
      }),
    );
    expectRoundTrip(termsSchema, t);
    const v2 = ok(termsInput(), ctx({ version: 2, previousTermsHash: H1 }));
    expect(v2.version).toBe(2);
    expect(v2.previousTermsHash).toBe(H1);
  });

  it('maps `me` and `them` from this agent’s side', () => {
    const t = ok(
      termsInput({
        deliverables: [
          { description: 'a', by: 'me' },
          { description: 'b', by: 'them' },
        ],
        price: { amount: '1', currency: 'USDC', payer: 'them' },
        deadlines: [],
      }),
    );
    expect((t.deliverables as Obj[]).map((d) => d.by)).toEqual([AGENT_EVM, CONTACT_A]);
    expect((t.price as Obj).payer).toBe(CONTACT_A);
    expect(t.parties).toEqual([AGENT_EVM, CONTACT_A]);
  });

  it('defaults deliverable ids to d1, d2, … by position and keeps given ids', () => {
    const t = ok(
      termsInput({
        deliverables: [
          { description: 'a', by: 'me' },
          { id: 'x', description: 'b', by: 'me' },
          { description: 'c', by: 'me' },
        ],
        deadlines: [{ ref: 'x', due: '2026-11-30T17:00:00Z' }],
      }),
    );
    expect((t.deliverables as Obj[]).map((d) => d.id)).toEqual(['d1', 'x', 'd3']);
    expect((t.deliverables as Obj[]).map((d) => d.plaintextSha256)).toEqual([null, null, null]);
  });

  it('refuses a default id that collides with a given one (never renames)', () => {
    const r = termsFromInput(
      termsInput({
        deliverables: [
          { id: 'd2', description: 'a', by: 'me' },
          { description: 'b', by: 'me' },
        ],
        deadlines: [],
      }),
      ctx(),
    );
    expect(r.success).toBe(false);
  });

  it('omits price and fills deadlines with [] when absent', () => {
    const t = ok({ subject: 's', deliverables: [{ description: 'd', by: 'them' }] });
    expect('price' in t).toBe(false);
    expect(t.deadlines).toEqual([]);
    expect(t.validUntil).toBe(NOW + TERMS_DEFAULT_VALIDITY_SECONDS);
    expect(TERMS_DEFAULT_VALIDITY_SECONDS).toBe(7 * 24 * 3600);
  });

  it('converts validUntil to unix seconds and refuses one that is not after now', () => {
    expect(ok(termsInput({ validUntil: '2025-10-09T08:53:21Z' })).validUntil).toBe(NOW + 1);
    expect(termsFromInput(termsInput({ validUntil: '2025-10-09T08:53:20Z' }), ctx()).success).toBe(
      false,
    );
    expect(termsFromInput(termsInput({ validUntil: '2020-01-01T00:00:00Z' }), ctx()).success).toBe(
      false,
    );
  });

  it('refuses invalid input, a bad context and the same agent on both sides; never throws', () => {
    for (const input of [null, 1, 'x', [], {}, termsInput({ termsId: b64u(16) })]) {
      expect(termsFromInput(input, ctx()).success).toBe(false);
    }
    expect(termsFromInput(termsInput(), ctx({ counterparty: AGENT_EVM })).success).toBe(false);
    expect(termsFromInput(termsInput(), ctx({ self: AGENT_EVM.toUpperCase() })).success).toBe(
      false,
    );
    expect(termsFromInput(termsInput(), ctx({ version: 2, previousTermsHash: null })).success).toBe(
      false,
    );
    expect(termsFromInput(termsInput(), ctx({ termsId: 'short' })).success).toBe(false);
  });

  it('refuses mapped terms over the byte limit', () => {
    const r = termsFromInput(
      termsInput({
        deliverables: Array.from({ length: TERMS_LIMITS.deliverables }, () => ({
          description: '€'.repeat(TERMS_LIMITS.descriptionCodePoints),
          by: 'me',
        })),
        deadlines: [],
      }),
      ctx(),
    );
    expect(r.success).toBe(false);
  });
});

// --- negotiation chain (04 §3.4, IR-D55-1 F04, IR-D55-2) -------------------------------------------

describe('negotiation key: termsId plus the unordered pair of parties', () => {
  it('is the same for either order and differs for another pair', () => {
    const id = b64u(16, 'T');
    expect(negotiationKey(id, [AGENT_EVM, CONTACT_A])).toBe(
      negotiationKey(id, [CONTACT_A, AGENT_EVM]),
    );
    expect(negotiationKey(id, [AGENT_EVM, CONTACT_A])).not.toBe(
      negotiationKey(id, [AGENT_EVM, CONTACT_B]),
    );
    expect(negotiationKey(id, [AGENT_EVM, CONTACT_A])).not.toBe(
      negotiationKey(b64u(16, 'U'), [AGENT_EVM, CONTACT_A]),
    );
  });
});

describe('sameTermsHash compares bytes of canonical hashes only', () => {
  it('is true only for the same canonical hash', () => {
    expect(sameTermsHash(H1, H1)).toBe(true);
    expect(sameTermsHash(H1, H2)).toBe(false);
    expect(sameTermsHash(H1, H1.toUpperCase())).toBe(false);
    expect(sameTermsHash(`0x${H1}`, `0x${H1}`)).toBe(false);
    expect(sameTermsHash(null, null)).toBe(false);
  });
});

const offer = (
  n: number,
  sender: string,
  version: number,
  termsHash: string,
  state: 'open' | 'conflict' = 'open',
): StoredTermsOffer => ({ envelopeId: ENV(n), sender, version, termsHash, state });

/** Incoming offer `version` from `sender` pointing at `prev`, in envelope `n`. */
const incoming = (
  n: number,
  sender: string,
  version: number,
  prev: string | null,
  extra: Obj = {},
) => ({
  envelopeId: ENV(n),
  sender,
  self: sender === CONTACT_A ? AGENT_EVM : CONTACT_A,
  terms: terms({ version, previousTermsHash: prev, ...extra }) as never,
});

describe('chain link for sending: newest + 1, pointer = newest hash', () => {
  it('starts at version 1 with no pointer', () => {
    expect(nextTermsLink([])).toEqual({ version: 1, previousTermsHash: null });
  });
  it('follows the newest open offer and skips conflicted ones', () => {
    const offers = [offer(1, AGENT_EVM, 1, H1), offer(2, CONTACT_A, 2, H2)];
    expect(nextTermsLink(offers)).toEqual({ version: 3, previousTermsHash: H2 });
    const conflicted = [
      ...offers,
      offer(3, AGENT_EVM, 3, H3, 'conflict'),
      offer(4, CONTACT_A, 3, H4, 'conflict'),
    ];
    expect(newestOpenOffer(conflicted)?.envelopeId).toBe(ENV(2));
    expect(nextTermsLink(conflicted)).toEqual({ version: 3, previousTermsHash: H2 });
  });
});

describe('evaluateIncomingOffer: chain checks against the receiver’s own store', () => {
  const state = (offers: StoredTermsOffer[], lockedVersions: number[] = []) => ({
    offers,
    lockedVersions,
  });

  it('accepts a first offer (version 1, no pointer) and the next version on the newest hash', () => {
    expect(evaluateIncomingOffer(incoming(1, CONTACT_A, 1, null), state([]))).toEqual({
      result: 'accept',
    });
    expect(
      evaluateIncomingOffer(
        incoming(3, CONTACT_A, 3, H2),
        state([offer(1, CONTACT_A, 1, H1), offer(2, AGENT_EVM, 2, H2)]),
      ),
    ).toEqual({ result: 'accept' });
  });

  it('refuses a version gap', () => {
    expect(
      evaluateIncomingOffer(incoming(3, CONTACT_A, 3, H1), state([offer(1, CONTACT_A, 1, H1)])),
    ).toEqual({
      result: 'refuse',
      reason: 'version_gap',
    });
    expect(evaluateIncomingOffer(incoming(1, CONTACT_A, 2, H1), state([]))).toEqual({
      result: 'refuse',
      reason: 'version_gap',
    });
  });

  it('refuses a pointer to an older version', () => {
    const s = state([offer(1, CONTACT_A, 1, H1), offer(2, AGENT_EVM, 2, H2)]);
    expect(evaluateIncomingOffer(incoming(3, CONTACT_A, 3, H1), s)).toEqual({
      result: 'refuse',
      reason: 'previous_mismatch',
    });
    // A pointer to a hash this side never saw is a mismatch too.
    expect(evaluateIncomingOffer(incoming(3, CONTACT_A, 3, H3), s)).toEqual({
      result: 'refuse',
      reason: 'previous_mismatch',
    });
  });

  it('refuses an old version re-sent as new', () => {
    // v2 (the receiver's own) already has a v3 on top, so a contact's v2 is stale, not concurrent.
    const s = state([
      offer(1, CONTACT_A, 1, H1),
      offer(2, AGENT_EVM, 2, H2),
      offer(3, CONTACT_A, 3, H3),
    ]);
    expect(evaluateIncomingOffer(incoming(5, CONTACT_A, 2, H1), s)).toEqual({
      result: 'refuse',
      reason: 'stale_version',
    });
  });

  it('the same termsId from another pair is another negotiation', () => {
    // The receiver looks the state up by negotiationKey; the other pair's offers are never in it.
    const t = terms({ parties: [AGENT_EVM, CONTACT_B] }) as {
      termsId: string;
      parties: [string, string];
    };
    expect(negotiationKey(t.termsId, t.parties)).not.toBe(
      negotiationKey(t.termsId, [AGENT_EVM, CONTACT_A]),
    );
    expect(
      evaluateIncomingOffer(
        {
          ...incoming(9, CONTACT_B, 1, null),
          self: AGENT_EVM,
          terms: firstTerms({
            parties: [AGENT_EVM, CONTACT_B],
            deliverables: [{ id: 'd1', description: 'x', by: CONTACT_B, plaintextSha256: null }],
          }) as never,
        },
        state([]),
      ),
    ).toEqual({ result: 'accept' });
  });

  it('refuses terms whose parties are not exactly the sender and the receiver', () => {
    expect(
      evaluateIncomingOffer({ ...incoming(1, CONTACT_A, 1, null), sender: CONTACT_B }, state([])),
    ).toEqual({ result: 'refuse', reason: 'not_a_party' });
    expect(
      evaluateIncomingOffer({ ...incoming(1, CONTACT_A, 1, null), self: CONTACT_B }, state([])),
    ).toEqual({ result: 'refuse', reason: 'not_a_party' });
  });

  it('no fork 1: a second envelope for one version from the same sender is refused', () => {
    const s = state([offer(1, CONTACT_A, 1, H1), offer(2, CONTACT_A, 2, H2)]);
    expect(evaluateIncomingOffer(incoming(3, CONTACT_A, 2, H1), s)).toEqual({
      result: 'refuse',
      reason: 'same_sender',
    });
    // The same envelope seen again is a duplicate, not a fork.
    expect(evaluateIncomingOffer(incoming(2, CONTACT_A, 2, H1), s)).toEqual({
      result: 'duplicate',
    });
  });

  it('no fork 2: a version is locked once an accept for it was sent or received', () => {
    const s = state([offer(1, CONTACT_A, 1, H1), offer(2, AGENT_EVM, 2, H2)], [2]);
    expect(evaluateIncomingOffer(incoming(3, CONTACT_A, 2, H1), s)).toEqual({
      result: 'refuse',
      reason: 'locked',
    });
  });

  it('no fork 3: concurrent counters from both sides are a conflict, with no tie-break', () => {
    // Both hold v1 (H1); this side already sent its own v2 (H2); the contact's v2 arrives.
    const mine = state([offer(1, CONTACT_A, 1, H1), offer(2, AGENT_EVM, 2, H2)]);
    expect(evaluateIncomingOffer(incoming(3, CONTACT_A, 2, H1), mine)).toEqual({
      result: 'conflict',
      with: ENV(2),
    });
    // The other side sees the mirror image and reaches the same result.
    const theirs = state([offer(1, CONTACT_A, 1, H1), offer(3, CONTACT_A, 2, H3)]);
    expect(evaluateIncomingOffer(incoming(2, AGENT_EVM, 2, H1), theirs)).toEqual({
      result: 'conflict',
      with: ENV(3),
    });
    // After the conflict the previous version stays the newest, and either side may send v2 again.
    const after = state([
      offer(1, CONTACT_A, 1, H1),
      offer(2, AGENT_EVM, 2, H2, 'conflict'),
      offer(3, CONTACT_A, 2, H3, 'conflict'),
    ]);
    expect(nextTermsLink(after.offers)).toEqual({ version: 2, previousTermsHash: H1 });
    expect(evaluateIncomingOffer(incoming(4, CONTACT_A, 2, H1), after)).toEqual({
      result: 'accept',
    });
  });

  it('a concurrent counter that does not link to the shared base is refused, not a conflict', () => {
    const mine = state([offer(1, CONTACT_A, 1, H1), offer(2, AGENT_EVM, 2, H2)]);
    expect(evaluateIncomingOffer(incoming(3, CONTACT_A, 2, H4), mine)).toEqual({
      result: 'refuse',
      reason: 'previous_mismatch',
    });
  });

  it('never throws on hostile input', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (a, b) => {
        expect(() => evaluateIncomingOffer(a as never, b as never)).not.toThrow();
      }),
      { numRuns: 200, seed: 0x7e21 },
    );
  });
});

// --- fuzzing ---------------------------------------------------------------------------------------

describe('fuzzing: only validation errors (card acceptance)', () => {
  const RUNS = { numRuns: 300, seed: 0x4a21 } as const;
  const anyInput = fc.oneof(
    fc.jsonValue(),
    fc.anything({ withBigInt: true, withNullPrototype: true, withObjectString: true }),
  );
  const mutate = (valid: Obj, replacement: unknown, pick: number) => {
    const copy = clone(valid);
    const slots: [Obj, string][] = [];
    const walk = (node: unknown) => {
      if (node === null || typeof node !== 'object') return;
      for (const key of Object.keys(node)) {
        slots.push([node as Obj, key]);
        walk((node as Obj)[key]);
      }
    };
    walk(copy);
    const [parent, key] = slots[pick % slots.length] as [Obj, string];
    parent[key] = replacement;
    return copy;
  };
  const total = (schema: z.ZodType, input: unknown) => {
    expect(() => schema.safeParse(input)).not.toThrow();
    try {
      schema.parse(input);
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
    }
  };

  it.each([
    ['terms', termsSchema, terms],
    ['termsInput', termsInputSchema, termsInput],
  ] as const)('%s', (_name, schema, make) => {
    fc.assert(
      fc.property(anyInput, (input) => total(schema, input)),
      RUNS,
    );
    fc.assert(
      fc.property(anyInput, fc.nat(), (r, pick) => total(schema, mutate(make(), r, pick))),
      RUNS,
    );
  });

  it('termsFromInput never throws', () => {
    fc.assert(
      fc.property(anyInput, fc.nat(), (r, pick) => {
        expect(() =>
          termsFromInput(mutate(termsInput(), r, pick), {
            termsId: b64u(16, 'T'),
            version: 1,
            previousTermsHash: null,
            self: AGENT_EVM,
            counterparty: CONTACT_A,
            now: 1_760_000_000,
          }),
        ).not.toThrow();
      }),
      RUNS,
    );
  });

  it('text fuzz: canonical text never contains a forbidden code point and is NFC', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        if (isCanonicalTermsText(s)) {
          expect(s.normalize('NFC')).toBe(s);
          expect(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u.test(s)).toBe(false);
        }
      }),
      { numRuns: 1000, seed: 0x7e22 },
    );
  });
});

// --- commitment approvals carry the strict shapes (04 §3.4.2) ---------------------------------------

describe('commitment approval actions use the strict terms and TermsInput (M1-21)', () => {
  const action = (tool: 'agentlink_propose_terms' | 'agentlink_respond_to_terms') =>
    clone(approvalActions()[tool]) as Obj & { args: Obj; context: Obj };

  it('the fixtures parse', () => {
    expectAccept(approvalActionSchema, action('agentlink_propose_terms'));
    expectAccept(approvalActionSchema, action('agentlink_respond_to_terms'));
  });

  it.each(['agentlink_propose_terms', 'agentlink_respond_to_terms'] as const)(
    '%s: context.terms must be canonical terms of the scope’s negotiation and version',
    (tool) => {
      const bad = (over: Obj) => {
        const a = action(tool);
        a.context.terms = terms(over);
        return a;
      };
      expectReject(approvalActionSchema, bad({ subject: 'x‮y' }));
      expectReject(approvalActionSchema, bad({ termsId: b64u(16, 'U') }));
      expectReject(approvalActionSchema, bad({ version: 2 }));
      expectReject(
        approvalActionSchema,
        bad({
          parties: [AGENT_EVM, CONTACT_B],
          deliverables: [{ id: 'd1', description: 'x', by: CONTACT_B, plaintextSha256: null }],
        }),
      );
      // The scope never outlives the terms (04 §3.4.2: expiry no later than validUntil).
      expectReject(approvalActionSchema, bad({ validUntil: 1760599999 }));
      const loose = action(tool);
      loose.context.terms = { termsId: b64u(16, 'T'), version: 3 };
      expectReject(approvalActionSchema, loose);
    },
  );

  it('propose args.terms is a strict TermsInput', () => {
    const a = action('agentlink_propose_terms');
    a.args.terms = termsInput({ termsId: b64u(16, 'T') });
    expectReject(approvalActionSchema, a);
    const b = action('agentlink_propose_terms');
    b.args.terms = { price: 1 };
    expectReject(approvalActionSchema, b);
  });

  it('respond args.terms (counter) is a strict TermsInput', () => {
    const a = action('agentlink_respond_to_terms');
    a.args = { envelopeId: b64u(16), decision: 'counter', terms: termsInput(), notarize: true };
    a.context.scope = { ...(a.context.scope as Obj), decision: 'offer', answers: null };
    expectAccept(approvalActionSchema, a);
    a.args.terms = termsInput({ version: 4 });
    expectReject(approvalActionSchema, a);
  });
});
