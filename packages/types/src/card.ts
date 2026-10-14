// AgentCard (04 §2.4), the off-chain fields that travel with it (name, relays), and the Invite (04 §3.6).
//
// The card is an EIP-712 struct. Its JSON form is the EIP-712 message form: addresses and bytes32 as
// `0x` + lowercase hex, integers as JSON integers. The card is also hashed (pairing proof:
// sha256(JCS(card)), 04 §3.6), so the form is canonical and checked exactly.
import { z } from 'zod';
import {
  BYTE_LENGTHS,
  MAX_DISPLAY_NAME_CODE_POINTS,
  MAX_RELAY_URL_LENGTH,
  MAX_RELAYS,
  PROTOCOL_VERSION,
} from './constants.js';
import {
  base64url,
  eip712SigHex,
  evmAddress,
  hex0xBytes,
  ijsonString,
  uint32,
  uint53,
} from './encoding.js';

const bytes32 = hex0xBytes(32);

export const agentCardSchema = z
  .strictObject({
    version: z.literal(1),
    agentEvm: evmAddress,
    agentNostr: bytes32,
    agentEnc: bytes32,
    ownerEvm: evmAddress,
    ownerNostr: bytes32,
    ownerEnc: bytes32,
    nameHash: bytes32,
    relaysHash: bytes32,
    issuedAt: uint53,
    expiresAt: uint53,
    keyEpoch: uint32,
  })
  .refine((c) => c.expiresAt === 0 || c.expiresAt > c.issuedAt, {
    message: 'expiresAt must be 0 (no expiry) or after issuedAt',
    path: ['expiresAt'],
  });

/** The owner's EIP-712 signature over the card (04 §2.4). */
export const cardSigSchema = eip712SigHex;

/**
 * A self-declared display name as it travels (04 §2.4: keccak256 of its UTF-8 is `nameHash`).
 * Untrusted content (I-5): bounded here, shown only through `restrictName` or inside the untrusted
 * block (06 §2.1, §4). Never displayed raw outside that block.
 */
export const displayNameSchema = ijsonString({ max: MAX_DISPLAY_NAME_CODE_POINTS });

// A relay URL: wss, lowercase host name (letters, digits, dots, hyphens), optional port, optional path.
// No user info, query or fragment. Connecting to it is still subject to the transport's own checks.
const RELAY_URL =
  /^wss:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::([0-9]{1,5}))?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/;

export const relayUrlSchema = z
  .string()
  .max(MAX_RELAY_URL_LENGTH)
  .refine((s) => {
    const m = RELAY_URL.exec(s);
    if (m === null) return false;
    const port = m[1];
    return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
  }, 'must be a wss:// URL with a lowercase host and no user info, query or fragment');

export const relayListSchema = z
  .array(relayUrlSchema)
  .min(1)
  .max(MAX_RELAYS)
  .refine((list) => new Set(list).size === list.length, 'relay URLs must be unique');

export const inviteSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  inviteId: base64url(BYTE_LENGTHS.inviteId),
  secret: base64url(BYTE_LENGTHS.secret),
  card: agentCardSchema,
  cardSig: cardSigSchema,
  name: displayNameSchema,
  relays: relayListSchema,
  expiresAt: uint53,
});

export type AgentCard = z.infer<typeof agentCardSchema>;
export type Invite = z.infer<typeof inviteSchema>;
