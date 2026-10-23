// The owner-operation prepare builder against the owner-action signing vectors (M1-11r-b, D-118;
// 04 §2.5.1). The local UI server builds unsigned bodies with buildOwnerActionBody (@4thtech-io/core)
// and signs them after presence; the vectors come from the independent Python generator
// (tools/vectors/generate_owner_action.py). For every `sign` case of an op the builder prepares, the
// builder given the vector's fields must produce exactly the vector's JCS bytes, so a prepared body
// is byte-exact with what the verifier checks. Runs in the Node project only, like policy-form: the
// vectors are identical in every runtime and the cross-runtime JCS check is the owner-action suite.
import { buildOwnerActionBody, type PreparableOp } from '@4thtech-io/core';
import { describe, expect, test } from 'vitest';
import { vectorFiles, type VectorCase } from './registry';

const PREPARED: readonly string[] = [
  'policy.set',
  'contact.check',
  'contact.rename',
  'contact.remove',
];

interface SignInput {
  readonly op: 'sign';
  readonly body: Record<string, unknown>;
}

const ownerAction = vectorFiles.find((f) => f.directory === 'owner-action')?.file;
const cases: readonly VectorCase[] = ownerAction?.cases ?? [];
const signCases = cases.filter((c) => {
  const input = c.input as Partial<SignInput>;
  return input.op === 'sign' && PREPARED.includes(input.body?.op as string);
});

describe('owner-action prepare builder (M1-11r-b)', () => {
  test('every prepared op has at least one signing vector', () => {
    const ops = new Set(signCases.map((c) => (c.input as SignInput).body.op));
    expect([...ops].sort()).toEqual([...PREPARED].sort());
  });

  for (const c of signCases) {
    test(`${c.id}: the builder reproduces the vector's JCS bytes`, () => {
      const b = (c.input as SignInput).body;
      const { jcs } = buildOwnerActionBody({
        agent: b.agent as string,
        owner: b.owner as string,
        op: b.op as PreparableOp,
        params: b.params as never,
        nonce: b.nonce as string,
        issuedAt: b.issuedAt as number,
        expiresAt: b.expiresAt as number,
      });
      expect(jcs).toBe((c.expected as { jcs: string }).jcs);
    });
  }
});
