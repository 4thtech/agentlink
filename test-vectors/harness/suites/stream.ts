// Suite `stream` (M1-1d, vectors M1-1i-b): ALF1 STREAM file encryption (04 §4, D-80) through
// @4thtech-io/crypto. `seal` uses the test seam's fixed nonce prefix and chunk size (the vectors use
// 16 and 32 B chunks as well as the 1 MiB default), returns the object, its header and both
// hashes, and then opens the object through the public API, which must give the plaintext back.
// `open` gives an object that must be refused: a refusal by the code under test
// (CryptoInputError) is reported as `outcome: reject`, an object that opens as `outcome: accept`.
// Any other error is a bug and fails the case.
import { CryptoInputError, openAlf1 } from '@4thtech-io/crypto';
import { sealAlf1WithNoncePrefix } from '@4thtech-io/crypto/testing';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type StreamInput =
  | {
      op: 'seal';
      fileKey: string;
      noncePrefix: string;
      chunkSize: number;
      plaintext: string;
    }
  | { op: 'open'; fileKey: string; ciphertext: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseInput(input: unknown): StreamInput {
  if (isObject(input)) {
    const i = input;
    if (
      i.op === 'seal' &&
      typeof i.fileKey === 'string' &&
      typeof i.noncePrefix === 'string' &&
      typeof i.chunkSize === 'number' &&
      typeof i.plaintext === 'string'
    ) {
      return {
        op: 'seal',
        fileKey: i.fileKey,
        noncePrefix: i.noncePrefix,
        chunkSize: i.chunkSize,
        plaintext: i.plaintext,
      };
    }
    if (i.op === 'open' && typeof i.fileKey === 'string' && typeof i.ciphertext === 'string') {
      return { op: 'open', fileKey: i.fileKey, ciphertext: i.ciphertext };
    }
  }
  throw new TypeError(
    'stream: input does not match any op of test-vectors/stream/case.schema.json',
  );
}

async function seal(input: Extract<StreamInput, { op: 'seal' }>): Promise<readonly Comparison[]> {
  const plaintext = hexToBytes(input.plaintext);
  const sealed = await sealAlf1WithNoncePrefix(
    hexToBytes(input.fileKey),
    hexToBytes(input.noncePrefix),
    input.chunkSize,
    plaintext,
  );
  const opened = await openAlf1(hexToBytes(input.fileKey), sealed.ciphertext);
  if (bytesToHex(opened.plaintext) !== input.plaintext) {
    throw new Error('stream: the sealed object does not open to its plaintext');
  }
  if (bytesToHex(opened.ciphertextSha256) !== bytesToHex(sealed.ciphertextSha256)) {
    throw new Error('stream: seal and open disagree on the ciphertext hash');
  }
  if (bytesToHex(opened.plaintextSha256) !== bytesToHex(sealed.plaintextSha256)) {
    throw new Error('stream: seal and open disagree on the plaintext hash');
  }
  return [
    { field: 'header', actual: bytesToHex(sealed.ciphertext.subarray(0, 17)) },
    { field: 'ciphertext', actual: bytesToHex(sealed.ciphertext) },
    { field: 'ciphertextSha256', actual: bytesToHex(sealed.ciphertextSha256) },
    { field: 'plaintextSha256', actual: bytesToHex(sealed.plaintextSha256) },
  ];
}

async function open(input: Extract<StreamInput, { op: 'open' }>): Promise<readonly Comparison[]> {
  try {
    await openAlf1(hexToBytes(input.fileKey), hexToBytes(input.ciphertext));
    return [{ field: 'outcome', actual: 'accept' }];
  } catch (error) {
    if (error instanceof CryptoInputError) return [{ field: 'outcome', actual: 'reject' }];
    throw error;
  }
}

export const stream: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    return input.op === 'seal' ? seal(input) : open(input);
  },
};
