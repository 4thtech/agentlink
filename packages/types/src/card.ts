// AgentCard (04 §2.4), the off-chain fields that travel with it (name, relays), and the Invite (04 §3.6).
//
// The card is an EIP-712 struct. Its JSON form is the EIP-712 message form: addresses and bytes32 as
// `0x` + lowercase hex, integers as JSON integers. The card is also hashed (pairing proof:
// sha256(JCS(card)), 04 §3.6), so the form is canonical and checked exactly.
import { z } from 'zod';
import {
  BYTE_LENGTHS,
  MAX_DISPLAY_NAME_CODE_POINTS,
  MAX_RELAYS,
  PROTOCOL_VERSION,
} from './constants.js';
import {
  base64url,
  ecdsaSignatureSchema,
  evmAddress,
  bytes32Hex,
  ijsonString,
  uint32,
  uint53,
} from './encoding.js';

const bytes32 = bytes32Hex;

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

/** The owner's EIP-712 signature over the card, canonical ECDSA (04 §2.4, §2.4.1). */
export const cardSigSchema = ecdsaSignatureSchema;

/**
 * A self-declared display name as it travels (04 §2.4: keccak256 of its UTF-8 is `nameHash`).
 * Untrusted content (I-5): bounded here, shown only through `restrictName` or inside the untrusted
 * block (06 §2.1, §4). Never displayed raw outside that block.
 */
export const displayNameSchema = ijsonString({ max: MAX_DISPLAY_NAME_CODE_POINTS });

// Relay URL rule (04 §4, "SSRF protection (relay URLs)"), checked on the RAW string before any URL
// parser runs: a WHATWG or UTS-46 parser would map percent-encoding, full-width characters or U+3002
// onto `localhost`, IP literals or trailing dots. Relay lists come from other parties (invites,
// handshakes, card updates) and the core connects to them, so this is an SSRF boundary (I-5).
// The transport re-checks every resolved address at connect time (M1-5, 07 §4.2).

/** Printable ASCII only, no `%`, `\` or whitespace, at most 256 characters. */
const RELAY_CHARS = /^[\x21-\x24\x26-\x5b\x5d-\x7e]{1,256}$/;
/** wss:// host [:port] [path]; no user info, query or fragment. */
const RELAY_FORM =
  /^wss:\/\/([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?(\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*)?$/;
const RELAY_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A label that parses as a number in any base: decimal (octal is a subset) or 0x hex. */
const NUMERIC_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/;
const LAST_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/**
 * Special-use and local names (04 §4; RFC 6761, RFC 6762, RFC 8375, RFC 7686, RFC 2606): the name
 * itself and everything under it are refused. `.example`, `.test` and `.invalid` never resolve
 * publicly; `.onion` is not reachable over plain DNS.
 */
export const DENIED_RELAY_NAMES = Object.freeze([
  'localhost',
  'localdomain',
  'local',
  'internal',
  'home.arpa',
  'invalid',
  'test',
  'example',
  'onion',
] as const);

/** True when `host` passes the host part of the relay URL rule (lowercase DNS name, never local). */
export function isAllowedRelayHost(host: string): boolean {
  if (host.length > 253 || host === 'localhost') return false;
  const labels = host.split('.');
  if (labels.length < 2) return false; // also: no trailing dot (an empty last label fails below)
  for (const label of labels) {
    if (!RELAY_LABEL.test(label) || NUMERIC_LABEL.test(label)) return false;
  }
  if (!LAST_LABEL.test(labels[labels.length - 1] as string)) return false;
  return !DENIED_RELAY_NAMES.some((name) => host === name || host.endsWith(`.${name}`));
}

/** True when `url` passes the relay URL rule of 04 §4 (raw-string check, before any URL parsing). */
export function isAllowedRelayUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !RELAY_CHARS.test(url)) return false;
  const m = RELAY_FORM.exec(url);
  if (m === null) return false;
  const [, host, port] = m;
  if (host === undefined || !isAllowedRelayHost(host)) return false;
  return port === undefined || Number(port) <= 65535;
}

export const relayUrlSchema = z
  .string()
  .refine(isAllowedRelayUrl, 'must be a wss:// relay URL that passes the relay URL rule (04 §4)');

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
