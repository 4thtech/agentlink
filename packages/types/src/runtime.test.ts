// Runtime identity and zod's evaluation mode (M1-2c). Every project of vitest.config.ts runs this
// file, so a project that silently falls back to Node fails here, and the workerd project proves that
// the schemas ran without zod's compiled parsers.
import { describe, expect, inject, it } from 'vitest';
import { util } from 'zod/v4/core';
import {
  agentCardSchema,
  envelopeSchema,
  inviteSchema,
  payloadSchema,
  policySchema,
  proofPackSchema,
  signedOwnerActionSchema,
} from './index.js';
import {
  agentCard,
  approvalDecideAction,
  envelope,
  invite,
  payloads,
  policyWithRules,
  proofPack,
  signed,
} from './testing/fixtures.js';
import { observeRuntime, type RuntimeId } from './testing/runtime.js';

declare module 'vitest' {
  interface ProvidedContext {
    /** The runtime this project must run in; set per project in vitest.config.ts. */
    typesRuntime: RuntimeId;
  }
}

const expected = inject('typesRuntime');

describe('runtime identity', () => {
  it('the engine is the runtime the project asked for', () => {
    expect(expected, 'the project must provide typesRuntime').toBeTypeOf('string');
    const observed = observeRuntime();
    expect(observed.id, `observed: ${observed.detail}`).toBe(expected);
  });
});

describe('zod code generation', () => {
  // zod compiles object parsers with `new Function` where it can, and interprets the schema where it
  // cannot. workerd forbids code generation from strings, and zod recognises it by its user agent
  // before it tries. (The pool's test runtime itself still permits `new Function`, so the detection,
  // not a thrown error, is what selects the fallback here, as it is in production workerd.)
  it('compiles parsers everywhere except workerd, where it interprets them', () => {
    expect(util.allowsEval.value).toBe(expected !== 'workerd');
  });

  // The interpreted path is also forced per parse (`jitless`), so it runs in every runtime and must
  // agree with the default path on valid values and on rejections, down to the issue paths.
  const SAMPLES = [
    ['envelope', envelopeSchema, envelope()],
    ['agentCard', agentCardSchema, agentCard()],
    ['invite', inviteSchema, invite()],
    ['policy', policySchema, policyWithRules()],
    ['signedOwnerAction', signedOwnerActionSchema, signed(approvalDecideAction())],
    ['proofPack', proofPackSchema, proofPack()],
    ...Object.entries(payloads()).map(
      ([type, p]) => [`payload ${type}`, payloadSchema, p] as const,
    ),
  ] as const;

  it.each(SAMPLES)('%s: interpreted and compiled parsing agree', (_name, schema, valid) => {
    const broken = { ...(valid as Record<string, unknown>), unexpected: 1 };
    for (const [value, wantSuccess] of [
      [valid, true],
      [broken, false],
      [null, false],
    ] as const) {
      const defaulted = schema.safeParse(value);
      const interpreted = schema.safeParse(value, { jitless: true });
      expect(defaulted.success).toBe(wantSuccess);
      expect(interpreted.success).toBe(wantSuccess);
      expect(interpreted.error?.issues ?? null).toStrictEqual(defaulted.error?.issues ?? null);
    }
  });
});
