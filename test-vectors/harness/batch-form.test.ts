// Cross-check of the owner-action `approval.decideBatch` vectors (M1-2e, D-68) against the strict
// @4thtech-io/types schema. The vectors come from the independent Python generator
// (tools/vectors/generate_owner_action.py, written in a separate session under the M1-1h rules) and
// the schema from @4thtech-io/types, written from 04 §2.5.1 and §2.5.2 before the vectors were read;
// neither is derived from the other. The card asks for agreement "in every runtime the suite
// declares", so this file runs in all five runtime projects (the suite declares no `runtimes`).
// Signature checks, the expiry bound and matching against pending requests are the core's
// (M1-7d); the owner-action suite itself stays pending until then.
import {
  approvalDecideActionSchema,
  approvalDecideBatchActionSchema,
  signedApprovalDecideBatchSchema,
  signedApprovalDecideSchema,
  signedApprovalOpSchema,
  signedOwnerActionSchema,
} from '@4thtech-io/types';
import { describe, expect, test } from 'vitest';
import { vectorFiles, type VectorCase } from './registry';

type Json = Record<string, unknown>;
interface Item {
  approvalId: string;
  actionDigest: string;
  decision: string;
  [key: string]: unknown;
}
interface Body {
  op: string;
  params: Json & { items?: Item[] };
}
interface Input {
  readonly op?: unknown;
  readonly body?: Body;
  readonly signed?: { readonly body: Body; readonly sig: string };
}

const ownerAction = vectorFiles.find((f) => f.directory === 'owner-action')?.file;
const cases: readonly VectorCase[] = ownerAction?.cases ?? [];
const input = (c: VectorCase): Input => c.input as Input;
const outcome = (c: VectorCase) => (c.expected as { outcome?: unknown }).outcome;
const byId = (id: string) => cases.find((c) => c.id === id);
const clone = <T>(v: T): T => structuredClone(v);

/** A batch case: its op, or the op it is confused with, is approval.decideBatch. */
const isBatchCase = (c: VectorCase) => c.id.includes('batch');
const signCases = cases.filter((c) => isBatchCase(c) && input(c).op === 'sign');
const verifyCases = cases.filter((c) => isBatchCase(c) && input(c).op === 'verify');

/** Byte order of two ASCII strings (an `approvalId` is `apr_` + base64url): code-unit order. */
const byBytes = (a: Item, b: Item) =>
  a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0;
const ITEM_KEYS = new Set(['approvalId', 'actionDigest', 'decision']);
const itemsOf = (id: string): Item[] =>
  clone(input(byId(id) as VectorCase).body?.params.items ?? []);

/**
 * The smallest repair for each rejection: undoing exactly the rule the vector names must make the
 * strict schema accept it (as in policy-form.test.ts). A vector that broke a second rule, or another
 * rule than its name says, still fails after the repair.
 */
const REPAIRS: Readonly<Record<string, (b: Body) => void>> = {
  'reject-batch-0-items': (b) => {
    b.params.items = itemsOf('sign-batch-2');
  },
  'reject-batch-1-item': (b) => {
    // Add the largest item of the 20-item batch, so the order stays ascending.
    const items = b.params.items!;
    items.push(itemsOf('sign-batch-20').sort(byBytes).at(-1)!);
    expect(items[0]!.approvalId < items[1]!.approvalId).toBe(true);
  },
  'reject-batch-21-items': (b) => {
    b.params.items!.pop();
  },
  'reject-batch-unsorted': (b) => {
    b.params.items!.sort(byBytes);
  },
  'reject-batch-unsorted-middle': (b) => {
    b.params.items!.sort(byBytes);
  },
  'reject-batch-duplicate-item': (b) => {
    b.params.items!.pop();
    b.params.items!.push(itemsOf('sign-batch-20').sort(byBytes).at(-1)!);
  },
  'reject-batch-duplicate-approval-id': (b) => {
    b.params.items!.pop();
    b.params.items!.push(itemsOf('sign-batch-20').sort(byBytes).at(-1)!);
  },
  'reject-batch-item-unknown-key': (b) => {
    for (const item of b.params.items!) {
      for (const key of Object.keys(item)) if (!ITEM_KEYS.has(key)) delete item[key];
    }
  },
  'reject-batch-params-unknown-key': (b) => {
    for (const key of Object.keys(b.params)) if (key !== 'items') delete b.params[key];
  },
  'reject-batch-digest-uppercase': (b) => {
    for (const item of b.params.items!) item.actionDigest = item.actionDigest.toLowerCase();
  },
  'reject-batch-digest-0x-prefix': (b) => {
    for (const item of b.params.items!) item.actionDigest = item.actionDigest.replace(/^0x/, '');
  },
  // Body confusion (04 §2.5.2 "What is signed"): the params are valid for the other op only.
  'reject-batch-with-decide-params': (b) => {
    b.op = 'approval.decide';
  },
  'reject-decide-with-batch-params': (b) => {
    b.op = 'approval.decideBatch';
  },
};

describe('owner-action approval.decideBatch vectors follow 04 §2.5.2 (M1-2e, D-68)', () => {
  test('the owner-action suite is committed with the batch cases', () => {
    expect(ownerAction).toBeDefined();
    expect(signCases.map((c) => c.id).sort()).toStrictEqual(['sign-batch-2', 'sign-batch-20']);
  });

  test('every batch signing body is accepted unchanged by the strict schema', () => {
    for (const c of signCases) {
      const body = input(c).body;
      const parsed = approvalDecideBatchActionSchema.safeParse(body);
      expect(parsed.success, `${c.id}: ${parsed.error?.message ?? ''}`).toBe(true);
      expect(parsed.data, c.id).toStrictEqual(body);
    }
  });

  test('the signing vectors cover 2 and 20 items with mixed decisions', () => {
    for (const [id, n] of [
      ['sign-batch-2', 2],
      ['sign-batch-20', 20],
    ] as const) {
      const items = itemsOf(id);
      expect(items, id).toHaveLength(n);
      expect(new Set(items.map((i) => i.decision)), id).toStrictEqual(new Set(['approve', 'deny']));
    }
  });

  test('every accepted batch verify object passes every schema that carries it', () => {
    const accepts = verifyCases.filter((c) => outcome(c) === 'accept');
    expect(accepts.map((c) => c.id).sort()).toStrictEqual(['verify-batch-2', 'verify-batch-20']);
    for (const c of accepts) {
      const signed = input(c).signed;
      for (const schema of [
        signedOwnerActionSchema,
        signedApprovalOpSchema,
        signedApprovalDecideBatchSchema,
      ]) {
        const parsed = schema.safeParse(signed);
        expect(parsed.success, `${c.id}: ${parsed.error?.message ?? ''}`).toBe(true);
        expect(parsed.data, c.id).toStrictEqual(signed);
      }
    }
  });

  test('every named rejection vector is committed', () => {
    for (const id of Object.keys(REPAIRS)) {
      expect(byId(id), `${id} is missing`).toBeDefined();
      expect(byId(id)?.expected, id).toStrictEqual({ outcome: 'reject' });
    }
  });

  test('every batch rejection is refused by the schema for exactly its named rule', () => {
    const rejects = verifyCases.filter((c) => outcome(c) === 'reject');
    expect(rejects.map((c) => c.id).sort()).toStrictEqual(Object.keys(REPAIRS).sort());
    for (const c of rejects) {
      const signed = input(c).signed!;
      for (const schema of [
        signedOwnerActionSchema,
        signedApprovalOpSchema,
        signedApprovalDecideBatchSchema,
        signedApprovalDecideSchema,
      ]) {
        expect(schema.safeParse(signed).success, `${c.id}: schema accepts`).toBe(false);
      }
      const fixed = clone(signed) as { body: Body; sig: string };
      REPAIRS[c.id]!(fixed.body);
      const parsed = signedOwnerActionSchema.safeParse(fixed);
      expect(parsed.success, `${c.id} after repair: ${parsed.error?.message ?? ''}`).toBe(true);
      const own =
        fixed.body.op === 'approval.decide'
          ? approvalDecideActionSchema
          : approvalDecideBatchActionSchema;
      expect(own.safeParse(fixed.body).success, `${c.id} after repair (op schema)`).toBe(true);
    }
  });
});
