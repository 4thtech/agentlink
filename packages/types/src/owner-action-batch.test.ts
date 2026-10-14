// approval.decideBatch (04 §2.5.1 op table, §2.5.2; D-68). Written from the spec text:
// - params are `{items}`, 2 to 20 entries, each exactly the strict `approval.decide` params;
// - items are in strictly ascending `approvalId` order compared as byte strings, so no duplicates;
// - any other order, a duplicate, an unknown key, fewer than 2 or more than 20 items is rejected,
//   never normalised;
// - `op` and `params` sit in the hashed body, so a batch is never read as `approval.decide`, nor the
//   reverse; one decision is always an `approval.decide`;
// - the `approval` envelope carries `approval.decide`, `approval.decideBatch` or `approval.cancel`
//   (04 §3.4.1).
// The expiry bound against the items' pending requests is the core's (M1-7d), not the schema's.
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_BATCH_LOCAL_MAX_LIFETIME_SECONDS,
  APPROVAL_BATCH_MAX_ITEMS,
  APPROVAL_BATCH_MIN_ITEMS,
  APPROVAL_TTL_SECONDS,
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  approvalDecideActionSchema,
  approvalDecideBatchActionSchema,
  approvalDecideBatchParamsSchema,
  approvalDecideParamsSchema,
  ownerActionSchema,
  payloadSchema,
  signedApprovalDecideBatchSchema,
  signedApprovalDecideSchema,
  signedApprovalOpSchema,
  signedOwnerActionSchema,
} from './index.js';
import { expectReject, expectRoundTrip } from './testing/assert.js';
import {
  approvalDecideAction,
  approvalDecideBatchAction,
  approvalIdOf,
  batchItem,
  DELETE,
  edit,
  ID16,
  payloads,
  signed,
} from './testing/fixtures.js';

type Item = ReturnType<typeof batchItem>;
const withItems = (items: unknown[]) =>
  edit(approvalDecideBatchAction(), ['params', 'items'], items);
const item = (fill: string, decision = 'approve'): Item => ({
  ...batchItem(0),
  approvalId: approvalIdOf(fill),
  decision,
});

/** Every schema a batch body passes through; each must agree. */
const accepts = (body: unknown) => {
  expectRoundTrip(approvalDecideBatchActionSchema, body);
  expectRoundTrip(ownerActionSchema, body);
  expectRoundTrip(signedOwnerActionSchema, signed(body));
  expectRoundTrip(signedApprovalDecideBatchSchema, signed(body));
  expectRoundTrip(signedApprovalOpSchema, signed(body));
};
const rejects = (body: unknown) => {
  expectReject(approvalDecideBatchActionSchema, body);
  expectReject(ownerActionSchema, body);
  expectReject(signedOwnerActionSchema, signed(body));
  expectReject(signedApprovalDecideBatchSchema, signed(body));
  expectReject(signedApprovalOpSchema, signed(body));
};

describe('approval.decideBatch constants (04 §2.5.1, §2.5.2)', () => {
  it('exports the item bounds: 2 to 20 (the maximum is proposed)', () => {
    expect(APPROVAL_BATCH_MIN_ITEMS).toBe(2);
    expect(APPROVAL_BATCH_MAX_ITEMS).toBe(20);
  });

  it('is an owner-action op with L(op) = 86 400 s, the approval TTL', () => {
    expect(OWNER_ACTION_OPS).toContain('approval.decideBatch');
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['approval.decideBatch']).toBe(86_400);
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['approval.decideBatch']).toBe(APPROVAL_TTL_SECONDS);
  });

  it('exports the 600 s local expiry for the CLI and the local UI (proposed), below L(op)', () => {
    expect(APPROVAL_BATCH_LOCAL_MAX_LIFETIME_SECONDS).toBe(600);
    expect(APPROVAL_BATCH_LOCAL_MAX_LIFETIME_SECONDS).toBeLessThan(
      OWNER_ACTION_MAX_LIFETIME_SECONDS['approval.decideBatch'],
    );
  });
});

describe('approval.decideBatch accepts the canonical form unchanged', () => {
  it.each([2, 3, 19, 20])('%i items, mixed decisions', (n) => {
    const body = approvalDecideBatchAction(n);
    const decisions = new Set(body.params.items.map((i) => i.decision));
    if (n >= 2) expect(decisions).toEqual(new Set(['approve', 'deny']));
    accepts(body);
  });

  it('all approve and all deny', () => {
    accepts(withItems([item('A'), item('B')]));
    accepts(withItems([item('A', 'deny'), item('B', 'deny')]));
  });

  it('every item is exactly a valid approval.decide params object', () => {
    for (const i of approvalDecideBatchAction(20).params.items) {
      expectRoundTrip(approvalDecideParamsSchema, i);
    }
  });

  it('the params schema alone accepts {items}', () => {
    expectRoundTrip(approvalDecideBatchParamsSchema, approvalDecideBatchAction(2).params);
  });

  it('goes in an approval envelope (04 §3.4.1)', () => {
    expectRoundTrip(payloadSchema, {
      ...payloads().approval,
      body: { signed: signed(approvalDecideBatchAction(3)) },
    });
  });
});

describe('approval.decideBatch item count (2 to 20)', () => {
  it('rejects 0 and 1 item: a single decision is always an approval.decide', () => {
    rejects(withItems([]));
    rejects(withItems([batchItem(0)]));
  });

  it('rejects 21 items', () => {
    rejects(approvalDecideBatchAction(21));
  });

  it.each([
    ['missing items', DELETE],
    ['items null', null],
    ['items as object', { 0: batchItem(0), 1: batchItem(1) }],
    ['items as JSON text', JSON.stringify([batchItem(0), batchItem(1)])],
  ] as const)('rejects %s', (_l, value) => {
    rejects(edit(approvalDecideBatchAction(), ['params', 'items'], value));
  });
});

describe('approval.decideBatch canonical order (strictly ascending approvalId, byte order)', () => {
  it('rejects two items in descending order', () => {
    rejects(withItems([batchItem(1), batchItem(0)]));
  });

  it('rejects one item out of place in a longer list (and never sorts it)', () => {
    const items: unknown[] = approvalDecideBatchAction(5).params.items;
    [items[2], items[3]] = [items[3], items[2]];
    rejects(withItems(items));
    rejects(withItems([...approvalDecideBatchAction(5).params.items].reverse()));
  });

  it('rejects a duplicate approvalId, even with another digest or decision', () => {
    rejects(withItems([item('A'), item('A')]));
    rejects(withItems([item('A'), { ...item('A', 'deny'), actionDigest: 'ab'.repeat(32) }]));
    rejects(withItems([item('A'), item('B'), item('B')]));
    rejects(withItems([item('A'), item('B'), item('A')]));
  });

  it('compares bytes, not base64url values: "-" sorts before "A" and "_" between "Z" and "a"', () => {
    // As base64url values "-" (62) > "A" (0) and "_" (63) > "a" (26); as bytes the reverse.
    accepts(withItems([item('-'), item('A')]));
    rejects(withItems([item('A'), item('-')]));
    accepts(withItems([item('Z'), item('_'), item('a')]));
    rejects(withItems([item('_'), item('Z')]));
    rejects(withItems([item('a'), item('_')]));
  });

  it('compares bytes, not case-insensitively or by locale: "B" (0x42) before "a" (0x61)', () => {
    accepts(withItems([item('B'), item('a')]));
    rejects(withItems([item('a'), item('B')]));
    accepts(withItems([item('9'), item('A')]));
    rejects(withItems([item('A'), item('9')]));
  });

  it('orders by the whole approvalId, not only its first character', () => {
    const a = `apr_${'B'.repeat(20)}AA`;
    const b = `apr_${'B'.repeat(20)}QA`;
    const base = batchItem(0);
    accepts(
      withItems([
        { ...base, approvalId: a },
        { ...base, approvalId: b },
      ]),
    );
    rejects(
      withItems([
        { ...base, approvalId: b },
        { ...base, approvalId: a },
      ]),
    );
  });
});

describe('approval.decideBatch items are strict approval.decide params', () => {
  const cases: [string, readonly (string | number)[], unknown][] = [
    ['unknown key in an item', ['extra'], 1],
    ['unknown key "op" in an item', ['op'], 'approval.decide'],
    ['missing approvalId', ['approvalId'], DELETE],
    ['missing actionDigest', ['actionDigest'], DELETE],
    ['missing decision', ['decision'], DELETE],
    ['approvalId without apr_', ['approvalId'], ID16],
    ['approvalId padded', ['approvalId'], `apr_${ID16}==`],
    ['approvalId of 15 bytes', ['approvalId'], `apr_${'B'.repeat(20)}`],
    ['uppercase actionDigest', ['actionDigest'], 'E5'.repeat(32)],
    ['mixed-case actionDigest', ['actionDigest'], `E5${'e5'.repeat(31)}`],
    ['0x actionDigest', ['actionDigest'], `0x${'e5'.repeat(32)}`],
    ['0x actionDigest of 31 bytes', ['actionDigest'], `0x${'e5'.repeat(31)}`],
    ['short actionDigest', ['actionDigest'], 'e5'.repeat(31)],
    ['long actionDigest', ['actionDigest'], 'e5'.repeat(33)],
    ['decision maybe', ['decision'], 'maybe'],
    ['decision uppercase', ['decision'], 'Approve'],
    ['decision boolean', ['decision'], true],
  ];

  it.each(cases)('rejects %s (first and last item)', (_l, path, value) => {
    for (const index of [0, 1]) {
      const bad = edit(approvalDecideBatchAction(2), ['params', 'items', index, ...path], value);
      rejects(bad);
      // The same item is rejected by approval.decide params: one strict schema, not a second one.
      expectReject(approvalDecideParamsSchema, bad.params.items[index]);
    }
  });

  it.each([
    ['null', null],
    ['a string', 'apr_x'],
    ['an array', [batchItem(0).approvalId, batchItem(0).actionDigest, 'approve']],
    ['a signed approval.decide', signed(approvalDecideAction())],
  ] as const)('rejects an item that is %s', (_l, value) => {
    rejects(edit(approvalDecideBatchAction(2), ['params', 'items', 1], value));
  });
});

describe('approval.decideBatch params are strict', () => {
  it('rejects an unknown key beside items', () => {
    rejects(edit(approvalDecideBatchAction(), ['params', 'extra'], 1));
    rejects(edit(approvalDecideBatchAction(), ['params', 'count'], 2));
  });

  it('rejects params null, an array or an empty object', () => {
    rejects(edit(approvalDecideBatchAction(), ['params'], null));
    rejects(
      edit(approvalDecideBatchAction(), ['params'], approvalDecideBatchAction().params.items),
    );
    rejects(edit(approvalDecideBatchAction(), ['params'], {}));
  });
});

describe('decide and decideBatch bodies cannot be confused (04 §2.5.2 "What is signed")', () => {
  const decideParams = approvalDecideAction().params;
  const batchParams = approvalDecideBatchAction().params;

  it('a batch body carrying approval.decide params is rejected', () => {
    rejects(edit(approvalDecideBatchAction(), ['params'], decideParams));
  });

  it('an approval.decide body carrying batch params is rejected', () => {
    const bad = edit(approvalDecideAction(), ['params'], batchParams);
    expectReject(approvalDecideActionSchema, bad);
    expectReject(ownerActionSchema, bad);
    expectReject(signedOwnerActionSchema, signed(bad));
    expectReject(signedApprovalDecideSchema, signed(bad));
    expectReject(signedApprovalOpSchema, signed(bad));
  });

  it('params mixing both shapes are rejected under either op', () => {
    const mixed = { ...decideParams, ...batchParams };
    rejects(edit(approvalDecideBatchAction(), ['params'], mixed));
    expectReject(ownerActionSchema, edit(approvalDecideAction(), ['params'], mixed));
  });

  it('each typed wrapper accepts only its own op', () => {
    expectReject(signedApprovalDecideBatchSchema, signed(approvalDecideAction()));
    expectReject(signedApprovalDecideSchema, signed(approvalDecideBatchAction()));
    expectReject(approvalDecideBatchActionSchema, approvalDecideAction());
    expectReject(approvalDecideActionSchema, approvalDecideBatchAction());
  });

  it.each([
    'approval.decidebatch',
    'Approval.DecideBatch',
    'approval.decide_batch',
    'approval.decideBatch ',
    'approval.batch',
  ])('rejects the op spelled %j', (op) => {
    rejects(edit(approvalDecideBatchAction(), ['op'], op));
  });
});

describe('approval.decideBatch expiry shape (04 §2.5.1)', () => {
  it('requires a non-zero expiresAt after issuedAt', () => {
    rejects(edit(approvalDecideBatchAction(), ['expiresAt'], 0));
    rejects(edit(approvalDecideBatchAction(), ['expiresAt'], 1760000000));
    rejects(edit(approvalDecideBatchAction(), ['expiresAt'], 1759999999));
  });
});
