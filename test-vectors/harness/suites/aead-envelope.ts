// Suite `aead-envelope` (M1-1c): the 04 §3.1 envelope through @agentlink/crypto. `envelopeHash` and
// `aad` hash the given envelope; `encryptPayload` encrypts under the given IV through the test
// seam; `decryptPayload` opens the envelope's aead; `sign` returns the hash, the tagged signature
// input and the signature; `verify` checks the signature; `validate` parses the envelope strictly
// (structure and encodings) and then checks the signature. Inputs go to the code under test
// unchecked, so its own refusals (CryptoInputError) and a failed verification are what
// `outcome: reject` measures; any other error is a bug and fails the case.
import {
  CryptoInputError,
  decodeBase64url,
  decryptPayload,
  envelopeAad,
  envelopeHash,
  envelopeSignatureInput,
  parseEnvelope,
  verifyEnvelope,
  type Envelope,
  type EnvelopeHeader,
  type UnsignedEnvelope,
} from '@agentlink/crypto';
import { signEnvelopeHash } from '@agentlink/crypto/keystore';
import { encryptPayloadWithIv } from '@agentlink/crypto/testing';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type AeadEnvelopeInput =
  | { op: 'envelopeHash' | 'aad' | 'verify' | 'validate'; envelope: object }
  | { op: 'encryptPayload'; header: object; cek: string; iv: string; plaintext: string }
  | { op: 'decryptPayload'; envelope: object; cek: string }
  | { op: 'sign'; envelope: object; secretKey: string; auxRand: string };

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
  if (i?.op === 'decryptPayload' && obj('envelope') && str('cek')) return i as AeadEnvelopeInput;
  if (i?.op === 'sign' && obj('envelope') && str('secretKey', 'auxRand')) {
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
        { field: 'ct', actual: aead.ct },
      ];
    }
    case 'decryptPayload': {
      const envelope = input.envelope as UnsignedEnvelope;
      const plaintext = await decryptPayload(envelope, hexToBytes(input.cek));
      return [{ field: 'plaintext', actual: bytesToHex(plaintext) }];
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
  }
}

export const aeadEnvelope: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    return rejectedOr(() => evaluateInput(input));
  },
};
