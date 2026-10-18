// Protocol constants. Each value cites the spec section it comes from; constants.test.ts pins them.
// Arrays and maps are frozen so no caller can widen them at run time.

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

export const packageName = '@agentlink/types';

/** Envelope, payload-body and owner-action format version (04 §2.5.1, §3.1, §3.6). */
export const PROTOCOL_VERSION = 1;

// --- Payload types (04 §3.4) ---------------------------------------------------------------------

/** The 17 payload types, in the order of 04 §3.4. */
export const PAYLOAD_TYPES = freeze([
  'text',
  'request',
  'offer',
  'accept',
  'reject',
  'delivery',
  'note',
  'file',
  'ack',
  'handshake',
  'handshake-ack',
  'proof',
  'approval',
  'approval-request',
  'policy',
  'card-update',
  'revoke',
] as const);
export type PayloadType = (typeof PAYLOAD_TYPES)[number];

/** Types `agentlink_send` accepts (06 §2.2). */
export const SEND_TOOL_PAYLOAD_TYPES = freeze([
  'text',
  'note',
  'request',
  'delivery',
] as const satisfies readonly PayloadType[]);

/** Types produced only through the terms tools (06 §2.2a, D-55); they carry `terms` (04 §3.4). */
export const TERMS_PAYLOAD_TYPES = freeze([
  'offer',
  'accept',
  'reject',
] as const satisfies readonly PayloadType[]);

/**
 * Every type a tool call can cause (02 F-22): send plus the terms tools. The core refuses every other
 * type from tool input (04 §3.4.1).
 */
export const SENDABLE_PAYLOAD_TYPES = freeze([
  ...SEND_TOOL_PAYLOAD_TYPES,
  ...TERMS_PAYLOAD_TYPES,
] as const);

/** Types that travel only between an agent and its own owner (04 §3.4.1). */
export const OWNER_CHANNEL_PAYLOAD_TYPES = freeze([
  'approval-request',
  'approval',
  'policy',
] as const satisfies readonly PayloadType[]);

/** Types no MCP tool can create or pass through (04 §3.4.1, "Who may create these bodies"). */
export const CORE_ONLY_PAYLOAD_TYPES = freeze([
  'approval-request',
  'approval',
  'policy',
  'revoke',
  'card-update',
  'handshake',
  'handshake-ack',
] as const satisfies readonly PayloadType[]);

/** Types whose payload may carry `files` (user message types); every other type must have `files: []`. */
export const FILE_PAYLOAD_TYPES = freeze([
  ...SENDABLE_PAYLOAD_TYPES,
  'file',
] as const satisfies readonly PayloadType[]);

// --- On-chain enums (05 §2.1, §3.1) --------------------------------------------------------------

/** `Record.kind` (05 §3.1). */
export const RECORD_KINDS = freeze({
  MESSAGE: 1,
  FILE: 2,
  OFFER: 3,
  ACCEPT: 4,
  DELIVERY: 5,
  NOTE: 6,
} as const);
export type RecordKind = (typeof RECORD_KINDS)[keyof typeof RECORD_KINDS];

/** `Receipt.receiptType` (05 §3.1). */
export const RECEIPT_TYPES = freeze({ DELIVERED: 1, OPENED: 2, ACCEPTED: 3, REJECTED: 4 } as const);
export type ReceiptType = (typeof RECEIPT_TYPES)[keyof typeof RECEIPT_TYPES];

/** `enum FeeType { NOTARIZE, REGISTER, ANCHOR, DEAL, DISCLOSE }` as Solidity ordinals (05 §2.1). */
export const FEE_TYPES = freeze({
  NOTARIZE: 0,
  REGISTER: 1,
  ANCHOR: 2,
  DEAL: 3,
  DISCLOSE: 4,
} as const);
export type FeeType = (typeof FEE_TYPES)[keyof typeof FEE_TYPES];

// --- MCP surface (06 §1, §2.0, §2.5) -------------------------------------------------------------

/** Every tool result's `status` (06 §1 rule 3). */
export const MCP_STATUSES = freeze([
  'ok',
  'submitted',
  'pending_approval',
  'needs_setup',
  'needs_credits',
  'not_found',
  'rejected',
  'error',
] as const);
export type McpStatus = (typeof MCP_STATUSES)[number];

/** `agentlink_get_approval` status (06 §2.5). */
export const APPROVAL_STATUSES = freeze(['pending', 'approved', 'denied', 'expired'] as const);
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** The 15 tool names frozen at 0.1.0 (06 §2.0: 13 from D-53, two terms tools from D-55). */
export const MCP_TOOL_NAMES = freeze([
  'agentlink_status',
  'agentlink_create_invite',
  'agentlink_accept_invite',
  'agentlink_list_contacts',
  'agentlink_send',
  'agentlink_propose_terms',
  'agentlink_respond_to_terms',
  'agentlink_inbox',
  'agentlink_get_approval',
  'agentlink_fetch_file',
  'agentlink_notarize',
  'agentlink_acknowledge',
  'agentlink_get_proof',
  'agentlink_export_proof_pack',
  'agentlink_verify_proof_pack',
] as const);
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Tools with an entry in the "Approval" column of 06 §2.0: the only valid `approval-request` tools. */
export const APPROVAL_TOOL_NAMES = freeze([
  'agentlink_accept_invite',
  'agentlink_send',
  'agentlink_propose_terms',
  'agentlink_respond_to_terms',
  'agentlink_notarize',
  'agentlink_acknowledge',
  'agentlink_export_proof_pack',
] as const satisfies readonly McpToolName[]);
export type ApprovalToolName = (typeof APPROVAL_TOOL_NAMES)[number];

// --- Owner actions (04 §2.5.1, §3.4.1) -----------------------------------------------------------

/**
 * Ops defined in 04 §2.5.1 (`approval.cancel` from D-55, `approval.decideBatch` from D-68,
 * `contact.rename` and `contact.remove` from M1-9za). Other ops land with the tasks that build them.
 */
export const OWNER_ACTION_OPS = freeze([
  'approval.decide',
  'approval.decideBatch',
  'approval.cancel',
  'policy.set',
  'contact.check',
  'contact.rename',
  'contact.remove',
  'agent.revoke',
] as const);
export type OwnerActionOp = (typeof OWNER_ACTION_OPS)[number];

export const APPROVAL_DECISIONS = freeze(['approve', 'deny'] as const);

/**
 * `approval.decideBatch` item count (04 §2.5.1, §2.5.2; D-68): at least 2, because one decision is
 * always an `approval.decide`; at most 20 (proposed), which bounds one review and one signature.
 */
export const APPROVAL_BATCH_MIN_ITEMS = 2;
export const APPROVAL_BATCH_MAX_ITEMS = 20;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** `agent.revoke` reasons: fixed values, never free text (04 §2.5.1). */
export const REVOKE_REASONS = freeze(['compromised', 'retired', 'other'] as const);
export type RevokeReason = (typeof REVOKE_REASONS)[number];

// --- Lifetimes, clock skew, nonces and the budget window (G-7) ----------------------------------
//
// All times are unix seconds. The schemas check only the static shape (`issuedAt < expiresAt`, the
// approval-request TTL); every check against "now" is the core's (M1-7d, M1-7i), pure, with `now`
// passed in.

/** Clock skew `S`: the core refuses `issuedAt > now + S`. Expiry has no skew (04 §2.5.1). */
export const CLOCK_SKEW_SECONDS = 300;

/**
 * Maximum lifetime `L(op)` = the largest allowed `expiresAt − issuedAt` (04 §2.5.1 table). `null`:
 * the op never expires (`agent.revoke`, `expiresAt` = 0). `contact.check` (G-28): 24 h, as for
 * `policy.set`; its schema is M1-2f.
 */
export const OWNER_ACTION_MAX_LIFETIME_SECONDS = freeze({
  'approval.decide': 86_400,
  'approval.decideBatch': 86_400,
  'approval.cancel': 604_800,
  'policy.set': 86_400,
  'contact.check': 86_400,
  // M1-9za: applied on the agent's own machine within seconds; the default for later ops.
  'contact.rename': 600,
  'contact.remove': 600,
  'agent.revoke': null,
} as const);

/**
 * The CLI and the local UI set a batch's `expiresAt` at most `issuedAt + 600` (04 §2.5.2 "Expiry";
 * proposed). A signing-surface rule: the core accepts up to `L(op)`, because the console may use it.
 */
export const APPROVAL_BATCH_LOCAL_MAX_LIFETIME_SECONDS = 600;

/** `L(op)` of any later op (storage credentials, key export, disclosure) unless its task sets one. */
export const LATER_OP_DEFAULT_LIFETIME_SECONDS = 600;
/** No op may exceed 7 days (04 §2.5.1). */
export const MAX_OWNER_ACTION_LIFETIME_SECONDS = 604_800;

/** Approval TTL: `approval-request.expiresAt = requestedAt + 86 400` (04 §3.4.1). */
export const APPROVAL_TTL_SECONDS = 86_400;

/** Applied owner-action nonces are kept at least 30 days, above the longest `L(op)` + `S` (04 §2.5.1). */
export const NONCE_RETENTION_SECONDS = 30 * 86_400;

/** `proofs.dailyBudgetUSD` covers any rolling 24 hours, never a calendar day (06 §3). */
export const BUDGET_WINDOW_SECONDS = 86_400;

/** A commitment scope lasts at most 7 days: `min(terms.validUntil, createdAt + 7 days)` (04 §3.4.2). */
export const COMMITMENT_SCOPE_MAX_LIFETIME_SECONDS = 604_800;

/** `approvalId` = `apr_` + 16 random bytes, base64url (04 §3.4.1). */
export const APPROVAL_ID_PREFIX = 'apr_';

/** `approval-request.summary` limit in characters (Unicode code points) (04 §3.4.1). */
export const APPROVAL_SUMMARY_MAX_CHARS = 200;

// --- Byte lengths (04 §2.5.1, §3.1, §3.3, §3.6) --------------------------------------------------

export const BYTE_LENGTHS = freeze({
  /** Envelope `id` (§3.1). */
  id: 16,
  /** Envelope `thread` (§3.1). */
  thread: 16,
  /** Recipient `kid`: first 16 bytes of sha256(encPub) (§3.1). */
  kid: 16,
  /** OwnerAction `nonce` (§2.5.1). */
  nonce: 16,
  /** Invite `inviteId` (§3.6). */
  inviteId: 16,
  /** Random part of `approvalId` (§3.4.1). */
  approvalId: 16,
  /** `terms.termsId` (§3.4). */
  termsId: 16,
  /** Symmetric keys: CEK and `fileKey` (§3.3, §3.4). */
  key: 32,
  /** Invite `secret` (§3.6). */
  secret: 32,
  /** Handshake `proof` = HMAC-SHA256 (§3.6). */
  hmac: 32,
  /** Safety-code `codeCommit`, `codeNonce` (`nonceB`) and `codeReveal` (`nonceA`) (§3.6.1). */
  safetyCode: 32,
  sha256: 32,
  /** HPKE `enc` for DHKEM(X25519, HKDF-SHA256) (§3.3). */
  hpkeEnc: 32,
  /** HPKE ciphertext of the 32-byte CEK under AES-256-GCM: 32 + 16-byte tag (§3.3). */
  wrappedCek: 48,
  /** AES-GCM IV (§3.1). */
  iv: 12,
  /** AES-GCM tag (§3.1). */
  tag: 16,
  /** Payload key commitment `aead.kc`, derived from the CEK (§3.1, §3.3; G-46, D-66). */
  keyCommitment: 32,
  /** BIP-340 Schnorr signature (§2.5.1, §3.1). */
  bip340Sig: 64,
  /** EIP-712 ECDSA signature r ‖ s ‖ v (§2.4). */
  eip712Sig: 65,
} as const);

// --- Size limits (04 §3.5, §4; 06 §3) ------------------------------------------------------------

/** Serialized envelope limit: 24 KB (04 §3.5; policy `envelopes.maxEnvelopeKB`, 06 §3). KB = 1024 bytes. */
export const MAX_ENVELOPE_BYTES = 24 * 1024;
/** ALF1 header: magic (4) + version (1) + chunkSize (4) + noncePrefix (8) (04 §4). */
export const ALF1_HEADER_BYTES = 4 + 1 + 4 + 8;
/** AES-GCM tag, one per ALF1 chunk (04 §4). */
export const AEAD_TAG_BYTES = 16;
/**
 * Inline ciphertext cap (04 §3.1.1, §3.4): the `inline` field is at most 16 384 base64url characters,
 * 12 288 bytes of ALF1 ciphertext (it has `fileKey` and `ciphertextSha256` like any other file).
 */
export const MAX_INLINE_CIPHERTEXT_BYTES = 12 * 1024;
/**
 * The largest file that travels inline (04 §3.4; 07 §5.3), as plaintext size: one ALF1 chunk
 * (default chunk 1 MiB), so the cap above less the header and one tag, 12 255 bytes.
 */
export const MAX_INLINE_FILE_BYTES =
  MAX_INLINE_CIPHERTEXT_BYTES - ALF1_HEADER_BYTES - AEAD_TAG_BYTES;

/** Recipient set: at least an agent and an owner (I-9, §3.4.1 owner channel); at most 5 (04 §3.2). */
export const MIN_RECIPIENTS = 2;
export const MAX_RECIPIENTS = 5;

/** Invite default expiry (04 §3.6, 06 §2.1). */
export const INVITE_DEFAULT_EXPIRY_DAYS = 7;
/** File download links: default and maximum expiry (04 §4, 06 §3 `files.defaultExpiryDays`). */
export const FILE_LINK_MAX_EXPIRY_DAYS = 7;

// Bounds this package adds where the spec gives none. Each is generous for real use and exists so
// that untrusted input is bounded before any other code touches it (I-5).

/** Files per payload. `agentlink_send` attaches one; the envelope size cap bounds the rest. */
export const MAX_FILES_PER_PAYLOAD = 16;
/**
 * Relays in a list carried with a card (invite, `handshake`, `handshake-ack`, `card-update`): 2 to 16
 * (04 §3.4; the minimum of 2 is G-24, D-65).
 */
export const MIN_RELAYS = 2;
export const MAX_RELAYS = 16;
export const MAX_RELAY_URL_LENGTH = 256;
/** Raw, self-declared display name before `restrictName` (06 §2.1). Untrusted; never shown raw. */
export const MAX_DISPLAY_NAME_CODE_POINTS = 256;
export const MAX_FILE_NAME_CODE_POINTS = 255;
export const MAX_MIME_LENGTH = 255;
export const MAX_URL_LENGTH = 2048;
/** `note` on offer / accept / reject: `null` or 1 to 500 code points (04 §3.4, D-74). */
export const MAX_TERMS_NOTE_CODE_POINTS = 500;
/**
 * `terms` size limits (04 §3.4 "Size limits", D-74). One set serves both `terms` and `TermsInput`
 * (D-55). Lengths are Unicode code points, except the ASCII deliverable id (`^[A-Za-z0-9_-]{1,16}$`)
 * and the amount's digits. The largest body these allow is 12 083 bytes as JCS.
 */
export const TERMS_LIMITS = freeze({
  subjectCodePoints: 200,
  deliverables: 10,
  deliverableIdLength: 16,
  descriptionCodePoints: 160,
  deadlines: 10,
  amountIntegerDigits: 18,
  amountFractionDigits: 6,
  noteCodePoints: MAX_TERMS_NOTE_CODE_POINTS,
} as const);
/**
 * Token symbols allowed as `price.currency` besides the grammar `^[A-Z]{3}$` (04 §3.4 "Currency",
 * D-74): exactly the D-46 / 12 §3.1 fee tokens. Adding one is a spec change.
 */
export const TERMS_TOKEN_SYMBOLS = freeze(['USDC', 'USDT', 'XDAI'] as const);
/** `TermsInput.validUntil` default: 7 days from now (06 §2.2a). */
export const TERMS_DEFAULT_VALIDITY_SECONDS = 7 * 24 * 60 * 60;
/** Free-form JSON (message bodies, placeholders): nesting depth and total node count. */
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 4096;

// --- Policy defaults reference (06 §3) -----------------------------------------------------------

/**
 * The policy defaults are defined in 06 §3; `POLICY_DEFAULTS` and `policySchema` (policy.ts) carry
 * them. These are the policy values that are also protocol caps, so the two cannot drift.
 */
export const POLICY_DEFAULTS_SPEC = 'docs/foundation/06-mcp-server.md §3';
export const POLICY_PROTOCOL_LIMITS = freeze({
  'envelopes.maxEnvelopeKB': 24,
  'files.defaultExpiryDays': 7,
} as const);

// --- AgentCard EIP-712 (04 §2.4) -----------------------------------------------------------------

/** Chain-agnostic domain: no chainId, no verifyingContract (04 §2.4). */
export const AGENT_CARD_EIP712_DOMAIN = freeze({ name: 'OCC AgentCard', version: '1' } as const);

/** The AgentCard struct, field for field (04 §2.4). The JSON card has exactly these keys. */
export const AGENT_CARD_EIP712_TYPES = freeze({
  AgentCard: freeze([
    freeze({ name: 'version', type: 'uint8' } as const),
    freeze({ name: 'agentEvm', type: 'address' } as const),
    freeze({ name: 'agentNostr', type: 'bytes32' } as const),
    freeze({ name: 'agentEnc', type: 'bytes32' } as const),
    freeze({ name: 'ownerEvm', type: 'address' } as const),
    freeze({ name: 'ownerNostr', type: 'bytes32' } as const),
    freeze({ name: 'ownerEnc', type: 'bytes32' } as const),
    freeze({ name: 'nameHash', type: 'bytes32' } as const),
    freeze({ name: 'relaysHash', type: 'bytes32' } as const),
    freeze({ name: 'issuedAt', type: 'uint64' } as const),
    freeze({ name: 'expiresAt', type: 'uint64' } as const),
    freeze({ name: 'keyEpoch', type: 'uint32' } as const),
  ] as const),
} as const);
