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

/** The owner's EIP-712 signature over the card (04 §2.4). */
export const cardSigSchema = eip712SigHex;

/**
 * A self-declared display name as it travels (04 §2.4: keccak256 of its UTF-8 is `nameHash`).
 * Untrusted content (I-5): bounded here, shown only through `restrictName` or inside the untrusted
 * block (06 §2.1, §4). Never displayed raw outside that block.
 */
export const displayNameSchema = ijsonString({ max: MAX_DISPLAY_NAME_CODE_POINTS });

// A relay URL: wss, lowercase DNS host name (letters, digits, dots, hyphens), optional port, optional
// path. No user info, query or fragment.
const RELAY_URL =
  /^wss:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::([0-9]{1,5}))?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/;

// Relay lists come from other parties (invites, handshakes, card updates) and the core connects to
// them, so a relay host must not point at the local machine or network (I-5; 04 §4 SSRF rules):
// - no IP literal at all. IPv6 literals cannot match RELAY_URL. A host whose last label is a number
//   (`127.0.0.1`, `0x7f.1`, `2130706433`, `169.254.169.254`) is parsed as IPv4 by URL parsers
//   (WHATWG "ends in a number"), so every such host is refused. That covers loopback, private,
//   link-local, CGNAT and metadata addresses in every spelling;
// - no single-label host (`localhost`, `metadata`, intranet names);
// - no special-use local names (`*.localhost`, `*.local`, `*.internal`, `*.home.arpa`).
// A DNS name can still resolve to a private address; the transport re-checks at connect time.
const NUMERIC_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/;
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** True when a relay host is a public-looking DNS name (see the rules above). */
export function isAllowedRelayHost(host: string): boolean {
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (NUMERIC_LABEL.test(labels[labels.length - 1] as string)) return false;
  return !LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export const relayUrlSchema = z
  .string()
  .max(MAX_RELAY_URL_LENGTH)
  .refine((s) => {
    const m = RELAY_URL.exec(s);
    if (m === null) return false;
    const [, host, port] = m;
    if (host === undefined || !isAllowedRelayHost(host)) return false;
    return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
  }, 'must be a wss:// URL with a public lowercase DNS host and no user info, query or fragment');

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
