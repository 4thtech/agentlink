// 04 §3.6.1 safety code (G-28), commit then reveal:
//   codeCommit = taggedHash("agentlink/safety-commit/v1", inviteId ‖ nonceA)
//   T          = sha256(JCS(cardA)) ‖ sha256(JCS(cardB)) ‖ inviteId ‖ nonceA ‖ nonceB   (144 bytes)
//   digest     = taggedHash("agentlink/safety-code/v1", T)                                (pairingDigest)
//   code       = u64be(digest[0..8]) mod 10^12, shown as "dddd dddd dddd"
// cardA is the inviter's (the invite card), cardB the invitee's (the handshake card); order is by
// role, never sorted. Every value is public once pairing completes. The recomputation from the
// signed handshake H and ack K (steps 1–5) needs the envelope helpers of M1-1c and is not here.
import { agentCardJcsHash } from './agent-card.js';
import { assertBytes, concatBytes, equalBytes } from './bytes.js';
import { CryptoInputError } from './errors.js';
import { TAGS, taggedHash } from './hash.js';
import { INVITE_ID_LENGTH } from './pairing.js';

export const SAFETY_NONCE_LENGTH = 32;
export const SAFETY_TRANSCRIPT_LENGTH = 144;
/** The code has 12 decimal digits: the 64-bit integer is reduced mod 10^12. */
export const SAFETY_CODE_MODULUS = 10n ** 12n;

function assertLength(value: Uint8Array, length: number, what: string): void {
  assertBytes(value, what);
  if (value.length !== length) {
    throw new CryptoInputError('invalid_length', `${what} must be ${String(length)} bytes`);
  }
}

/** codeCommit, carried by the invite (32 bytes). */
export function safetyCodeCommit(inviteId: Uint8Array, nonceA: Uint8Array): Uint8Array {
  assertLength(inviteId, INVITE_ID_LENGTH, 'safetyCodeCommit: inviteId');
  assertLength(nonceA, SAFETY_NONCE_LENGTH, 'safetyCodeCommit: nonceA');
  return taggedHash(TAGS.safetyCommit, concatBytes(inviteId, nonceA));
}

/**
 * True when `codeReveal` (from the handshake-ack) opens `codeCommit` for `inviteId`, compared in
 * constant time. A false result means: drop the ack, keep the pairing pending, show no code.
 */
export function checkSafetyCodeReveal(
  inviteId: Uint8Array,
  codeReveal: Uint8Array,
  codeCommit: Uint8Array,
): boolean {
  assertLength(codeCommit, 32, 'checkSafetyCodeReveal: codeCommit');
  return equalBytes(safetyCodeCommit(inviteId, codeReveal), codeCommit);
}

export interface SafetyCodeInput {
  /** The card in the invite (role: inviter), card JSON form. */
  readonly inviterCard: unknown;
  /** The card in the handshake (role: invitee), card JSON form. */
  readonly inviteeCard: unknown;
  readonly inviteId: Uint8Array;
  readonly nonceA: Uint8Array;
  readonly nonceB: Uint8Array;
}

export interface SafetyCode {
  readonly transcript: Uint8Array;
  readonly pairingDigest: Uint8Array;
  /** u64be(pairingDigest[0..8]) before the reduction. */
  readonly integer: bigint;
  /** "dddd dddd dddd", leading zeros kept. */
  readonly code: string;
}

/** T, 144 bytes; each card is parsed strictly and hashed as sha256(JCS(card)). */
export function safetyCodeTranscript(input: SafetyCodeInput): Uint8Array {
  if (typeof input !== 'object' || input === null) {
    throw new CryptoInputError('invalid_argument', 'safetyCodeTranscript: input must be an object');
  }
  assertLength(input.inviteId, INVITE_ID_LENGTH, 'safetyCodeTranscript: inviteId');
  assertLength(input.nonceA, SAFETY_NONCE_LENGTH, 'safetyCodeTranscript: nonceA');
  assertLength(input.nonceB, SAFETY_NONCE_LENGTH, 'safetyCodeTranscript: nonceB');
  return concatBytes(
    agentCardJcsHash(input.inviterCard),
    agentCardJcsHash(input.inviteeCard),
    input.inviteId,
    input.nonceA,
    input.nonceB,
  );
}

/** pairingDigest = taggedHash("agentlink/safety-code/v1", T). */
export function pairingDigest(transcript: Uint8Array): Uint8Array {
  assertLength(transcript, SAFETY_TRANSCRIPT_LENGTH, 'pairingDigest: transcript');
  return taggedHash(TAGS.safetyCode, transcript);
}

/** The 12-digit code from a 32-byte digest: u64be of its first 8 bytes, mod 10^12, grouped. */
export function safetyCodeFromDigest(digest: Uint8Array): { integer: bigint; code: string } {
  assertLength(digest, 32, 'safetyCodeFromDigest: digest');
  const integer = new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0, false);
  const digits = (integer % SAFETY_CODE_MODULUS).toString().padStart(12, '0');
  return { integer, code: `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)}` };
}

/** T, pairingDigest and the code for one pairing. */
export function computeSafetyCode(input: SafetyCodeInput): SafetyCode {
  const transcript = safetyCodeTranscript(input);
  const digest = pairingDigest(transcript);
  return Object.freeze({ transcript, pairingDigest: digest, ...safetyCodeFromDigest(digest) });
}

/**
 * The code from one side's point of view: each side knows its role from whether it created the
 * invite, and the inviter's card always comes first. Both sides of one pairing get the same code.
 */
export function safetyCodeForRole(input: {
  readonly role: 'inviter' | 'invitee';
  readonly ownCard: unknown;
  readonly peerCard: unknown;
  readonly inviteId: Uint8Array;
  readonly nonceA: Uint8Array;
  readonly nonceB: Uint8Array;
}): SafetyCode {
  if (typeof input !== 'object' || input === null) {
    throw new CryptoInputError('invalid_argument', 'safetyCodeForRole: input must be an object');
  }
  if (input.role !== 'inviter' && input.role !== 'invitee') {
    throw new CryptoInputError(
      'invalid_argument',
      'safetyCodeForRole: role must be inviter or invitee',
    );
  }
  const inviter = input.role === 'inviter';
  return computeSafetyCode({
    inviterCard: inviter ? input.ownCard : input.peerCard,
    inviteeCard: inviter ? input.peerCard : input.ownCard,
    inviteId: input.inviteId,
    nonceA: input.nonceA,
    nonceB: input.nonceB,
  });
}
