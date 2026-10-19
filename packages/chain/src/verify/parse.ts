// Strict parsing of a proof pack (07 §8; 04 §2.4.1; I-5). The pack is untrusted: it is bounded in
// size before it is read, parsed by the strict JSON parser of @4thtech-io/crypto (no duplicate keys,
// protocol integers only) and then by the ProofPack v1 schema of @4thtech-io/types. Nothing is
// normalised, and a refusal is a fixed code: no parse detail, field value or path leaves this file.
import { decodeUtf8, encodeUtf8, parseJson, type JsonValue } from '@4thtech-io/crypto';
import {
  RECORD_KINDS,
  base64urlByteLength,
  proofPackSchema,
  type ProofPack,
} from '@4thtech-io/types';
import type { ProofPackFailure } from './reasons.js';

/** The largest pack accepted, in UTF-8 bytes: the 06 §2.4 `agentlink_verify_proof_pack` cap. */
export const MAX_PROOF_PACK_BYTES = 256 * 1024;

/** A pack that passed the strict schema. */
export type ParsedProofPack = ProofPack;

export type ParseResult =
  | { readonly ok: true; readonly pack: ParsedProofPack }
  | { readonly ok: false; readonly reason: ProofPackFailure };

const KINDS: ReadonlySet<unknown> = new Set(Object.values(RECORD_KINDS));
/** `0x` + a non-empty, even number of lowercase hex digits (04 §2.4.1, an ERC-1271 signature). */
const ERC1271_SIGNATURE = /^0x(?:[0-9a-f]{2})+$/;
const ECDSA_SIGNATURE_BYTES = 65;
/** A canonical 65-byte form (r = s = 1, v = 27), only to run the schema's other checks. */
const CANONICAL_STAND_IN = `0x${'0'.repeat(62)}01${'0'.repeat(62)}011b`;
const refuse = (reason: ProofPackFailure): ParseResult => ({ ok: false, reason });

/** The pack's JSON text, bounded, or a refusal. An object is serialised and then parsed like text. */
function packText(input: unknown): string | ProofPackFailure {
  if (input instanceof Uint8Array) {
    if (input.length > MAX_PROOF_PACK_BYTES) return 'pack_too_large';
    try {
      return decodeUtf8(input);
    } catch {
      return 'malformed_pack';
    }
  }
  let text: unknown = input;
  if (typeof input !== 'string') {
    if (typeof input !== 'object' || input === null) return 'malformed_pack';
    try {
      text = JSON.stringify(input);
    } catch {
      // A cycle, a bigint or a throwing toJSON: not a JSON document.
      return 'malformed_pack';
    }
  }
  if (typeof text !== 'string') return 'malformed_pack';
  // A UTF-16 length above the cap is a UTF-8 length above it too; only then encode to measure.
  if (text.length > MAX_PROOF_PACK_BYTES) return 'pack_too_large';
  if (encodeUtf8(text).length > MAX_PROOF_PACK_BYTES) return 'pack_too_large';
  return text;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The fields that get a specific code before the schema runs (07 §8 shape rules; D-86): the pack
 * type and version, a disclosure without its envelope, a content key that is not 32 bytes, and a
 * record kind outside the fixed six.
 */
function precheck(value: JsonValue): ProofPackFailure | null {
  if (!isObject(value)) return 'malformed_pack';
  if (value.type !== 'agentlink.proof' || value.version !== 1) return 'unsupported_pack';
  const disclosure = value.disclosure;
  if (disclosure !== null && disclosure !== undefined) {
    if (!Object.hasOwn(value, 'envelope')) return 'envelope_missing';
    const key = isObject(disclosure) ? disclosure.contentKey : undefined;
    if (typeof key !== 'string' || base64urlByteLength(key) !== 32) return 'content_key_invalid';
  }
  const record = value.record;
  if (isObject(record) && Object.hasOwn(record, 'kind') && !KINDS.has(record.kind)) {
    return 'invalid_kind';
  }
  return null;
}

/** Parses an untrusted pack: JSON text, its UTF-8 bytes, or a parsed JSON object. Never throws. */
export function parseProofPack(input: unknown): ParseResult {
  const text = packText(input);
  if (text === 'pack_too_large' || text === 'malformed_pack') return refuse(text);
  let value: JsonValue;
  try {
    value = parseJson(text as string, { integersOnly: true });
  } catch {
    return refuse('malformed_pack');
  }
  const early = precheck(value);
  if (early !== null) return refuse(early);
  // The schema holds every 65-byte signature to the canonical ECDSA form. That rule is for the EOA
  // path; a smart account (a Safe: v of 0, 1 or above 30) may return any bytes that its
  // `isValidSignature` accepts, so a 65-byte signature in any other form is checked here for its
  // JSON form only and then goes to ERC-1271; the EOA path still decodes it canonically
  // (verify.ts, decodeEcdsaSignature) and refuses it (IR-M1-4d-1 L-2).
  const signature = (value as Record<string, unknown>).signature;
  const loose =
    typeof signature === 'string' &&
    signature.length === 2 + 2 * ECDSA_SIGNATURE_BYTES &&
    ERC1271_SIGNATURE.test(signature);
  const parsed = proofPackSchema.safeParse(
    loose ? { ...(value as Record<string, unknown>), signature: CANONICAL_STAND_IN } : value,
  );
  if (!parsed.success) return refuse('malformed_pack');
  return {
    ok: true,
    pack: loose ? { ...parsed.data, signature: signature as string } : parsed.data,
  };
}
