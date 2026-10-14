// Suite `jcs` (M1-1a): RFC 8785 through @agentlink/crypto. `canonicalize` parses the JSON text with
// the strict parser and canonicalises it; `number` serialises one IEEE 754 double. A refusal by the
// code under test (CryptoInputError) is reported as `outcome: reject`; any other error is a bug and
// fails the case.
import {
  CryptoInputError,
  canonicalizeToBytes,
  parseJson,
  serializeNumber,
  sha256,
} from '@agentlink/crypto';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type JcsInput = { op: 'canonicalize'; json: string } | { op: 'number'; ieee754: string };

function parseInput(input: unknown): JcsInput {
  const i = input as { op?: unknown; json?: unknown; ieee754?: unknown } | null;
  if (i?.op === 'canonicalize' && typeof i.json === 'string') {
    return { op: 'canonicalize', json: i.json };
  }
  if (i?.op === 'number' && typeof i.ieee754 === 'string' && /^[0-9a-f]{16}$/.test(i.ieee754)) {
    return { op: 'number', ieee754: i.ieee754 };
  }
  throw new TypeError(
    'jcs: input must be { op: "canonicalize", json } or { op: "number", ieee754 }',
  );
}

/** The double whose big-endian IEEE 754 bits are the 16 hex digits. */
function doubleFromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  hexToBytes(hex).forEach((byte, index) => view.setUint8(index, byte));
  return view.getFloat64(0, false);
}

function rejectedOr(run: () => readonly Comparison[]): readonly Comparison[] {
  try {
    return run();
  } catch (error) {
    if (error instanceof CryptoInputError) return [{ field: 'outcome', actual: 'reject' }];
    throw error;
  }
}

export const jcs: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    if (input.op === 'number') {
      const value = doubleFromBits(input.ieee754);
      return Promise.resolve(rejectedOr(() => [{ field: 'json', actual: serializeNumber(value) }]));
    }
    return Promise.resolve(
      rejectedOr(() => {
        const bytes = canonicalizeToBytes(parseJson(input.json));
        return [
          { field: 'utf8', actual: bytesToHex(bytes) },
          { field: 'sha256', actual: bytesToHex(sha256(bytes)) },
        ];
      }),
    );
  },
};
