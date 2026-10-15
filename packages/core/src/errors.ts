// Core errors. Every message is a fixed sentence chosen here: no input, no inbound content, no key
// material and no name is ever interpolated (I-5, I-7). Callers branch on `code`.

export type CoreErrorCode =
  // Store (07 §3.1, §3.7)
  | 'store_schema_newer'
  | 'store_schema_older'
  | 'store_unreadable'
  | 'clock_invalid'
  // Identity (04 §2.4, §2.6, §2.9)
  | 'identity_missing'
  | 'identity_exists'
  | 'identity_mismatch'
  | 'identity_revoked'
  | 'key_epoch_mismatch'
  | 'rotation_pending'
  | 'owner_keys_changed'
  | 'card_invalid'
  | 'card_owner_signature_invalid'
  | 'card_agent_signature_invalid'
  | 'card_expired'
  | 'name_invalid'
  | 'relays_invalid'
  // Contacts (04 §2.9, §3.4.1; 02 F-13, F-14)
  | 'contact_not_found'
  | 'contact_is_self'
  | 'contact_revoked'
  | 'contact_conflict'
  | 'repair_owner_changed'
  | 'repair_epoch_lower'
  | 'card_update_not_newer'
  | 'pairing_not_found'
  | 'pairing_expired'
  | 'pairing_evidence_missing'
  // Envelopes (04 §3.1–§3.4; M1-7b)
  | 'contact_not_active'
  | 'type_not_sendable'
  | 'payload_invalid'
  | 'thread_invalid'
  | 'envelope_too_large'
  // Send pipeline and transport (07 §2, §3.2, §4; M1-7k)
  | 'transport_unavailable'
  // Inbox sync and delivery acknowledgements (07 §2, §4.2; 02 F-23; M1-7h)
  | 'envelope_not_found'
  | 'sync_budget_invalid'
  // Inbox page read (06 §2.2; M1-7h-c)
  | 'inbox_query_invalid'
  | 'inbox_busy'
  // Policy (06 §3; M1-7d)
  | 'policy_context_invalid'
  // Approvals and idempotency (04 §3.4.1, 06 §2.5, 07 §3.3; M1-7e)
  | 'approval_action_invalid'
  | 'approval_summary_invalid'
  | 'approval_scope_expired'
  | 'fee_quote_invalid'
  | 'idempotency_unavailable'
  | 'idempotency_args_invalid'
  | 'idempotency_result_invalid'
  | 'idempotency_lost'
  // Pairing (04 §3.6, §3.6.1; M1-7c)
  | 'invite_invalid'
  | 'invite_too_large'
  | 'invite_expired'
  | 'invite_options_invalid'
  | 'safety_code_unavailable';

export class CoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

/** Thrown by a Store for a schema violation: a key, unique, enum, type or row-count rule (07 §3.7). */
export class StoreConstraintError extends Error {
  readonly table: string;

  constructor(table: string, message: string) {
    super(message);
    this.name = 'StoreConstraintError';
    this.table = table;
  }
}

/** Thrown by a Store for a misuse of its contract, such as an asynchronous transaction body (07 §3.1). */
export class StoreUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreUsageError';
  }
}
