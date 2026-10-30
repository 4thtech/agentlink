// Store-side values of 07 §3.1–§3.7 (G-9). The owner confirmed the proposed values at the merge of
// 4thtech/agentlink#44; they stay named constants so a later spec change edits one place. Values that
// @4thtech-io/types already fixes (G-7: clock skew, approval TTL, nonce retention, budget window) are
// imported from there and not repeated here.

/**
 * The logical schema version of 07 §3 that this code implements (forward migrations only, §3.7).
 * Version 5 (M1-9i-a, D-115) adds `own_storage` (07 §3.4). Version 6 (MSG-FILES-IO-b) adds
 * `files.saved_name`. Version 7 (U3-d, D-138) adds `local_owner_actions` (07 §3.4). Version 8
 * (W4-SHORT-INVITE, D-139) adds `invites.drop_lookup_id`, `drop_key_epoch` and `cancelled_at`.
 * Version 9 (W4-RENAME-REACHES-CONTACTS, D-141) adds the contacts former-name columns (07 §3).
 * Version 10 (W4-LIVE-STATUS, D-143) adds `mcp_sessions` and `mcp_last_seen` (07 §3.2). An
 * older build refuses a newer store (`store_schema_newer`), so an upgrade
 * cannot be rolled back.
 */
export const STORE_SCHEMA_VERSION = 10;

/** 04 §2.9: `storagePrefix` is 16 random bytes, base64url, generated at init. */
export const STORAGE_PREFIX_BYTES = 16;

// --- §3.2 Delivery -------------------------------------------------------------------------------

/** outbox: give_up_at = created_at + 24 h (the retry window of §4.2). */
export const OUTBOX_GIVE_UP_SECONDS = 86_400;
/** outbox: a row is deleted 7 days after it leaves `pending`. */
export const OUTBOX_ROW_RETENTION_SECONDS = 604_800;
/** outbox: a row is `sent` once this many relays returned `OK` (§4.2). */
export const OUTBOX_SENT_RELAY_ACKS = 2;

/**
 * Staged pairing messages (IR-M1-7k-1 F08; M1-7k-b): one still `queued` without outbox rows this
 * long after its created_at is marked `not_delivered`. Equal to the outbox retry window (24 h), so a
 * staged message is given as long to get its wraps as a wrap is given to reach two relays.
 */
export const STAGED_MAX_AGE_SECONDS = 86_400;

/** publisher_lease: lease_until = now + 60 s (06 §6; D-73; M1-7k-b). */
export const PUBLISHER_LEASE_SECONDS = 60;
/** publisher_lease: the holder renews, and a non-holder tries to take it, every 20 s. */
export const PUBLISHER_LEASE_RENEW_SECONDS = 20;

/** mcp_sessions: every process beats every 15 s (06 §6 "MCP session heartbeat"; D-143). */
export const MCP_SESSION_BEAT_SECONDS = 15;
/** mcp_sessions: beat_until = now + 45 s; a row past it is not live. */
export const MCP_SESSION_TTL_SECONDS = 45;
/** mcp_sessions: a beat_until further ahead than this is from a clock that went back: not live. */
export const MCP_SESSION_FUTURE_LIMIT_SECONDS = 90;

/** seen: a row is older than 7 days before it may be pruned (and see the cursor bound). */
export const SEEN_MIN_RETENTION_SECONDS = 604_800;
/** seen: the sync look-back below the lowest relay cursor (48 h, §4.2). */
export const SYNC_LOOKBACK_SECONDS = 172_800;
/** seen: a relay cursor older than the longest relay retention (30 days) is ignored for pruning. */
export const MAX_RELAY_RETENTION_SECONDS = 2_592_000;

/** envelopes: at most this many rows are `received` (not yet processed). */
export const MAX_RECEIVED_ENVELOPES = 1_000;

/** held_envelopes: release_at = received_at + 48 h (04 §3.1.1 step 7). */
export const HELD_RELEASE_SECONDS = 172_800;
/** held_envelopes: at most 100 rows per owner_kid, in their own pool (decided at #44; amends D-62). */
export const MAX_HELD_PER_OWNER_KID = 100;
/**
 * A terms envelope that waits for a version it links to (M1-32-b): kept `received` and decided
 * again in each pass once other envelopes of its chain are taken; stored as refused once its
 * signed createdAt is this much older than now (the relay look-back, as for held rows).
 */
export const TERMS_WAIT_SECONDS = 172_800;

/** Requests queue: at most 5 pending requests per unknown sender key (decided at #44). */
export const MAX_REQUESTS_PER_SENDER = 5;
/** Requests queue: at most 200 pending requests in total (decided at #44). */
export const MAX_REQUESTS_TOTAL = 200;

/**
 * Requests queue: a `refused` row from an unknown key stops counting this long after its local
 * `refused_at`, and is pruned at the start of the next processing pass (D-72; 07 §3.2; equal to the
 * seen-set's minimum retention, IR-D-72-1 F04).
 */
export const REFUSED_RETENTION_SECONDS = 604_800;

/** rate_counters: 60-second buckets over a sliding hour. */
export const RATE_BUCKET_SECONDS = 60;
export const RATE_WINDOW_SECONDS = 3_600;
/** rate_counters: an envelope over `rateLimitPerContactPerHour` is dropped (decided at #44). */
export const OVER_RATE_LIMIT_ACTION = 'drop' as const;

// --- §3.3 Idempotency ----------------------------------------------------------------------------

/** idempotency: expires_at = max(created_at + 7 d, approval or scope expiresAt + S) (decided at #44). */
export const IDEMPOTENCY_MIN_RETENTION_SECONDS = 604_800;
/** idempotency: the execution lease, renewed every 20 s (IR-G-9-1 H-1; decided at #44). */
export const IDEMPOTENCY_LEASE_SECONDS = 60;
export const IDEMPOTENCY_LEASE_RENEW_SECONDS = 20;
/** idempotency: the rejection code for a reused `clientRequestId` with other args (decided at #44). */
export const IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED' as const;

// --- §3.4 Owner authority ------------------------------------------------------------------------

/**
 * policies: the store transaction commits before the KeyStore policy-version mark is raised
 * (decided at #44). A named marker so the apply path (M1-7d) and its tests cite one value.
 */
export const POLICY_APPLY_ORDER = 'store-then-mark' as const;
