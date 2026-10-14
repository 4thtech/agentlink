// Property-based fuzzing (M1-2a acceptance): on any input, every schema either succeeds or reports a
// validation error. `safeParse` never throws, and `parse` throws only a ZodError. A value that passes
// is returned unchanged (deep-equal to the input).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  agentCardSchema,
  cardSigSchema,
  envelopeSchema,
  fileEntrySchema,
  inviteSchema,
  ownerActionSchema,
  payloadSchema,
  relayUrlSchema,
  signedOwnerActionSchema,
  uint256Decimal,
} from './index.js';
import {
  agentCard,
  approvalDecideAction,
  envelope,
  fileEntryInline,
  invite,
  payloads,
  signed,
} from './testing/fixtures.js';

const SCHEMAS = [
  ['envelope', envelopeSchema, envelope],
  ['payload', payloadSchema, () => payloads().handshake],
  ['fileEntry', fileEntrySchema, fileEntryInline],
  ['ownerAction', ownerActionSchema, approvalDecideAction],
  ['signedOwnerAction', signedOwnerActionSchema, () => signed(approvalDecideAction())],
  ['agentCard', agentCardSchema, agentCard],
  ['invite', inviteSchema, invite],
] as const;

const RUNS = { numRuns: 300, seed: 0x4a11 } as const;

/** Inputs a hostile peer can produce through JSON, plus non-JSON values a careless caller might pass. */
const anyInput = fc.oneof(
  fc.jsonValue(),
  fc.anything({ withBigInt: true, withNullPrototype: true, withObjectString: true }),
  fc.string({ unit: 'binary' }),
);

/** Replace one field (at any depth) of a valid value with an arbitrary value. */
function mutateOne(valid: unknown, replacement: unknown, pick: number): unknown {
  const copy = JSON.parse(JSON.stringify(valid)) as unknown;
  const slots: [Record<string | number, unknown>, string | number][] = [];
  const walk = (node: unknown) => {
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      slots.push([node as Record<string, unknown>, key]);
      walk((node as Record<string, unknown>)[key]);
    }
  };
  walk(copy);
  if (slots.length === 0) return replacement;
  const [parent, key] = slots[pick % slots.length] as [Record<string | number, unknown>, string];
  parent[key] = replacement;
  return copy;
}

function checkTotal(schema: z.ZodType, input: unknown): void {
  const out: { result?: { success: boolean; data?: unknown } } = {};
  expect(() => {
    out.result = schema.safeParse(input);
  }).not.toThrow();
  try {
    schema.parse(input);
  } catch (error) {
    expect(error).toBeInstanceOf(z.ZodError);
  }
  if (out.result?.success) expect(out.result.data).toEqual(input);
}

describe('fuzzing: only validation errors, never a crash', () => {
  it.each(SCHEMAS)('%s on arbitrary input', (_name, schema) => {
    fc.assert(
      fc.property(anyInput, (input) => checkTotal(schema, input)),
      RUNS,
    );
  });

  it.each(SCHEMAS)('%s on a valid value with one field replaced', (_name, schema, make) => {
    fc.assert(
      fc.property(anyInput, fc.nat(), (replacement, pick) =>
        checkTotal(schema, mutateOne(make(), replacement, pick)),
      ),
      RUNS,
    );
  });

  it.each(SCHEMAS)(
    '%s with one extra key at any object level is rejected',
    (_name, schema, make) => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 12 }),
          fc.jsonValue(),
          fc.nat(),
          (key, value, pick) => {
            const copy = JSON.parse(JSON.stringify(make())) as Record<string, unknown>;
            const objects: Record<string, unknown>[] = [];
            const walk = (node: unknown, generic: boolean) => {
              if (node === null || typeof node !== 'object' || Array.isArray(node)) {
                if (Array.isArray(node)) for (const item of node) walk(item, generic);
                return;
              }
              // Free-form JSON (policy placeholder, terms placeholder, args/context, message bodies)
              // is deliberately open; the strict shapes around it are what this property covers.
              if (!generic) objects.push(node as Record<string, unknown>);
              for (const [k, v] of Object.entries(node)) {
                walk(v, generic || ['policy', 'terms', 'args', 'context'].includes(k));
              }
            };
            walk(copy, false);
            const target = objects[pick % objects.length] as Record<string, unknown>;
            // Replacing a known key is the previous property; assigning __proto__ sets the prototype
            // instead of adding a key (JSON.parse does add it as an own key; encoding.test covers that).
            if (Object.hasOwn(target, key) || key === '__proto__') return;
            target[key] = value;
            expect(schema.safeParse(copy).success).toBe(false);
          },
        ),
        RUNS,
      );
    },
  );

  it.each([
    ['relayUrl', relayUrlSchema],
    ['cardSig', cardSigSchema],
    ['uint256Decimal', uint256Decimal],
  ] as const)('%s on arbitrary strings and values', (_name, schema) => {
    const strings = fc.oneof(
      fc.string({ unit: 'binary' }),
      fc.string().map((t) => `wss://${t}`),
      fc.string({ unit: fc.constantFrom(...'0123456789abcdefx.:/-'.split('')) }),
    );
    fc.assert(
      fc.property(fc.oneof(strings, anyInput), (input) => checkTotal(schema, input)),
      RUNS,
    );
  });
});
