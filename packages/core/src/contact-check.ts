// `contact.check` verification (04 §2.5.1, §3.6.1; G-28, G-7; M1-7c-b). Pure: every input, `now`
// included, is passed in, and the pairing digest comes from a lookup the caller supplies, so the
// vector harness runs it in every runtime with the stored pairs a case names. The store side (the
// recomputation from the stored envelopes, the nonce and the `contacts.safety_check` write in one
// transaction) is ContactBook.applyContactCheck.
//
// Order of the checks (04 §2.5.1): the exact encoding (the strict `contact.check` schema, M1-2f:
// rejected, never normalised); `agent` is the receiving agent; `owner` equals, as bytes, ownerNostr
// in that agent's card; `sig` is BIP-340 by `owner` over taggedHash("agentlink/owner-action/v1",
// sha256(JCS(body))); `issuedAt ≤ now + S`; `now ≤ expiresAt`; `expiresAt − issuedAt ≤ L(op)`. Then
// the op's rule (04 §3.6.1): `contact` is a contact with a completed pairing, and `pairingDigest`
// equals the digest recomputed from that pairing's signed `handshake` and `handshake-ack`, never a
// stored digest. The nonce is the store's, inside the apply transaction (07 §3.4).
//
// This is the contact.check part of the SignedOwnerAction verifier; the general one (every op, the
// nonce table, refusal reports) is M1-7d.
//
// I-5: the input is untrusted. Refusals are fixed codes; nothing from the input is interpolated.
import {
  TAGS,
  bip340Verify,
  canonicalize,
  canonicalizeToBytes,
  decodeHex,
  decodeHex0x,
  encodeHex,
  equalBytes,
  sha256,
  taggedHash,
  type JsonValue,
} from '@agentlink/crypto';
import {
  CLOCK_SKEW_SECONDS,
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  signedContactCheckSchema,
  type SignedContactCheck,
} from '@agentlink/types';

/** Why a `contact.check` was refused. Fixed codes; never input text (I-5, I-7). */
export type ContactCheckRefusal =
  // the object (04 §2.5.1): dropped, nothing written
  | 'malformed'
  | 'agent_mismatch'
  | 'owner_mismatch'
  | 'signature_invalid'
  | 'issued_in_future'
  | 'expired'
  | 'lifetime_exceeded'
  // the op's rule (04 §3.6.1)
  | 'contact_unknown'
  | 'pairing_unavailable'
  | 'digest_mismatch'
  // the store (07 §3.4)
  | 'nonce_used'
  | 'store_changed'
  | 'identity_missing';

/** The receiving agent, as the checks need it. */
export interface ContactCheckContext {
  /** The agent's own ID: its EVM address, `0x` + 40 lowercase hex (04 §2.9). */
  readonly agent: string;
  /** `ownerNostr` of the agent's own card, as the card spells it: `0x` + 64 hex (04 §2.4.1). */
  readonly ownerNostr: string;
  /** Unix seconds, from the verifying core's own clock. */
  readonly now: number;
}

/**
 * The digest of a contact's current pairing, recomputed from its stored signed `handshake` and
 * `handshake-ack` (04 §3.6.1 steps 1-5). `unknown`: no such contact with a completed pairing.
 * `unavailable`: the stored pair does not verify ("Can't show the safety code").
 */
export type PairingDigestLookup =
  | { readonly status: 'ok'; readonly pairingDigest: string }
  | { readonly status: 'unknown' }
  | { readonly status: 'unavailable' };

export type ContactCheckVerdict =
  | {
      readonly ok: true;
      readonly signed: SignedContactCheck;
      /** sha256(JCS(SignedOwnerAction)), 64 lowercase hex (07 §3.4 `action_hash`). */
      readonly actionHash: string;
    }
  | { readonly ok: false; readonly reason: ContactCheckRefusal };

const LIFETIME = OWNER_ACTION_MAX_LIFETIME_SECONDS['contact.check'];

const refuse = (reason: ContactCheckRefusal): ContactCheckVerdict => ({ ok: false, reason });

/**
 * The strict form, unchanged: the schema accepts it and its JCS equals the input's JCS, so the
 * object that is verified, stored and compared is exactly the one that was signed.
 */
function parseExact(signed: unknown): SignedContactCheck | undefined {
  const parsed = signedContactCheckSchema.safeParse(signed);
  if (!parsed.success) return undefined;
  try {
    if (canonicalize(parsed.data as JsonValue) !== canonicalize(signed as JsonValue)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return parsed.data;
}

/** `agent`, `owner` (as bytes) and `sig`: the checks a stored object passes on every load. */
function checkAuthority(
  signed: SignedContactCheck,
  agent: string,
  ownerNostr: string,
): ContactCheckRefusal | undefined {
  const { body } = signed;
  if (body.agent !== agent) return 'agent_mismatch';
  let owner: Uint8Array;
  try {
    owner = decodeHex(body.owner, { length: 32 });
    if (!equalBytes(owner, decodeHex0x(ownerNostr, { length: 32 }))) return 'owner_mismatch';
  } catch {
    return 'owner_mismatch';
  }
  const input = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(body as JsonValue)));
  let valid: boolean;
  try {
    valid = bip340Verify(owner, input, decodeHex(signed.sig, { length: 64 }));
  } catch {
    valid = false;
  }
  return valid ? undefined : 'signature_invalid';
}

/**
 * The object checks of 04 §2.5.1 for a `contact.check` being applied: encoding, `agent`, `owner`,
 * `sig`, freshness and lifetime. The nonce is checked by the caller's transaction.
 */
export function checkContactCheckObject(
  signed: unknown,
  context: ContactCheckContext,
): ContactCheckVerdict {
  const parsed = parseExact(signed);
  if (parsed === undefined) return refuse('malformed');
  const authority = checkAuthority(parsed, context.agent, context.ownerNostr);
  if (authority !== undefined) return refuse(authority);
  const { issuedAt, expiresAt } = parsed.body;
  if (issuedAt > context.now + CLOCK_SKEW_SECONDS) return refuse('issued_in_future');
  if (context.now > expiresAt) return refuse('expired');
  if (expiresAt - issuedAt > LIFETIME) return refuse('lifetime_exceeded');
  return {
    ok: true,
    signed: parsed,
    actionHash: encodeHex(sha256(canonicalizeToBytes(parsed as JsonValue))),
  };
}

/**
 * Verifies a `contact.check` before it is applied: the object checks, then its `pairingDigest`
 * against the digest `lookup` recomputes for its `contact` (04 §3.6.1). The lookup runs only for an
 * object that passed every other check.
 */
export async function verifyContactCheck(
  signed: unknown,
  context: ContactCheckContext,
  lookup: (contact: string) => Promise<PairingDigestLookup>,
): Promise<ContactCheckVerdict> {
  const verdict = checkContactCheckObject(signed, context);
  if (!verdict.ok) return verdict;
  const found = await lookup(verdict.signed.body.params.contact);
  if (found.status === 'unknown') return refuse('contact_unknown');
  if (found.status === 'unavailable') return refuse('pairing_unavailable');
  if (found.pairingDigest !== verdict.signed.body.params.pairingDigest) {
    return refuse('digest_mismatch');
  }
  return verdict;
}

/**
 * Re-verifies a stored `contacts.safety_check` on load (04 §2.5.1, §3.6.1): the exact encoding,
 * `agent`, `owner` and `sig` (freshness and the nonce applied once, when it was first applied), the
 * contact it names, and its `pairingDigest` against a fresh recomputation. Anything else is false.
 */
export function storedContactCheckHolds(
  stored: unknown,
  expected: {
    readonly agent: string;
    readonly ownerNostr: string;
    readonly contact: string;
    readonly pairingDigest: string;
  },
): boolean {
  const parsed = parseExact(stored);
  if (parsed === undefined) return false;
  if (checkAuthority(parsed, expected.agent, expected.ownerNostr) !== undefined) return false;
  return (
    parsed.body.params.contact === expected.contact &&
    parsed.body.params.pairingDigest === expected.pairingDigest
  );
}
