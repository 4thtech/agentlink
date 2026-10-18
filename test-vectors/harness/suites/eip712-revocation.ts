// Suite `eip712-revocation` (M1-1j, vectors M1-1i-b): EIP-712 hashing of the OCCRegistry
// `Revocation` struct (05 §4, D-81) and of a `Registration` that shares its owner nonce, through
// @4thtech-io/crypto. A refusal by the code under test (CryptoInputError) is reported as
// `outcome: reject`. Any other error is a bug and fails the case.
import {
  CryptoInputError,
  hashRegistration,
  hashRevocation,
  type ProofTypeHashes,
} from '@4thtech-io/crypto';
import { bytesToHex } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type RevocationInput =
  | { op: 'revocation'; domain: unknown; message: unknown }
  | { op: 'registration'; domain: unknown; message: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseInput(input: unknown): RevocationInput {
  if (isObject(input)) {
    if (input.op === 'revocation' && 'revocation' in input) {
      return { op: 'revocation', domain: input.domain, message: input.revocation };
    }
    if (input.op === 'registration' && 'registration' in input) {
      return { op: 'registration', domain: input.domain, message: input.registration };
    }
  }
  throw new TypeError(
    'eip712-revocation: input does not match any op of test-vectors/eip712-revocation/case.schema.json',
  );
}

function rejectedOr(run: () => readonly Comparison[]): readonly Comparison[] {
  try {
    return run();
  } catch (error) {
    if (error instanceof CryptoInputError) return [{ field: 'outcome', actual: 'reject' }];
    throw error;
  }
}

const hashFields = (hashes: ProofTypeHashes): readonly Comparison[] => [
  { field: 'typeHash', actual: bytesToHex(hashes.typeHash) },
  { field: 'domainSeparator', actual: bytesToHex(hashes.domainSeparator) },
  { field: 'structHash', actual: bytesToHex(hashes.structHash) },
  { field: 'digest', actual: bytesToHex(hashes.digest) },
];

function evaluate(input: RevocationInput): readonly Comparison[] {
  switch (input.op) {
    case 'revocation':
      return rejectedOr(() => hashFields(hashRevocation(input.domain, input.message)));
    case 'registration':
      return rejectedOr(() => hashFields(hashRegistration(input.domain, input.message)));
  }
}

export const eip712Revocation: SuiteModule = {
  evaluate(testCase) {
    return Promise.resolve(evaluate(parseInput(testCase.input)));
  },
};
