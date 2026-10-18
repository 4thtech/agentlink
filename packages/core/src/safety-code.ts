// The safety code recomputed from the two signed pairing messages (04 §3.6.1 steps 1-5, G-28).
//
// Every surface computes the code from the pairing's `handshake` H and `handshake-ack` K, as signed
// envelopes, each time it shows the code: never from a stored code, digest or column. The core's
// completion check (the pairing binding, IR-M1-7a-1 R2-L1) runs the same steps, so the stored pair
// that completes a pairing is always one that yields a code.
//
// Steps (any failure: "Can't show the safety code", CoreError `safety_code_unavailable`, fixed text):
//  1. H's envelope signature is valid and its `from` is H.card.agentNostr; H.card passes cardSig and
//     cardAgentSig.
//  2. K's envelope signature is valid and its `from` is K.card.agentNostr; K.card passes cardSig;
//     sha256(JCS(K.card)) = H.inviterCardHash; K.handshakeHash = envelopeHash(H) (and K.handshakeId
//     = H.id); K.inviteId = H.inviteId.
//  3. K.codeReveal opens H.codeCommit.
//  4. One card is the surface's own agent; the other card's agentEvm and owner keys equal the
//     contact's current card.
//  5. T = sha256(JCS(K.card)) ‖ sha256(JCS(H.card)) ‖ inviteId ‖ codeReveal ‖ H.codeNonce.
// Each body must also pass its strict schema (04 §3.4.1, G-24).
//
// This module imports only @4thtech-io/crypto, @4thtech-io/types and the core's errors, so the vector
// harness runs it from source in every runtime (test-vectors/harness/suites/safety-code-recompute.ts).
import {
  agentCardJcsHash,
  checkSafetyCodeReveal,
  computeSafetyCode,
  decodeBase64url,
  decodeUtf8,
  decryptPayload,
  encodeHex,
  encodeHex0x,
  envelopeHash,
  parseAgentCard,
  parseEnvelope,
  parseJson,
  verifyCardAgentSig,
  verifyCardOwnerSig,
  verifyEnvelope,
  wipe,
  type AgentCard,
  type Envelope,
} from '@4thtech-io/crypto';
import {
  envelopeSchema,
  payloadSchema,
  type HandshakeAckBody,
  type HandshakeBody,
  type Payload,
} from '@4thtech-io/types';
import { CoreError } from './errors.js';

/** A pairing message as signed and opened: the strict envelope and its strict payload. */
export interface OpenedPairingMessage {
  readonly envelope: Envelope;
  readonly payload: Payload;
}

/** A verified pair (H, K) and the code it yields. `code` is shown only on owner surfaces. */
export interface PairingTranscript {
  /** The side `self` played: `inviter` (A, made the invite) or `invitee` (B). */
  readonly role: 'inviter' | 'invitee';
  readonly inviterCard: AgentCard;
  readonly inviteeCard: AgentCard;
  /** The counterparty's card in this pairing. */
  readonly peerCard: AgentCard;
  readonly handshake: {
    readonly envelope: Envelope;
    readonly hash: string;
    readonly body: HandshakeBody;
  };
  readonly ack: {
    readonly envelope: Envelope;
    readonly hash: string;
    readonly body: HandshakeAckBody;
  };
  /** pairingDigest, 64 lowercase hex: what `contact.check` signs (04 §2.5.1, M1-7c-b). */
  readonly pairingDigest: string;
  /** "dddd dddd dddd". Never in a tool result, a log line or an error (04 §3.6.1, 06 §2.1). */
  readonly code: string;
}

const unavailable = (): CoreError =>
  new CoreError('safety_code_unavailable', "Can't show the safety code for this pairing.");

const sameOwner = (a: AgentCard, b: AgentCard): boolean =>
  a.ownerEvm === b.ownerEvm && a.ownerNostr === b.ownerNostr && a.ownerEnc === b.ownerEnc;

/**
 * Opens a pairing message with its CEK (the strict envelope, the key commitment and the AEAD, then
 * the strict payload). The signature is checked by verifyPairingTranscript. Wipes nothing it does
 * not own: the caller wipes the CEK.
 */
export async function openPairingMessage(
  envelope: unknown,
  cek: Uint8Array,
): Promise<OpenedPairingMessage> {
  let parsed: Envelope;
  let plaintext: Uint8Array | undefined;
  try {
    parsed = parseEnvelope(envelope);
    if (!envelopeSchema.safeParse(parsed).success) throw unavailable();
    plaintext = await decryptPayload(parsed, cek);
    const payload = payloadSchema.safeParse(parseJson(decodeUtf8(plaintext)));
    if (!payload.success) throw unavailable();
    return { envelope: parsed, payload: payload.data };
  } catch {
    throw unavailable();
  } finally {
    if (plaintext !== undefined) wipe(plaintext);
  }
}

/** Steps 1-5 over opened H and K, for the agent `self` (its agentId) and the contact's card. */
export function verifyPairingTranscript(input: {
  readonly self: string;
  readonly contactCard: unknown;
  readonly handshake: OpenedPairingMessage;
  readonly ack: OpenedPairingMessage;
}): PairingTranscript {
  const h = input.handshake;
  const k = input.ack;
  if (h.payload.type !== 'handshake' || k.payload.type !== 'handshake-ack') throw unavailable();
  const hb = h.payload.body;
  const kb = k.payload.body;
  try {
    // Step 1.
    if (!verifyEnvelope(h.envelope)) throw unavailable();
    const hCard = parseAgentCard(hb.card);
    if (h.envelope.from !== hCard.agentNostr.slice(2)) throw unavailable();
    if (!verifyCardOwnerSig(hCard, hb.cardSig) || !verifyCardAgentSig(hCard, hb.cardAgentSig)) {
      throw unavailable();
    }
    // Step 2.
    if (!verifyEnvelope(k.envelope)) throw unavailable();
    const kCard = parseAgentCard(kb.card);
    if (k.envelope.from !== kCard.agentNostr.slice(2)) throw unavailable();
    if (!verifyCardOwnerSig(kCard, kb.cardSig)) throw unavailable();
    if (encodeHex(agentCardJcsHash(kCard)) !== hb.inviterCardHash) throw unavailable();
    const hHash = encodeHex0x(envelopeHash(h.envelope));
    if (kb.handshakeHash !== hHash || kb.handshakeId !== h.envelope.id) throw unavailable();
    if (kb.inviteId !== hb.inviteId) throw unavailable();
    // Step 3.
    const inviteId = decodeBase64url(hb.inviteId, { length: 16 });
    const nonceA = decodeBase64url(kb.codeReveal, { length: 32 });
    const codeCommit = decodeBase64url(hb.codeCommit, { length: 32 });
    if (!checkSafetyCodeReveal(inviteId, nonceA, codeCommit)) throw unavailable();
    // Step 4.
    let role: 'inviter' | 'invitee';
    if (kCard.agentEvm === input.self && hCard.agentEvm !== input.self) role = 'inviter';
    else if (hCard.agentEvm === input.self && kCard.agentEvm !== input.self) role = 'invitee';
    else throw unavailable();
    const peerCard = role === 'inviter' ? hCard : kCard;
    const contact = parseAgentCard(input.contactCard);
    if (contact.agentEvm !== peerCard.agentEvm || !sameOwner(contact, peerCard)) {
      throw unavailable();
    }
    // Step 5.
    const result = computeSafetyCode({
      inviterCard: kCard,
      inviteeCard: hCard,
      inviteId,
      nonceA,
      nonceB: decodeBase64url(hb.codeNonce, { length: 32 }),
      codeCommit,
    });
    return {
      role,
      inviterCard: kCard,
      inviteeCard: hCard,
      peerCard,
      handshake: { envelope: h.envelope, hash: hHash, body: hb },
      ack: { envelope: k.envelope, hash: encodeHex0x(envelopeHash(k.envelope)), body: kb },
      pairingDigest: encodeHex(result.pairingDigest),
      code: result.code,
    };
  } catch {
    throw unavailable();
  }
}

/**
 * Steps 1-5 from the signed H and K and their CEKs (the surface opens each with its own key; the
 * vectors pass the CEK). Returns the digest and the code, or throws `safety_code_unavailable`.
 */
export async function recomputeSafetyCode(input: {
  readonly self: string;
  readonly contactCard: unknown;
  readonly handshake: { readonly envelope: unknown; readonly cek: Uint8Array };
  readonly ack: { readonly envelope: unknown; readonly cek: Uint8Array };
}): Promise<{ readonly pairingDigest: string; readonly code: string }> {
  const handshake = await openPairingMessage(input.handshake.envelope, input.handshake.cek);
  const ack = await openPairingMessage(input.ack.envelope, input.ack.cek);
  const t = verifyPairingTranscript({
    self: input.self,
    contactCard: input.contactCard,
    handshake,
    ack,
  });
  return { pairingDigest: t.pairingDigest, code: t.code };
}
