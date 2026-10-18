// Suite `encodings` (M1-2a; 04 §2.4.1 canonical binary encodings). `decode` runs the @4thtech-io/types
// decoder that 04 §2.4.1 assigns to the schema path and returns the bytes as hex, or `reject` when
// the value is not in that path's one canonical form. `equalBytes` decodes both values, each by its
// own path, and compares the bytes (`reject` when either does not parse). `parseInteger` runs the
// strict JSON tokenizer of @4thtech-io/crypto with `integersOnly` (M1-1e) on the number token, so the
// token text decides, not the parsed value. Nothing here converts or compares encoded text itself.
import { CryptoInputError, parseJson } from '@4thtech-io/crypto';
import { decodeAtPath, equalAtPaths, isEncodingPath, type EncodingPath } from '@4thtech-io/types';
import { bytesToHex } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

interface PathValue {
  readonly path: EncodingPath;
  readonly value: string;
}

type EncodingsInput =
  | { op: 'decode'; path: EncodingPath; value: string }
  | { op: 'parseInteger'; json: string }
  | { op: 'equalBytes'; a: PathValue; b: PathValue };

const isPathValue = (v: unknown): v is PathValue => {
  const o = v as Record<string, unknown> | null;
  return (
    typeof o === 'object' && o !== null && isEncodingPath(o.path) && typeof o.value === 'string'
  );
};

// A path the decoder table does not know is a harness error, never a rejection: otherwise a reject
// vector on a missing path would pass.
function parseInput(input: unknown): EncodingsInput {
  const i = input as Record<string, unknown> | null;
  if (i?.op === 'decode' && isEncodingPath(i.path) && typeof i.value === 'string') {
    return i as EncodingsInput;
  }
  if (i?.op === 'parseInteger' && typeof i.json === 'string') return i as EncodingsInput;
  if (i?.op === 'equalBytes' && isPathValue(i.a) && isPathValue(i.b)) return i as EncodingsInput;
  throw new TypeError('encodings: input does not match any op of case.schema.json');
}

const REJECT: readonly Comparison[] = [{ field: 'outcome', actual: 'reject' }];

/** The value of one JSON number token, or null when the strict tokenizer refuses it. */
function parseIntegerToken(json: string): number | null {
  try {
    const value = parseJson(json, { integersOnly: true });
    return typeof value === 'number' ? value : null;
  } catch (error) {
    if (error instanceof CryptoInputError) return null;
    throw error;
  }
}

export const encodings: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    switch (input.op) {
      case 'decode': {
        const bytes = decodeAtPath(input.path, input.value);
        return Promise.resolve(
          bytes === null ? REJECT : [{ field: 'bytes', actual: bytesToHex(bytes) }],
        );
      }
      case 'parseInteger': {
        const value = parseIntegerToken(input.json);
        return Promise.resolve(
          value === null ? REJECT : [{ field: 'value', actual: String(value) }],
        );
      }
      case 'equalBytes': {
        const equal = equalAtPaths(input.a, input.b);
        return Promise.resolve(
          equal === null ? REJECT : [{ field: 'equal', actual: String(equal) }],
        );
      }
    }
  },
};
