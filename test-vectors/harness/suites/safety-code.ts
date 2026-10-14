// Suite `safety-code` (M1-1f): 04 §3.6.1 codeCommit, the reveal check, T, pairingDigest and the
// 12-digit code, and the two labels, through @agentlink/crypto. The `code` op derives codeCommit from
// inviteId and nonceA with the code under test and passes it in, because the code is computed only
// after the commitment check (step 3, IR-M1-1f-1 M-2). Wire values are decoded with the strict
// base64url decoder; a refusal (CryptoInputError) or a reveal that does not open is
// `outcome: reject`. The steps 1-5 recomputation is the `safety-code-recompute` suite (M1-1c).
// pairingDigest is not public (IR-M1-1f-1 L-7); the `labels` op reaches it through the test seam.
import {
  CryptoInputError,
  TAGS,
  checkSafetyCodeReveal,
  computeSafetyCode,
  decodeBase64url,
  encodeBase64url,
  safetyCodeCommit,
  taggedHash,
} from '@agentlink/crypto';
import { pairingDigest } from '@agentlink/crypto/testing';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type SafetyCodeInput =
  | { op: 'commit'; inviteId: string; nonceA: string }
  | { op: 'checkReveal'; inviteId: string; codeCommit: string; codeReveal: string }
  | {
      op: 'code';
      cardA: unknown;
      cardB: unknown;
      inviteId: string;
      nonceA: string;
      nonceB: string;
    }
  | { op: 'labels'; input: string };

function parseInput(input: unknown): SafetyCodeInput {
  const i = input as Record<string, unknown> | null;
  const str = (key: string): boolean => typeof i?.[key] === 'string';
  const obj = (key: string): boolean => typeof i?.[key] === 'object' && i[key] !== null;
  if (i?.op === 'commit' && str('inviteId') && str('nonceA')) return i as SafetyCodeInput;
  if (i?.op === 'checkReveal' && str('inviteId') && str('codeCommit') && str('codeReveal')) {
    return i as SafetyCodeInput;
  }
  if (
    i?.op === 'code' &&
    obj('cardA') &&
    obj('cardB') &&
    str('inviteId') &&
    str('nonceA') &&
    str('nonceB')
  ) {
    return i as SafetyCodeInput;
  }
  if (i?.op === 'labels' && str('input')) return i as SafetyCodeInput;
  throw new TypeError('safety-code: input does not match any op of case.schema.json');
}

const b64 = (text: string, length: number): Uint8Array => decodeBase64url(text, { length });

function evaluateInput(input: SafetyCodeInput): readonly Comparison[] {
  switch (input.op) {
    case 'commit':
      return [
        {
          field: 'codeCommit',
          actual: encodeBase64url(safetyCodeCommit(b64(input.inviteId, 16), b64(input.nonceA, 32))),
        },
      ];
    case 'checkReveal': {
      const ok = checkSafetyCodeReveal(
        b64(input.inviteId, 16),
        b64(input.codeReveal, 32),
        b64(input.codeCommit, 32),
      );
      return [{ field: 'outcome', actual: ok ? 'accept' : 'reject' }];
    }
    case 'code': {
      const inviteId = b64(input.inviteId, 16);
      const nonceA = b64(input.nonceA, 32);
      const result = computeSafetyCode({
        inviterCard: input.cardA,
        inviteeCard: input.cardB,
        inviteId,
        nonceA,
        nonceB: b64(input.nonceB, 32),
        codeCommit: safetyCodeCommit(inviteId, nonceA),
      });
      return [
        { field: 'transcript', actual: bytesToHex(result.transcript) },
        { field: 'pairingDigest', actual: bytesToHex(result.pairingDigest) },
        { field: 'integer', actual: result.integer.toString() },
        { field: 'code', actual: result.code },
      ];
    }
    case 'labels': {
      const t = hexToBytes(input.input);
      return [
        { field: 'safetyCommit', actual: bytesToHex(taggedHash(TAGS.safetyCommit, t)) },
        { field: 'safetyCode', actual: bytesToHex(pairingDigest(t)) },
      ];
    }
  }
}

export const safetyCode: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    try {
      return Promise.resolve(evaluateInput(input));
    } catch (error) {
      if (error instanceof CryptoInputError) {
        return Promise.resolve([{ field: 'outcome', actual: 'reject' }]);
      }
      throw error;
    }
  },
};
