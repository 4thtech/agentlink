// Suite `aead-envelope` (M1-1c; key commitment M1-1l, G-46, D-66): the 04 §3.1 envelope through
// @4thtech-io/crypto. `envelopeHash` and `aad` hash the given envelope; `encryptPayload` encrypts
// under the given IV through the test seam and returns the AAD, `kc` and `ct`; `decryptPayload`
// opens the envelope's aead (kc first, then AES-GCM); `checkCommitment` checks `aead.kc` against
// the CEK alone; `deriveFromCek` runs one 04 §3.3 derivation by its label through the test seam;
// `sign` returns the hash, the tagged signature input and the signature; `verify` checks the
// signature; `validate` parses the envelope strictly (structure and encodings) and then checks the
// signature; `verifyText` parses the received text (04 §3.1.1 step 3, §2.5.1 "Received text",
// M1-1h-b) with parseEnvelopeText and then checks the signature. Inputs go to the code under test unchecked, so its own refusals (CryptoInputError)
// and a failed check are what `outcome: reject` measures; any other error is a bug and fails the
// case.
import {
  CryptoInputError,
  checkKeyCommitment,
  decodeBase64url,
  decryptPayload,
  envelopeAad,
  envelopeHash,
  envelopeSignatureInput,
  parseEnvelope,
  parseEnvelopeText,
  verifyEnvelope,
  type Envelope,
  type EnvelopeHeader,
  type UnsignedEnvelope,
} from '@4thtech-io/crypto';
import { signEnvelopeHash } from '@4thtech-io/crypto/keystore';
import { deriveFromCek, encryptPayloadWithIv } from '@4thtech-io/crypto/testing';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type AeadEnvelopeInput =
  | { op: 'envelopeHash' | 'aad' | 'verify' | 'validate'; envelope: object }
  | { op: 'encryptPayload'; header: object; cek: string; iv: string; plaintext: string }
  | { op: 'decryptPayload' | 'checkCommitment'; envelope: object; cek: string }
  | { op: 'deriveFromCek'; label: string; cek: string; envelopeId: string }
  | { op: 'sign'; envelope: object; secretKey: string; auxRand: string }
  | { op: 'verifyText'; json: string };

const ENVELOPE_OPS = new Set(['envelopeHash', 'aad', 'verify', 'validate']);

function parseInput(input: unknown): AeadEnvelopeInput {
  const i = input as Record<string, unknown> | null;
  const str = (...keys: string[]): boolean => keys.every((key) => typeof i?.[key] === 'string');
  const obj = (key: string): boolean => typeof i?.[key] === 'object' && i[key] !== null;
  if (typeof i?.op === 'string' && ENVELOPE_OPS.has(i.op) && obj('envelope')) {
    return i as AeadEnvelopeInput;
  }
  if (i?.op === 'encryptPayload' && obj('header') && str('cek', 'iv', 'plaintext')) {
    return i as AeadEnvelopeInput;
  }
  if (
    (i?.op === 'decryptPayload' || i?.op === 'checkCommitment') &&
    obj('envelope') &&
    str('cek')
  ) {
    return i as AeadEnvelopeInput;
  }
  if (i?.op === 'deriveFromCek' && str('label', 'cek', 'envelopeId')) {
    return i as AeadEnvelopeInput;
  }
  if (i?.op === 'sign' && obj('envelope') && str('secretKey', 'auxRand')) {
    return i as AeadEnvelopeInput;
  }
  if (i?.op === 'verifyText' && str('json')) {
    return i as AeadEnvelopeInput;
  }
  throw new TypeError('aead-envelope: input does not match any op of case.schema.json');
}

const outcome = (accepted: boolean): readonly Comparison[] => [
  { field: 'outcome', actual: accepted ? 'accept' : 'reject' },
];

async function rejectedOr(
  run: () => Promise<readonly Comparison[]>,
): Promise<readonly Comparison[]> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CryptoInputError) return outcome(false);
    throw error;
  }
}

async function evaluateInput(input: AeadEnvelopeInput): Promise<readonly Comparison[]> {
  switch (input.op) {
    case 'envelopeHash':
      return [
        { field: 'envelopeHash', actual: bytesToHex(envelopeHash(input.envelope as Envelope)) },
      ];
    case 'aad':
      return [{ field: 'aad', actual: bytesToHex(envelopeAad(input.envelope as Envelope)) }];
    case 'encryptPayload': {
      const header = input.header as EnvelopeHeader;
      const aead = await encryptPayloadWithIv(
        header,
        hexToBytes(input.cek),
        decodeBase64url(input.iv),
        hexToBytes(input.plaintext),
      );
      return [
        { field: 'aad', actual: bytesToHex(envelopeAad(header)) },
        { field: 'kc', actual: aead.kc },
        { field: 'ct', actual: aead.ct },
      ];
    }
    case 'decryptPayload': {
      const envelope = input.envelope as UnsignedEnvelope;
      const plaintext = await decryptPayload(envelope, hexToBytes(input.cek));
      return [{ field: 'plaintext', actual: bytesToHex(plaintext) }];
    }
    case 'checkCommitment':
      return outcome(checkKeyCommitment(input.envelope as UnsignedEnvelope, hexToBytes(input.cek)));
    case 'deriveFromCek': {
      // The id is decoded without a length, so a wrong-length id reaches the code under test.
      const okm = deriveFromCek(
        input.label,
        hexToBytes(input.cek),
        decodeBase64url(input.envelopeId),
      );
      return [{ field: 'okm', actual: bytesToHex(okm) }];
    }
    case 'sign': {
      const digest = envelopeHash(input.envelope as UnsignedEnvelope);
      const sig = signEnvelopeHash(hexToBytes(input.secretKey), digest, hexToBytes(input.auxRand));
      return [
        { field: 'envelopeHash', actual: bytesToHex(digest) },
        { field: 'signatureInput', actual: bytesToHex(envelopeSignatureInput(digest)) },
        { field: 'sig', actual: bytesToHex(sig) },
      ];
    }
    case 'verify':
      return outcome(verifyEnvelope(input.envelope as Envelope));
    case 'validate':
      return outcome(verifyEnvelope(parseEnvelope(input.envelope)));
    case 'verifyText':
      return outcome(verifyEnvelope(parseEnvelopeText(input.json)));
  }
}

export const aeadEnvelope: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    return rejectedOr(() => evaluateInput(input));
  },
};
