// Policy (06 §3 "Policy JSON form", per-contact rules; G-32), as signed by `policy.set` (04 §2.5.1).
// Strict at every level, every key required, no default ever filled in (G-6: a malformed policy is
// rejected, never completed with defaults that could be looser than the owner's policy).
import { describe, expect, it } from 'vitest';
import {
  MAX_ENVELOPE_BYTES,
  POLICY_DEFAULTS,
  POLICY_PROTOCOL_LIMITS,
  contactRuleSchema,
  defaultPolicy,
  policySchema,
  policySetActionSchema,
  policySetParamsSchema,
  signedPolicySetSchema,
} from './index.js';
import { expectAccept, expectReject, expectRoundTrip } from './testing/assert.js';
import {
  BAD_USD_STRINGS,
  CONTACT_A,
  CONTACT_B,
  DELETE,
  clone,
  edit,
  policyDefaultsFromSpec,
  policySetAction,
  policyWithRules,
  signed,
} from './testing/fixtures.js';

type Path = (string | number)[];

/** Every object key path in a JSON value (array items included, array indices are not keys). */
function keyPaths(value: unknown, prefix: Path = []): Path[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => keyPaths(item, [...prefix, i]));
  return Object.entries(value).flatMap(([k, v]) => [
    [...prefix, k],
    ...keyPaths(v, [...prefix, k]),
  ]);
}

/** Every object path (including the root) in a JSON value. */
function objectPaths(value: unknown, prefix: Path = []): Path[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => objectPaths(item, [...prefix, i]));
  return [prefix, ...Object.entries(value).flatMap(([k, v]) => objectPaths(v, [...prefix, k]))];
}

const USD_PATHS: Path[] = [
  ['proofs', 'dailyBudgetUSD'],
  ['proofs', 'perActionMaxUSD'],
  ['commitments', 'autoAcceptMaxUSD'],
  ['commitments', 'autoAcceptMinUSD'],
  ['contactRules', 0, 'proofs', 'perActionMaxUSD'],
];

describe('policy defaults (06 §3)', () => {
  it('deep-equal the 06 §3 listing in the policy JSON form (snapshot citing the spec)', () => {
    // policyDefaultsFromSpec is transcribed from docs/foundation/06-mcp-server.md §3 (YAML listing
    // and "The defaults" bullet). A change to either side fails here.
    expect(POLICY_DEFAULTS).toStrictEqual(policyDefaultsFromSpec());
    expect(POLICY_DEFAULTS).toMatchInlineSnapshot(`
      {
        "commitments": {
          "accept": "approval",
          "autoAcceptContacts": [],
          "autoAcceptDirection": "buy",
          "autoAcceptMaxUSD": "0",
          "autoAcceptMinUSD": null,
        },
        "contactRules": [],
        "contacts": {
          "acceptInvites": "approval",
          "allowed": "paired",
          "rateLimitPerContactPerHour": 120,
          "unknownSenders": "queue",
        },
        "envelopes": {
          "maxEnvelopeKB": 24,
        },
        "files": {
          "allowedFolders": [],
          "defaultExpiryDays": 7,
          "deleteAfter": "expiry",
          "inboxFolder": "~/AgentLink/Inbox",
          "maxReceiveSizeMB": 200,
          "maxSendSizeMB": 100,
          "ownerArchive": false,
          "storage": "auto",
        },
        "proofs": {
          "allowKeyDisclosure": "approval",
          "dailyBudgetUSD": "5",
          "defaultChain": "base",
          "exportFolder": "~/AgentLink/Proofs",
          "notarize": "allow",
          "perActionMaxUSD": "1",
        },
        "receipts": {
          "autoDelivered": true,
          "autoOpened": false,
        },
      }
    `);
  });

  it('parse under the strict schema unchanged', () => {
    expectRoundTrip(policySchema, POLICY_DEFAULTS);
    expectRoundTrip(policySchema, policyDefaultsFromSpec());
  });

  it('are deeply frozen; defaultPolicy() returns a fresh mutable copy', () => {
    const frozen = (v: unknown): boolean =>
      v === null ||
      typeof v !== 'object' ||
      (Object.isFrozen(v) && Object.values(v as object).every(frozen));
    expect(frozen(POLICY_DEFAULTS)).toBe(true);
    const a = defaultPolicy();
    const b = defaultPolicy();
    expect(a).toStrictEqual(POLICY_DEFAULTS);
    expect(a).not.toBe(b);
    a.contacts.rateLimitPerContactPerHour = 1;
    a.files.allowedFolders.push('~/x');
    expect(POLICY_DEFAULTS.contacts.rateLimitPerContactPerHour).toBe(120);
    expect(POLICY_DEFAULTS.files.allowedFolders).toEqual([]);
    expect(b.files.allowedFolders).toEqual([]);
  });

  it('match the protocol caps pinned in constants (envelope size, link expiry)', () => {
    expect(POLICY_DEFAULTS.envelopes.maxEnvelopeKB).toBe(
      POLICY_PROTOCOL_LIMITS['envelopes.maxEnvelopeKB'],
    );
    expect(POLICY_DEFAULTS.files.defaultExpiryDays).toBe(
      POLICY_PROTOCOL_LIMITS['files.defaultExpiryDays'],
    );
    expect(POLICY_DEFAULTS.envelopes.maxEnvelopeKB * 1024).toBe(MAX_ENVELOPE_BYTES);
  });
});

describe('policy round trips', () => {
  it('a policy with contact lists, folders, sell limits and contact rules', () => {
    expectRoundTrip(policySchema, policyWithRules());
  });

  it('the bounds themselves are accepted', () => {
    const p = policyDefaultsFromSpec();
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    for (const [path, value] of [
      [['contacts', 'allowed'], ids(1)],
      [['contacts', 'allowed'], ids(256)],
      [['commitments', 'autoAcceptContacts'], ids(256)],
      [['contacts', 'rateLimitPerContactPerHour'], 1],
      [['contacts', 'rateLimitPerContactPerHour'], 3600],
      [['files', 'maxSendSizeMB'], 1],
      [['files', 'maxSendSizeMB'], 10_240],
      [['files', 'maxReceiveSizeMB'], 10_240],
      [['files', 'defaultExpiryDays'], 1],
      [['envelopes', 'maxEnvelopeKB'], 1],
      [['files', 'allowedFolders'], Array.from({ length: 32 }, (_, i) => `~/f${i}`)],
      [['files', 'inboxFolder'], 'é'.repeat(2048)], // 4096 UTF-8 bytes
      [['files', 'inboxFolder'], '/'],
      [['proofs', 'exportFolder'], 'C:\\Users\\tali\\Proofs'],
      [['proofs', 'defaultChain'], 'a'.repeat(32)],
      [['proofs', 'dailyBudgetUSD'], '999999999.999999'],
      [['proofs', 'perActionMaxUSD'], '0'],
      [['commitments', 'autoAcceptMinUSD'], '0.000001'],
      [['commitments', 'accept'], 'allow'],
      [['commitments', 'accept'], 'deny'],
      [['proofs', 'notarize'], 'deny'],
      [['proofs', 'allowKeyDisclosure'], 'deny'],
      [['contacts', 'acceptInvites'], 'auto'],
      [['contacts', 'unknownSenders'], 'drop'],
      [['files', 'storage'], 'own'],
      [['files', 'deleteAfter'], 'receipt'],
    ] as [Path, unknown][]) {
      expectRoundTrip(policySchema, edit(p, path, value));
    }
  });

  it('256 contact rules are accepted', () => {
    const rules = Array.from({ length: 256 }, (_, i) => ({
      contact: `0x${i.toString(16).padStart(40, '0')}`,
      proofs: { notarize: 'allow' },
    }));
    expectRoundTrip(policySchema, { ...policyDefaultsFromSpec(), contactRules: rules });
  });
});

describe('policy rejects (M1-2b acceptance)', () => {
  // The two keys inside a ContactRule's `proofs` are each optional (at least one is required); every
  // other key in the document is required.
  const isRuleProofKey = (p: Path) =>
    p.length === 4 && p[0] === 'contactRules' && p[2] === 'proofs';

  it.each(
    keyPaths(policyWithRules())
      .filter((p) => !isRuleProofKey(p))
      .map((p) => [p.join('.'), p] as const),
  )('a missing key: %s', (_label, path) => {
    expectReject(policySchema, edit(policyWithRules(), path, DELETE));
  });

  it.each(objectPaths(policyWithRules()).map((p) => [p.join('.') || '(root)', p] as const))(
    'an unknown key at %s',
    (_label, path) => {
      expectReject(policySchema, edit(policyWithRules(), [...path, 'extra'], 'x'));
    },
  );

  it.each(USD_PATHS.map((p) => [p.join('.'), p] as const))(
    'a JSON number for the USD field %s',
    (_label, path) => {
      for (const n of [5, 0, 1, 0.5]) expectReject(policySchema, edit(policyWithRules(), path, n));
    },
  );

  it.each(USD_PATHS.map((p) => [p.join('.'), p] as const))(
    'every non-canonical USD string in %s',
    (_label, path) => {
      for (const s of BAD_USD_STRINGS) expectReject(policySchema, edit(policyWithRules(), path, s));
    },
  );

  it('null is allowed only for autoAcceptMinUSD', () => {
    for (const path of USD_PATHS) {
      const bad = edit(policyWithRules(), path, null);
      if (path.join('.') === 'commitments.autoAcceptMinUSD') expectAccept(policySchema, bad);
      else expectReject(policySchema, bad);
    }
  });

  it('allowKeyDisclosure "allow" (disclosing a content key is owner-only, 04 §2.5)', () => {
    expectReject(
      policySchema,
      edit(policyDefaultsFromSpec(), ['proofs', 'allowKeyDisclosure'], 'allow'),
    );
  });

  it.each([
    [
      ['contacts', 'acceptInvites'],
      ['allow', 'deny', 'Approval', 'APPROVAL', ' approval', ''],
    ],
    [
      ['contacts', 'unknownSenders'],
      ['accept', 'Queue', 'allow'],
    ],
    [
      ['contacts', 'allowed'],
      ['all', 'Paired', 'any', '', null],
    ],
    [
      ['files', 'storage'],
      ['s3', 'Auto', 'none'],
    ],
    [
      ['files', 'deleteAfter'],
      ['never', 'Expiry'],
    ],
    [
      ['proofs', 'notarize'],
      ['auto', 'Allow', 'yes', true],
    ],
    [
      ['commitments', 'accept'],
      ['auto', 'Approval', 'never'],
    ],
    [
      ['commitments', 'autoAcceptDirection'],
      ['both', 'Buy', 'mixed', ''],
    ],
    [
      ['receipts', 'autoDelivered'],
      ['true', 1, 0, null],
    ],
    [
      ['files', 'ownerArchive'],
      ['false', 0],
    ],
  ] as [Path, unknown[]][])('a value outside the enum or type at %j', (path, values) => {
    for (const v of values) expectReject(policySchema, edit(policyDefaultsFromSpec(), path, v));
  });

  const listPaths: Path[] = [
    ['contacts', 'allowed'],
    ['commitments', 'autoAcceptContacts'],
  ];

  it.each(listPaths.map((p) => [p.join('.'), p] as const))(
    'an unsorted or duplicate contact list in %s',
    (_label, path) => {
      const p = policyWithRules();
      expectReject(policySchema, edit(p, path, [CONTACT_B, CONTACT_A]));
      expectReject(policySchema, edit(p, path, [CONTACT_A, CONTACT_A]));
      expectReject(policySchema, edit(p, path, [CONTACT_A, CONTACT_B, CONTACT_A]));
    },
  );

  it.each(listPaths.map((p) => [p.join('.'), p] as const))(
    'an uppercase, checksummed or malformed agent ID in %s',
    (_label, path) => {
      for (const id of [
        CONTACT_A.toUpperCase(),
        `0x${'3D'.repeat(20)}`,
        '0x3D3d3D3d3D3d3D3d3D3d3D3d3D3d3D3d3D3d3D3d', // EIP-55 style mixed case
        '3d'.repeat(20),
        `0x${'3d'.repeat(19)}`,
        `0x${'3d'.repeat(32)}`,
        `0X${'3d'.repeat(20)}`,
        ` ${CONTACT_A}`,
      ]) {
        expectReject(policySchema, edit(policyWithRules(), path, [id]));
      }
    },
  );

  it('contact lists outside their sizes: allowed [] and 257 entries; autoAcceptContacts 257', () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    const p = policyDefaultsFromSpec();
    expectReject(policySchema, edit(p, ['contacts', 'allowed'], []));
    expectReject(policySchema, edit(p, ['contacts', 'allowed'], ids(257)));
    expectReject(policySchema, edit(p, ['commitments', 'autoAcceptContacts'], ids(257)));
    expectReject(policySchema, edit(p, ['contacts', 'allowed'], CONTACT_A));
  });

  it('a ContactRule with empty proofs, an unknown key, or a bad value', () => {
    const at = (rule: unknown) => ({ ...policyDefaultsFromSpec(), contactRules: [rule] });
    expectReject(policySchema, at({ contact: CONTACT_A, proofs: {} }));
    expectReject(policySchema, at({ contact: CONTACT_A }));
    expectReject(policySchema, at({ contact: CONTACT_A, proofs: { notarize: 'allow' }, x: 1 }));
    expectReject(policySchema, at({ contact: CONTACT_A, proofs: { notarize: 'allow', x: 1 } }));
    expectReject(policySchema, at({ contact: CONTACT_A, proofs: { dailyBudgetUSD: '1' } }));
    expectReject(policySchema, at({ contact: CONTACT_A, proofs: { allowKeyDisclosure: 'deny' } }));
    expectReject(policySchema, at({ contact: CONTACT_A, proofs: { notarize: 'auto' } }));
    expectReject(policySchema, at({ contact: CONTACT_A, proofs: { perActionMaxUSD: 1 } }));
    expectReject(policySchema, at({ contact: CONTACT_A, proofs: { perActionMaxUSD: '1.0' } }));
    expectReject(
      policySchema,
      at({ contact: CONTACT_A.toUpperCase(), proofs: { notarize: 'deny' } }),
    );
    // An explicit undefined is not "absent": the rule must say what it replaces.
    expectReject(contactRuleSchema, { contact: CONTACT_A, proofs: { notarize: undefined } });
    expectReject(contactRuleSchema, {
      contact: CONTACT_A,
      proofs: { notarize: undefined, perActionMaxUSD: undefined },
    });
    expectRoundTrip(contactRuleSchema, { contact: CONTACT_A, proofs: { notarize: 'deny' } });
    expectRoundTrip(contactRuleSchema, { contact: CONTACT_A, proofs: { perActionMaxUSD: '0' } });
  });

  it('257 contact rules, unsorted rules, and two rules for one contact', () => {
    const rules = Array.from({ length: 257 }, (_, i) => ({
      contact: `0x${i.toString(16).padStart(40, '0')}`,
      proofs: { notarize: 'allow' },
    }));
    const d = policyDefaultsFromSpec();
    expectReject(policySchema, { ...d, contactRules: rules });
    const [a, b] = policyWithRules().contactRules;
    expectReject(policySchema, { ...d, contactRules: [b, a] });
    expectReject(policySchema, { ...d, contactRules: [a, a] });
    expectReject(policySchema, { ...d, contactRules: [a, { ...b, contact: CONTACT_A }] });
    expectReject(policySchema, { ...d, contactRules: {} });
  });

  it.each([
    [
      ['envelopes', 'maxEnvelopeKB'],
      [25, 0, -1, 24.5, '24', 1e3, null],
    ],
    [
      ['files', 'defaultExpiryDays'],
      [8, 0, 7.5, '7'],
    ],
    [
      ['contacts', 'rateLimitPerContactPerHour'],
      [0, 3601, 120.5, -0],
    ],
    [
      ['files', 'maxSendSizeMB'],
      [0, 10_241, Number.MAX_SAFE_INTEGER + 1],
    ],
    [
      ['files', 'maxReceiveSizeMB'],
      [0, 10_241, Infinity, NaN],
    ],
  ] as [Path, unknown[]][])('integers out of range or not integers at %j', (path, values) => {
    for (const v of values) expectReject(policySchema, edit(policyDefaultsFromSpec(), path, v));
  });

  it.each([
    ['empty', ''],
    ['4098 UTF-8 bytes', 'é'.repeat(2049)],
    ['4097 bytes', 'a'.repeat(4097)],
    ['a newline (C0)', '~/Agent\nLink'],
    ['NUL (C0)', '~/Agent\u0000Link'],
    ['a tab (C0)', '~/Agent\tLink'],
    ['NEL (C1)', '~/Agent\u0085Link'],
    ['U+009F (C1)', '~/Agent\u009fLink'],
    ['a lone surrogate (not I-JSON)', '~/Agent\ud800Link'],
    ['a number', 42],
    ['null', null],
  ] as const)('a path with %s', (_label, value) => {
    for (const path of [
      ['files', 'inboxFolder'],
      ['proofs', 'exportFolder'],
      ['files', 'allowedFolders', 0],
    ] as Path[]) {
      expectReject(policySchema, edit(policyWithRules(), path, value));
    }
  });

  it('allowedFolders with a duplicate or more than 32 entries', () => {
    const p = policyDefaultsFromSpec();
    expectReject(policySchema, edit(p, ['files', 'allowedFolders'], ['~/a', '~/a']));
    expectReject(
      policySchema,
      edit(
        p,
        ['files', 'allowedFolders'],
        Array.from({ length: 33 }, (_, i) => `~/f${i}`),
      ),
    );
    expectReject(policySchema, edit(p, ['files', 'allowedFolders'], '~/a'));
  });

  it.each(['Base', 'base_sepolia', '', 'a'.repeat(33), 'base sepolia', 'base.', 8453, null])(
    'the chain key %j (07 §6.3, ^[a-z0-9-]{1,32}$)',
    (chain) => {
      expectReject(policySchema, edit(policyDefaultsFromSpec(), ['proofs', 'defaultChain'], chain));
    },
  );

  it('anything that is not a policy object', () => {
    for (const v of [undefined, null, {}, [], 'default', 0, POLICY_DEFAULTS.contacts]) {
      expectReject(policySchema, v);
    }
  });

  it('negative control: the pre-G-32 vector form (JSON-number USD, no contactRules) is rejected', () => {
    // The shape test-vectors/owner-action `sign-policy-set` used before M1-2b ("proposed until
    // M1-2b"): USD limits as JSON numbers and no `contactRules`. Each difference alone is fatal.
    const legacy = clone(policyDefaultsFromSpec()) as Record<string, unknown>;
    delete legacy.contactRules;
    expectReject(policySchema, legacy);
    expectReject(policySchema, edit(policyDefaultsFromSpec(), ['proofs', 'dailyBudgetUSD'], 5));
    expectReject(policySchema, edit(policyDefaultsFromSpec(), ['proofs', 'perActionMaxUSD'], 1));
    expectReject(
      policySchema,
      edit(policyDefaultsFromSpec(), ['commitments', 'autoAcceptMaxUSD'], 0),
    );
  });
});

describe('the policy plugs into policy.set (04 §2.5.1)', () => {
  it('policy.set params carry {version, policy} with the strict policy', () => {
    expectRoundTrip(policySetParamsSchema, { version: 1, policy: policyDefaultsFromSpec() });
    expectRoundTrip(policySetParamsSchema, { version: 7, policy: policyWithRules() });
    expectRoundTrip(signedPolicySetSchema, signed(policySetAction()));
    expectRoundTrip(
      signedPolicySetSchema,
      signed(edit(policySetAction(), ['params', 'policy'], policyWithRules())),
    );
  });

  it('a partial patch or any malformed policy inside policy.set is rejected', () => {
    for (const policy of [
      { contacts: { acceptInvites: 'approval' } },
      edit(policyDefaultsFromSpec(), ['proofs', 'notarize'], 'yes'),
      edit(policyDefaultsFromSpec(), ['contactRules'], DELETE),
      edit(policyDefaultsFromSpec(), ['extra'], {}),
    ]) {
      expectReject(policySetParamsSchema, { version: 2, policy });
      expectReject(policySetActionSchema, edit(policySetAction(), ['params', 'policy'], policy));
      expectReject(
        signedPolicySetSchema,
        signed(edit(policySetAction(), ['params', 'policy'], policy)),
      );
    }
  });
});
