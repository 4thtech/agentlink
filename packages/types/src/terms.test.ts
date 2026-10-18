// M1-21 (D-32, D-55, D-74): the `terms` schema, its canonical form, `TermsInput` and the body
// shapes (04 §3.4, 06 §2.2a). Hashing is in @4thtech-io/crypto (`termsHash`); nothing here hashes.
// The negotiation chain is in terms-chain.test.ts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  TERMS_DEFAULT_VALIDITY_SECONDS,
  TERMS_LIMITS,
  TERMS_TOKEN_SYMBOLS,
  UNSUPPORTED_RUNTIME,
  acceptBodySchema,
  approvalActionSchema,
  approvalRequestBodySchema,
  isCanonicalTermsText,
  isTermsRuntimeSupported,
  offerBodySchema,
  parseTermsInput,
  payloadSchema,
  refusedCategory15,
  rejectBodySchema,
  termsAmountSchema,
  termsCurrencySchema,
  termsDueSchema,
  termsFromInput,
  termsInputJsonSchema,
  termsInputSchema,
  termsSchema,
} from './index.js';
import { expectAccept, expectReject, expectRoundTrip } from './testing/assert.js';
import {
  AGENT_EVM,
  CONTACT_A,
  CONTACT_B,
  SHA,
  approvalActions,
  approvalRequestFor,
  b64u,
  firstTerms,
  hex,
  payloads,
  terms,
  termsInput,
} from './testing/fixtures.js';

const H1 = hex(32, 'a1');

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

describe('terms schema (04 §3.4, D-32, D-74)', () => {
  it('round-trips canonical terms unchanged', () => {
    expectRoundTrip(termsSchema, terms());
    expectRoundTrip(termsSchema, firstTerms());
    expectRoundTrip(termsSchema, terms({ price: null }));
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

  it('D-74 key presence: every key is always present; null only in the four nullable places', () => {
    for (const key of [
      'termsId',
      'version',
      'parties',
      'subject',
      'deliverables',
      'price',
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
    expectReject(termsSchema, terms({ deadlines: null }));
    expectReject(termsSchema, terms({ subject: null }));
    expectReject(termsSchema, withDeliverable({ id: null }));
    expectReject(termsSchema, withPrice({ currency: null }));
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

  it('D-74 version and pointer: version 1 exactly when previousTermsHash is null, at parse', () => {
    for (const version of [0, -1, 1.5, '1', 2 ** 53]) {
      expectReject(termsSchema, terms({ version }));
    }
    expectAccept(termsSchema, terms({ version: 1, previousTermsHash: null }));
    expectReject(termsSchema, terms({ version: 1, previousTermsHash: H1 }));
    expectReject(termsSchema, terms({ version: 2, previousTermsHash: null }));
  });

  it('D-74 validUntil is an integer from 1 to 2^53 - 1', () => {
    expectAccept(termsSchema, terms({ validUntil: 1 }));
    expectAccept(termsSchema, terms({ validUntil: Number.MAX_SAFE_INTEGER }));
    for (const validUntil of [0, -1, 1.5, 2 ** 53, '1760600000', '2025-10-16T07:33:20Z', null]) {
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

  it('D-74 parties: two distinct canonical agent IDs in ascending byte order', () => {
    expectReject(termsSchema, terms({ parties: [AGENT_EVM] }));
    expectReject(termsSchema, terms({ parties: [AGENT_EVM, CONTACT_A, CONTACT_B] }));
    expectReject(termsSchema, terms({ parties: [AGENT_EVM, AGENT_EVM] }));
    expectReject(termsSchema, terms({ parties: [AGENT_EVM, CONTACT_A.toUpperCase()] }));
    expectReject(termsSchema, terms({ parties: [AGENT_EVM, `0x${'3D'.repeat(20)}`] }));
    expectReject(termsSchema, terms({ parties: [AGENT_EVM, CONTACT_A.slice(2)] }));
    // AGENT_EVM (0x1a…) < CONTACT_A (0x3d…): only the ascending order is a valid spelling.
    expectReject(termsSchema, terms({ parties: [CONTACT_A, AGENT_EVM] }));
  });

  it('payer and every deliverable `by` are one of the parties (04 §3.4)', () => {
    expectReject(termsSchema, withPrice({ payer: CONTACT_B }));
    expectReject(termsSchema, withDeliverable({ by: CONTACT_B }));
    expectAccept(termsSchema, withPrice({ payer: CONTACT_A }));
    expectAccept(termsSchema, withDeliverable({ by: AGENT_EVM }));
  });

  it('D-74 deliverable ids are unique; deadline refs name a deliverable and are unique', () => {
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

describe('D-74 characters: UCD 15.0.0 Cc, Cf, Zl, Zp, Co, Cs, Cn refused, and NFC', () => {
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
    ['LINE SEPARATOR (Zl)', 'Spec v2'],
    ['PARAGRAPH SEPARATOR (Zp)', 'Spec v2'],
    ['private use', 'Spec '],
    ['supplementary private use', 'Spec \u{F0000}'],
    ['lone surrogate', 'Spec \uD800'],
    ['unassigned (U+0378)', 'Spec ͸'],
    ['noncharacter U+FDD0', 'Spec ﷐'],
    ['noncharacter U+FFFF', 'Spec ￿'],
    ['noncharacter U+10FFFF', 'Spec \u{10FFFF}'],
    ['assigned only in 15.1 (U+2FFC)', 'Spec ⿼'],
    ['assigned only in 16.0 (U+1CC00)', 'Spec \u{1CC00}'],
    ['NFD (e + combining acute)', 'Café'],
    ['not NFC (Angstrom sign)', 'Å'],
  ] as const;

  it.each(BAD)('%s is not canonical text', (_name, text) => {
    expect(isCanonicalTermsText(text)).toBe(false);
    expectReject(termsSchema, terms({ subject: text }));
    expectReject(termsSchema, withDeliverable({ description: text }));
    expectReject(termsInputSchema, termsInput({ subject: text }));
    expectReject(offerBodySchema, { terms: firstTerms(), termsHash: SHA, note: text });
  });

  it('an RLO in subject and a zero-width space in a deliverable are refused (card acceptance)', () => {
    expectReject(termsSchema, terms({ subject: 'Pay ‮0051 EUR' }));
    expectReject(termsSchema, withDeliverable({ description: 'Source​ code' }));
  });

  it('accepts NFC text in any script, with emoji and punctuation, and a 15.0 addition', () => {
    for (const text of [
      'Café',
      'Спецификация v2',
      '仕様 第3段階',
      'Deliver 🚀 — “now”',
      'a',
      'x\u{10EFD}́',
    ]) {
      expect(isCanonicalTermsText(text)).toBe(true);
      expectAccept(termsSchema, terms({ subject: text }));
    }
  });

  it('never throws on non-strings', () => {
    for (const v of [null, undefined, 1, {}, []]) expect(isCanonicalTermsText(v)).toBe(false);
  });
});

describe('the pinned UCD 15.0.0 table', () => {
  it('gives the 15.0.0 category of known code points', () => {
    const cases: [number, string | null][] = [
      [0x41, null],
      [0x00, 'Cc'],
      [0x7f, 'Cc'],
      [0x9f, 'Cc'],
      [0xad, 'Cf'],
      [0x200b, 'Cf'],
      [0xfeff, 'Cf'],
      [0x2028, 'Zl'],
      [0x2029, 'Zp'],
      [0xe000, 'Co'],
      [0x10fffd, 'Co'],
      [0xd800, 'Cs'],
      [0xdfff, 'Cs'],
      [0x0378, 'Cn'],
      [0xfdd0, 'Cn'],
      [0xffff, 'Cn'],
      [0x10ffff, 'Cn'],
      [0x2ffc, 'Cn'], // assigned in 15.1
      [0x31ef, 'Cn'], // assigned in 15.1
      [0x1cc00, 'Cn'], // assigned in 16.0
      [0x10efd, null], // assigned in 15.0 (Mn)
      [0x1f600, null],
      [0x20, null],
    ];
    for (const [cp, category] of cases)
      expect(refusedCategory15(cp), cp.toString(16)).toBe(category);
    expect(refusedCategory15(-1)).toBe(null);
    expect(refusedCategory15(0x110000)).toBe(null);
  });

  it('agrees with this runtime wherever Unicode stability guarantees it', () => {
    // Cc, Co and Cs never change; a code point unassigned in this runtime (Unicode >= 15) was
    // unassigned in 15.0.0 too. So each must be refused by the 15.0.0 table with the same category.
    const runtime = /\p{Cc}|\p{Co}|\p{Cs}|\p{Cn}/u;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!runtime.test(ch)) continue;
      const expected = /\p{Cn}/u.test(ch)
        ? 'Cn'
        : /\p{Cc}/u.test(ch)
          ? 'Cc'
          : /\p{Co}/u.test(ch)
            ? 'Co'
            : 'Cs';
      if (refusedCategory15(cp) !== expected) {
        expect(refusedCategory15(cp), `U+${cp.toString(16)}`).toBe(expected);
      }
    }
  });

  it('the runtime implements Unicode 15.0 or later (the D-74 probe)', () => {
    expect(isTermsRuntimeSupported()).toBe(true);
    expect('x́\u{10EFD}'.normalize('NFC')).toBe('x\u{10EFD}́');
    expect(UNSUPPORTED_RUNTIME).toBe('UNSUPPORTED_RUNTIME');
  });

  it('approval-request.summary uses the same table for Cc, Cf, Zl and Zp', () => {
    const ok = approvalRequestFor(approvalActions().agentlink_send);
    expectAccept(approvalRequestBodySchema, ok);
    for (const bad of ['a b', 'a­b', 'a\u0085b', 'a‍b']) {
      expectReject(approvalRequestBodySchema, { ...ok, summary: bad });
    }
  });
});

describe('D-74 price.amount: ^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,6})?$, > 0', () => {
  it.each([
    '1500.00',
    '1500',
    '1',
    '0.000001',
    '0.5',
    '10',
    '1.000000',
    '999999999999999999.999999',
    '100000000000000000',
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
    '1'.repeat(19),
    '1234567890123456789012345678901234567890.5',
  ])('rejects %j', (amount) => {
    expectReject(termsAmountSchema, amount);
    expectReject(termsSchema, withPrice({ amount }));
  });
  it('rejects a JSON number', () => {
    expectReject(termsSchema, withPrice({ amount: 1500 }));
  });
});

describe('D-74 price.currency: the grammar ^[A-Z]{3}$ or exactly USDC, USDT or XDAI', () => {
  it('lists exactly the D-46 fee tokens', () => {
    expect([...TERMS_TOKEN_SYMBOLS]).toEqual(['USDC', 'USDT', 'XDAI']);
  });
  it.each(['EUR', 'USD', 'JPY', 'ABC', 'DAI', 'USDC', 'USDT', 'XDAI'])('accepts %s', (currency) => {
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
    'xDAI',
    'WETH',
    'ＥＵＲ', // fullwidth
    '',
  ])('rejects %j', (currency) => {
    expectReject(termsCurrencySchema, currency);
    expectReject(termsSchema, withPrice({ currency }));
  });
});

describe('deadlines[].due (04 §3.4, D-74: real dates, no leap second)', () => {
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
    '2016-12-31T23:59:60Z',
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

describe('D-74 size limits (code points; no empty strings)', () => {
  const deliverable = (i: number, description = 'x') => ({
    id: `d${i + 1}`,
    description,
    by: CONTACT_A,
    plaintextSha256: null,
  });

  it('has the D-74 values', () => {
    expect(TERMS_LIMITS).toEqual({
      subjectCodePoints: 200,
      deliverables: 10,
      deliverableIdLength: 16,
      descriptionCodePoints: 160,
      deadlines: 10,
      amountIntegerDigits: 18,
      amountFractionDigits: 6,
      noteCodePoints: 500,
    });
  });

  it('bounds the subject', () => {
    expectAccept(termsSchema, terms({ subject: 'a'.repeat(200) }));
    expectAccept(termsSchema, terms({ subject: '😀'.repeat(200) }));
    expectReject(termsSchema, terms({ subject: 'a'.repeat(201) }));
    expectReject(termsSchema, terms({ subject: '' }));
  });

  it('deliverable ids match ^[A-Za-z0-9_-]{1,16}$', () => {
    for (const id of ['d1', 'A', 'x_Y-9', 'a'.repeat(16)]) {
      expectAccept(
        termsSchema,
        terms({ deliverables: [{ ...deliverable(0), id }], deadlines: [] }),
      );
    }
    for (const id of ['', 'a'.repeat(17), 'd 1', 'd.1', 'é', 'ｄ1', 'd1​']) {
      expectReject(
        termsSchema,
        terms({ deliverables: [{ ...deliverable(0), id }], deadlines: [] }),
      );
    }
  });

  it('bounds descriptions', () => {
    expectAccept(termsSchema, withDeliverable({ description: '€'.repeat(160) }));
    expectReject(termsSchema, withDeliverable({ description: 'a'.repeat(161) }));
    expectReject(termsSchema, withDeliverable({ description: '' }));
  });

  it('bounds the number of deliverables and deadlines', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => deliverable(i));
    const deadlines = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ref: `d${i + 1}`, due: '2026-11-30T17:00:00Z' }));
    expectAccept(termsSchema, terms({ deliverables: many(10), deadlines: deadlines(10) }));
    expectReject(termsSchema, terms({ deliverables: many(11), deadlines: [] }));
    expectReject(termsSchema, terms({ deliverables: many(11), deadlines: deadlines(11) }));
  });

  it('bounds the note: null or 1 to 500 code points, canonical text', () => {
    const body = (note: unknown) => ({ terms: firstTerms(), termsHash: SHA, note });
    expectAccept(offerBodySchema, body(null));
    expectAccept(offerBodySchema, body('😀'.repeat(500)));
    expectReject(offerBodySchema, body('a'.repeat(501)));
    expectReject(offerBodySchema, body(''));
    expectReject(rejectBodySchema, body('too\nexpensive'));
    const noNote = body(null) as Obj;
    delete noNote.note;
    expectReject(offerBodySchema, noNote);
    expectReject(acceptBodySchema, body('ok'));
  });

  it('the largest terms body is at most 12 083 bytes as JSON', () => {
    const big = '\u{10000}'; // 4 UTF-8 bytes, assigned (Lo)
    const ids = Array.from(
      { length: 10 },
      (_, i) => `${'d'.repeat(14)}${String(i).padStart(2, '0')}`,
    );
    const t = {
      termsId: b64u(16, 'T'),
      version: Number.MAX_SAFE_INTEGER,
      parties: [AGENT_EVM, CONTACT_A],
      subject: big.repeat(200),
      deliverables: ids.map((id) => ({
        id,
        description: big.repeat(160),
        by: CONTACT_A,
        plaintextSha256: H1,
      })),
      price: { amount: '999999999999999999.999999', currency: 'USDC', payer: AGENT_EVM },
      deadlines: ids.map((ref) => ({ ref, due: '2026-11-30T17:00:00Z' })),
      validUntil: Number.MAX_SAFE_INTEGER,
      previousTermsHash: H1,
    };
    const body = { terms: t, termsHash: SHA, note: big.repeat(500) };
    expectAccept(offerBodySchema, body);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(12083);
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

describe('TermsInput (06 §2.2a, D-55, D-74)', () => {
  const NOW = 1_760_000_000;

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

  it('D-74: an explicit null is refused everywhere', () => {
    expectReject(termsInputSchema, termsInput({ price: null }));
    expectReject(termsInputSchema, termsInput({ deadlines: null }));
    expectReject(termsInputSchema, termsInput({ validUntil: null }));
    expectReject(
      termsInputSchema,
      termsInput({ deliverables: [{ description: 'y', by: 'me', plaintextSha256: null }] }),
    );
    expectReject(
      termsInputSchema,
      termsInput({ deliverables: [{ id: null, description: 'y', by: 'me' }] }),
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
    expectReject(termsInputSchema, termsInput({ subject: 'a'.repeat(201) }));
    expectReject(termsInputSchema, termsInput({ deliverables: [] }));
    expectReject(
      termsInputSchema,
      termsInput({ deliverables: [{ id: 'd 1', description: 'y', by: 'me' }], deadlines: [] }),
    );
    expectReject(
      termsInputSchema,
      termsInput({
        deliverables: [{ description: 'y', by: 'me', plaintextSha256: H1.toUpperCase() }],
      }),
    );
    expectReject(termsInputSchema, termsInput({ validUntil: 1760600000 }));
    expectReject(termsInputSchema, termsInput({ validUntil: '2025-10-16T09:33:20+02:00' }));
  });

  it('refuses duplicate ids and deadline refs that name no deliverable or repeat', () => {
    const two = [
      { id: 'd1', description: 'a', by: 'me' },
      { id: 'd1', description: 'b', by: 'me' },
    ];
    expectReject(termsInputSchema, termsInput({ deliverables: two, deadlines: [] }));
    expectReject(
      termsInputSchema,
      termsInput({ deadlines: [{ ref: 'd9', due: '2026-11-30T17:00:00Z' }] }),
    );
  });

  it('D-74: parseTermsInput also requires validUntil after now', () => {
    // termsInput().validUntil is 2025-10-16T07:33:20Z = 1760600000.
    expect(parseTermsInput(termsInput(), NOW).success).toBe(true);
    expect(parseTermsInput(termsInput(), 1760599999).success).toBe(true);
    expect(parseTermsInput(termsInput(), 1760600000).success).toBe(false);
    expect(parseTermsInput(termsInput({ termsId: b64u(16) }), NOW).success).toBe(false);
    const noValidity = termsInput();
    delete noValidity.validUntil;
    expect(parseTermsInput(noValidity, NOW).success).toBe(true);
    expect(parseTermsInput(termsInput(), -1).success).toBe(false);
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
    expect(t).toStrictEqual(firstTerms({ validUntil: 1760600000 }));
    expectRoundTrip(termsSchema, t);
    const v2 = ok(termsInput(), ctx({ version: 2, previousTermsHash: H1 }));
    expect(v2.version).toBe(2);
    expect(v2.previousTermsHash).toBe(H1);
  });

  it('D-74: parties are sorted whoever maps; me/them follow the agent, not the position', () => {
    // CONTACT_A (0x3d…) maps with self = CONTACT_A: parties stay [AGENT_EVM, CONTACT_A].
    const t = ok(termsInput(), ctx({ self: CONTACT_A, counterparty: AGENT_EVM }));
    expect(t.parties).toEqual([AGENT_EVM, CONTACT_A]);
    expect((t.deliverables as Obj[])[0]?.by).toBe(AGENT_EVM); // 'them'
    expect((t.price as Obj).payer).toBe(CONTACT_A); // 'me'
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
  });

  it('D-74: ids are given on every deliverable or on none; none defaults to d1, d2, …', () => {
    const t = ok(
      termsInput({
        deliverables: [
          { description: 'a', by: 'me' },
          { description: 'b', by: 'me' },
          { description: 'c', by: 'me' },
        ],
        deadlines: [{ ref: 'd2', due: '2026-11-30T17:00:00Z' }],
      }),
    );
    expect((t.deliverables as Obj[]).map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
    expect((t.deliverables as Obj[]).map((d) => d.plaintextSha256)).toEqual([null, null, null]);
    const given = ok(
      termsInput({
        deliverables: [
          { id: 'x', description: 'a', by: 'me' },
          { id: 'y', description: 'b', by: 'me' },
        ],
        deadlines: [{ ref: 'y', due: '2026-11-30T17:00:00Z' }],
      }),
    );
    expect((given.deliverables as Obj[]).map((d) => d.id)).toEqual(['x', 'y']);
    // A mix is refused, even without a collision.
    const mixed = termsInput({
      deliverables: [
        { description: 'a', by: 'me' },
        { id: 'x9', description: 'b', by: 'them' },
      ],
      deadlines: [],
    });
    expectReject(termsInputSchema, mixed);
    expect(termsFromInput(mixed, ctx()).success).toBe(false);
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

  it('D-74: price null and deadlines [] when absent; validUntil default now + 604 800', () => {
    const t = ok({ subject: 's', deliverables: [{ description: 'd', by: 'them' }] });
    expect(t.price).toBe(null);
    expect(t.deadlines).toEqual([]);
    expect(t.validUntil).toBe(NOW + TERMS_DEFAULT_VALIDITY_SECONDS);
    expect(TERMS_DEFAULT_VALIDITY_SECONDS).toBe(604800);
  });

  it('converts validUntil to unix seconds and refuses one that is not after now', () => {
    expect(ok(termsInput({ validUntil: '2025-10-09T08:53:21Z' })).validUntil).toBe(NOW + 1);
    expect(termsFromInput(termsInput({ validUntil: '2025-10-09T08:53:20Z' }), ctx()).success).toBe(
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

  it('termsFromInput and parseTermsInput never throw', () => {
    fc.assert(
      fc.property(anyInput, fc.nat(), (r, pick) => {
        const input = mutate(termsInput(), r, pick);
        expect(() =>
          termsFromInput(input, {
            termsId: b64u(16, 'T'),
            version: 1,
            previousTermsHash: null,
            self: AGENT_EVM,
            counterparty: CONTACT_A,
            now: 1_760_000_000,
          }),
        ).not.toThrow();
        expect(() => parseTermsInput(input, 1_760_000_000)).not.toThrow();
      }),
      RUNS,
    );
  });

  it('text fuzz: canonical text has no refused 15.0.0 code point and is NFC', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        if (isCanonicalTermsText(s)) {
          expect(s.normalize('NFC')).toBe(s);
          for (const ch of s) expect(refusedCategory15(ch.codePointAt(0) as number)).toBe(null);
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
          price: null,
        }),
      );
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
