// Suite `eip712-proof` (M1-1j): EIP-712 hashing of the OCC v2 proof types `Record`, `Receipt` and
// `Registration` (05 §3.1, §4; 04 §5) and the recipient commitment, through @4thtech-io/crypto. A
// refusal by the code under test (CryptoInputError) is reported as `outcome: reject`. Any other
// error is a bug and fails the case.
import {
  CryptoInputError,
  encodeHex0x,
  hashRecord,
  hashReceipt,
  hashRegistration,
  recipientCommitment,
  type ProofTypeHashes,
} from '@4thtech-io/crypto';
import { bytesToHex } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type ProofInput =
  | { op: 'record'; domain: unknown; message: unknown }
  | { op: 'receipt'; domain: unknown; message: unknown }
  | { op: 'registration'; domain: unknown; message: unknown }
  | { op: 'recipientCommitment'; recipient: string; salt: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseInput(input: unknown): ProofInput {
  if (isObject(input)) {
    const i = input;
    switch (i.op) {
      case 'record':
        if ('record' in i) return { op: i.op, domain: i.domain, message: i.record };
        break;
      case 'receipt':
        if ('receipt' in i) return { op: i.op, domain: i.domain, message: i.receipt };
        break;
      case 'registration':
        if ('registration' in i) return { op: i.op, domain: i.domain, message: i.registration };
        break;
      case 'recipientCommitment':
        if (typeof i.recipient === 'string' && typeof i.salt === 'string') {
          return { op: i.op, recipient: i.recipient, salt: i.salt };
        }
        break;
    }
  }
  throw new TypeError(
    'eip712-proof: input does not match any op of test-vectors/eip712-proof/case.schema.json',
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

function evaluate(input: ProofInput): readonly Comparison[] {
  switch (input.op) {
    case 'record':
      return rejectedOr(() => hashFields(hashRecord(input.domain, input.message)));
    case 'receipt':
      return rejectedOr(() => hashFields(hashReceipt(input.domain, input.message)));
    case 'registration':
      return rejectedOr(() => hashFields(hashRegistration(input.domain, input.message)));
    case 'recipientCommitment':
      return [
        {
          field: 'recipientCommitment',
          actual: encodeHex0x(recipientCommitment(input.recipient, input.salt)),
        },
      ];
  }
}

export const eip712Proof: SuiteModule = {
  evaluate(testCase) {
    return Promise.resolve(evaluate(parseInput(testCase.input)));
  },
};
