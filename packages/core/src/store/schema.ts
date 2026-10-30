// The logical store schema of 07 §3 and §3.1–§3.5 (G-9), one per agent (§3.1). Every Store
// implementation (in-memory for tests, SQLite in Node, M1-8b; Durable Object SQLite, M2-3a) enforces
// these keys, unique constraints, enums, value types and row counts itself, not only the core (§3.7).
//
// Column kinds (§3.1):
// - `id`: text in the encoding the spec fixes for that value, compared as bytes; never empty.
// - `text`: text, may be empty.
// - `int`: an integer in [0, 2^53 - 1]; times are unix seconds.
// - `flag`: 0 or 1.
// - `usd`: a USD amount string (04 §2.4.1), compared as an exact decimal, never as a float.
// - `json`: the exact JSON text received or signed, never re-serialised.
// - `enc`: a Sealed value (encrypted at rest under the store key, AAD bound to table, column and
//   row key; StoreCipher).
// - `enum`: exactly one of the listed values.
// `?` marks a nullable column.
//
// Columns beyond the "key columns" of 07 §3 are named in a comment where they are added. The owner
// surfaces' own tables (§3.6: owner_copies, owner_policy_echo) live in a separate owner store and are
// not part of the agent Store.

/** A value encrypted under the store key (07 §3.1). Opaque to the Store; only a StoreCipher opens it. */
export type Sealed = string & { readonly __sealed: unique symbol };

export type ColumnKind = 'id' | 'text' | 'int' | 'flag' | 'usd' | 'json' | 'enc' | 'enum';

export interface ColumnSpec<
  K extends ColumnKind = ColumnKind,
  N extends boolean = boolean,
  E extends readonly string[] = readonly string[],
> {
  readonly kind: K;
  readonly nullable: N;
  readonly values?: E;
}

const col = <K extends Exclude<ColumnKind, 'enum'>>(kind: K) =>
  Object.freeze({ kind, nullable: false as const });
const opt = <K extends Exclude<ColumnKind, 'enum'>>(kind: K) =>
  Object.freeze({ kind, nullable: true as const });
const oneOf = <const E extends readonly string[]>(...values: E) =>
  Object.freeze({ kind: 'enum' as const, nullable: false as const, values });
const optOneOf = <const E extends readonly string[]>(...values: E) =>
  Object.freeze({ kind: 'enum' as const, nullable: true as const, values });

const id = col('id');
const text = col('text');
const int = col('int');
const usd = col('usd');
const json = col('json');
const enc = col('enc');
const flag = col('flag');

/** A unique constraint; `where` makes it partial (rows that match it only). Null columns never collide. */
export interface UniqueSpec {
  readonly columns: readonly string[];
  readonly where?: Readonly<Record<string, string>>;
}

export interface TableSpec {
  readonly columns: Readonly<Record<string, ColumnSpec>>;
  readonly primaryKey: readonly string[];
  readonly unique?: readonly UniqueSpec[];
  /** A table that holds at most this many rows (one store per agent, §3.1). */
  readonly maxRows?: number;
}

/** The single-row tables use this fixed primary key value. */
export const SINGLETON_SLOT = 'current' as const;

export const TABLES = {
  // 07 §3; G-23. agent_card_json is `enc` and holds the signed card, {card, cardSig, cardAgentSig}
  // (IR-M1-7a-1 M-3: a clear card exposes nameHash and relaysHash). Added: name and relays (the
  // off-chain card fields, `enc`), updated_at. pending_card_json (M1-1g-d, `enc`, null when no
  // rotation is in progress): the owner-signed card for key_epoch + 1, stored before the KeyStore
  // advances, {card, cardSig, cardAgentSig} like agent_card_json.
  identity: {
    columns: {
      agent_id: id,
      agent_card_json: enc,
      pending_card_json: opt('enc'),
      name: enc,
      relays: enc,
      key_epoch: int,
      storage_prefix: id,
      revoked_at: opt('int'),
      created_at: int,
      updated_at: int,
    },
    primaryKey: ['agent_id'],
    maxRows: 1,
  },
  // 07 §3 and the pairing columns (04 §2.9, §3.6.1). contact_id is the contact's agentId.
  // agent_card_json is `enc`: {card, cardSig, cardAgentSig} (cardAgentSig null after a card-update).
  // Added: name_source (06 §2.1), relays (`enc`), agent_nostr (the current card's key, unique, for
  // sender lookup), key_epoch, nostr_keys (every agentNostr of a stored card, oldest first: superseded
  // keys, 04 §3.1.1 step 7, and the revoked set, §3.4), updated_at. Status `removed` is a tombstone
  // (02 F-14): the keys stay so later envelopes from them are dropped.
  // W4-RENAME-REACHES-CONTACTS (D-141; 07 §3 "Former name", store version 9, appended): former_name
  // (`enc`, the name the owner last saw before a card-update changed it), name_changed_at and
  // name_change_seen (null or 1: no note due; 0: the note is due), and declared_name (`enc`, the
  // contact's own self-declared name, kept also while the owner's alias is shown, so the note can read
  // "Now calls itself {new} (was {old})"; null on rows from before version 9). Display state only.
  contacts: {
    columns: {
      contact_id: id,
      name: enc,
      name_source: oneOf('counterparty', 'owner'),
      agent_card_json: enc,
      relays: enc,
      agent_nostr: id,
      key_epoch: int,
      nostr_keys: json,
      owner_fingerprint: id,
      verified: flag,
      status: oneOf('active', 'blocked', 'removed', 'revoked'),
      pairing: oneOf('pending', 'complete', 'mismatch'),
      handshake_envelope_id: opt('id'),
      handshake_ack_envelope_id: opt('id'),
      code_commit: opt('enc'),
      nonce_b: opt('enc'),
      safety_check: opt('json'),
      safety_code_checked: flag,
      created_at: int,
      updated_at: int,
      former_name: opt('enc'),
      name_changed_at: opt('int'),
      name_change_seen: opt('flag'),
      declared_name: opt('enc'),
    },
    primaryKey: ['contact_id'],
    unique: [{ columns: ['agent_nostr'] }],
  },
  // Staged pairings (IR-M1-7a-1 M-2; proposed 07 §3 amendment): a verified card waiting for its
  // handshake to complete. Nothing in `contacts` changes until completion, which writes the contact
  // and deletes this row in one store transaction (04 §2.9). Deleted on completion or abort, and
  // pruned after expires_at (the invite's expiry).
  pairings: {
    columns: {
      pairing_id: id,
      contact_id: id,
      role: oneOf('inviter', 'invitee'),
      agent_nostr: id,
      key_epoch: int,
      owner_fingerprint: id,
      agent_card_json: enc,
      name: enc,
      relays: enc,
      created_at: int,
      expires_at: int,
    },
    primaryKey: ['pairing_id'],
  },
  // 07 §3 (and nonce_a, 04 §3.6.1). Added: created_at.
  invites: {
    columns: {
      invite_id: id,
      proof_key: enc,
      nonce_a: opt('enc'),
      label: opt('enc'),
      expires_at: int,
      used_at: opt('int'),
      created_at: int,
      // W4-SHORT-INVITE (D-139, 04 §3.6.2; schema version 8): a short link's drop object, recorded
      // before its upload so the inviter can delete it on completion, cancel or expiry; null once
      // deleted, and for a format 1 invite. Never the link secret or the invite key.
      drop_lookup_id: opt('enc'),
      drop_key_epoch: opt('enc'),
      cancelled_at: opt('int'),
    },
    primaryKey: ['invite_id'],
  },
  // 07 §3, §3.2. refused_at and request_accepted_at (D-72, schema version 2): the local time a row
  // was stored as `refused` (its retention), and the owner's Accept of one `request` row.
  envelopes: {
    columns: {
      envelope_id: id,
      envelope_hash: id,
      thread_id: id,
      direction: oneOf('in', 'out'),
      contact_id: opt('id'),
      from_key: id,
      type: id,
      state: oneOf('received', 'ok', 'request', 'refused'),
      refused_reason: opt('id'),
      created_at: int,
      envelope_json: opt('json'),
      payload_json: opt('enc'),
      read_at: opt('int'),
      delivery: optOneOf('queued', 'sent', 'not_delivered'),
      refused_at: opt('int'),
      request_accepted_at: opt('int'),
    },
    primaryKey: ['envelope_id'],
  },
  // 07 §3. delete_after (M1-1g-i, schema version 4): the `files.deleteAfter` in effect when the
  // file was sent, so a later policy change never applies retroactively. Null on a row stored
  // before version 4: retention keeps it until it expires (I-9).
  // saved_name (MSG-FILES-IO-b, schema version 6): the single file name fetchFile placed in the
  // Inbox folder, sealed like `name`; never a path. Null until a fetch saved the file, and on every
  // row stored before version 6. It goes with the row when retention deletes it.
  files: {
    columns: {
      envelope_id: id,
      idx: int,
      name: enc,
      size: int,
      sha256: id,
      locator: enc,
      url: opt('enc'),
      file_key: enc,
      expires_at: int,
      deleted_at: opt('int'),
      delete_after: optOneOf('expiry', 'receipt'),
      saved_name: opt('enc'),
    },
    primaryKey: ['envelope_id', 'idx'],
  },
  // 07 §3, §3.5. One signed Record per row. M1-7g, without a schema change: `status` also marks
  // a record a contact made for this agent (`received`: the checked on-chain view, salt `enc`), a
  // signed Receipt kept for resending (`receipt_*`, keyed `<recordId>:<receiptType>` as the
  // submitter item ID, 07 §7, with an empty sealed salt) and a `proof` envelope waiting for its
  // message (`awaiting`, keyed `await:<envelope id>`, bounded in number and age). M1-33d: the
  // sender's delivery receipt request for its own envelope (`receipt_request`, keyed
  // `request:<envelope id>`, `record_json` `{}`, an empty sealed salt).
  proofs: {
    columns: {
      record_id: id,
      envelope_id: id,
      chain_id: int,
      record_json: json,
      tx_hash: opt('id'),
      status: id,
      fee_token: opt('id'),
      fee_amount: opt('text'),
      salt: enc,
      created_at: int,
    },
    primaryKey: ['record_id'],
  },
  // 07 §3. One receipt per record and type (I-6: one-time flag per record).
  receipts: {
    columns: {
      record_id: id,
      type: int,
      signer: id,
      tx_hash: opt('id'),
      at: int,
    },
    primaryKey: ['record_id', 'type'],
  },
  // 07 §3, §3.5. scope_key: at most one pending approval per value.
  approvals: {
    columns: {
      approval_id: id,
      action_json: enc,
      scope_json: opt('json'),
      answers_envelope_id: opt('id'),
      scope_key: opt('id'),
      source: oneOf('owner', 'policy_grant'),
      policy_hash: opt('enc'),
      signed_decision: opt('json'),
      signed_cancel: opt('json'),
      summary: enc,
      status: oneOf('pending', 'approved', 'denied', 'expired', 'cancelled', 'void'),
      expires_at: int,
      created_at: int,
      decided_at: opt('int'),
    },
    primaryKey: ['approval_id'],
    unique: [{ columns: ['scope_key'], where: { status: 'pending' } }],
  },
  // 07 §3.4: exactly one row.
  policies: {
    columns: {
      slot: oneOf(SINGLETON_SLOT),
      version: int,
      signed_json: enc,
      policy_hash: enc,
      applied_at: int,
    },
    primaryKey: ['slot'],
    maxRows: 1,
  },
  // 07 §3.
  sync_cursors: {
    columns: { relay_url: id, last_seen: int },
    primaryKey: ['relay_url'],
  },
  // 07 §3.2. wrap_json is null once the row leaves `pending`.
  outbox: {
    columns: {
      wrap_id: id,
      envelope_id: id,
      recipient_key: id,
      wrap_json: opt('json'),
      relays: enc,
      acks: enc,
      attempt: int,
      role: oneOf('contact', 'owner'),
      attempts: int,
      next_attempt_at: int,
      created_at: int,
      give_up_at: int,
      state: oneOf('pending', 'sent', 'not_delivered'),
      reason: optOneOf('timeout', 'revoked', 'unreadable'),
    },
    primaryKey: ['wrap_id'],
    unique: [
      { columns: ['envelope_id', 'recipient_key', 'attempt'] },
      { columns: ['envelope_id', 'recipient_key'], where: { state: 'pending' } },
    ],
  },
  // 07 §3.2.
  seen: {
    columns: { kind: oneOf('wrap', 'envelope'), id, first_seen_at: int },
    primaryKey: ['kind', 'id'],
  },
  // 07 §3.2.
  held_envelopes: {
    columns: {
      envelope_id: id,
      envelope_hash: id,
      from_key: id,
      owner_kid: id,
      envelope_json: json,
      payload_json: enc,
      received_at: int,
      release_at: int,
    },
    primaryKey: ['envelope_id'],
  },
  // 07 §3.2 (D-72, schema version 2). Written only by the owner's Block and Unblock, and deleted by a
  // card-update that makes the key a contact's current key. via_envelope_id is information only
  // (IR-D-72-1 F03): Unblock goes by from_key.
  blocked_keys: {
    columns: { from_key: id, blocked_at: int, via_envelope_id: id },
    primaryKey: ['from_key'],
  },
  // 07 §3.2.
  rate_counters: {
    columns: { contact_id: id, bucket: int, count: int },
    primaryKey: ['contact_id', 'bucket'],
  },
  // 07 §3.2 (06 §6, D-73; schema version 3, M1-7k-b). One row per lease name; `subscriptions` is the
  // only name in M1. holder is 16 random bytes, base64url, chosen by each server process at start.
  publisher_lease: {
    columns: { name: id, holder: id, lease_until: int },
    primaryKey: ['name'],
  },
  // M1-7k-b (IR-M1-7k-1 F08; schema version 3): the transient faults of a staged pairing message
  // (`handshake` or `handshake-ack`, still `queued`, no outbox rows yet): how many, and the last one's
  // time, so that a message whose fault does not clear goes behind the others and never blocks newer
  // ones. A row lives
  // only while its message is staged: it is deleted in the transaction that gives the message its
  // outbox rows, drops it or expires it. In clear (an envelope ID and times).
  outbox_staged: {
    columns: { envelope_id: id, failures: int, failed_at: int },
    primaryKey: ['envelope_id'],
  },
  // 07 §3.2 (06 §6 "MCP session heartbeat"; D-143, W4-LIVE-STATUS; schema version 10; proposed, owner
  // confirms at merge). One row per running `agentlink mcp` process, lease holder or not:
  // session_id is 16 random bytes, base64url, chosen per process; app an id of the 06 §7 table or
  // `other` (never the client's own name); pid read only by a reader on this machine (signal 0) and
  // never put in an answer, event, log or error. Status, not authority: nothing reads these rows to
  // authorise anything. In clear (no secret, path, client-sent name or content).
  mcp_sessions: {
    columns: {
      session_id: id,
      app: text,
      agent_id: id,
      pid: int,
      started_at: int,
      beat_until: int,
      last_tool_at: opt('int'),
    },
    primaryKey: ['session_id'],
  },
  // 07 §3.2 (D-143; schema version 10): when each AI app id last ran this agent, so "last seen"
  // outlives the session row. At most one row per id.
  mcp_last_seen: {
    columns: { app: text, last_seen_at: int },
    primaryKey: ['app'],
  },
  // 07 §3.2 (06 §6 "Paused agents"; D-143 (5), W4-PAUSE; schema version 11; proposed, owner confirms
  // at merge): one row at most, present only while the owner has paused the agent. slot is the fixed
  // single-row key; paused_at is when the pause began (unix seconds). Written by the app's Pause
  // (no presence, nothing signed); deleted only by a verified `agent.resume` (04 §2.5.1). Every
  // process reads it before a send, a fetch and every loop step, and a row that cannot be read
  // counts as paused (fail closed). In clear: no secret, path, name or content.
  agent_pause: {
    columns: { slot: oneOf(SINGLETON_SLOT), paused_at: int },
    primaryKey: ['slot'],
    maxRows: 1,
  },
  // 07 §3.3. approval_id is the empty string for a call without one, so it is `text`.
  idempotency: {
    columns: {
      tool: id,
      client_request_id: text,
      approval_id: text,
      request_digest: id,
      state: oneOf('running', 'done'),
      run_id: id,
      lease_until: int,
      effect_ref: opt('enc'),
      result_json: opt('enc'),
      created_at: int,
      expires_at: int,
    },
    primaryKey: ['tool', 'client_request_id', 'approval_id'],
  },
  // 07 §3.4.
  owner_action_nonces: {
    columns: {
      nonce: id,
      op: id,
      action_hash: id,
      issued_at: int,
      expires_at: int,
      applied_at: int,
    },
    primaryKey: ['nonce'],
  },
  // 07 §3.4. Permanent: never deleted.
  revoked_agents: {
    columns: {
      agent_evm: id,
      nostr_keys: json,
      signed_json: opt('json'),
      reason: optOneOf('compromised', 'retired', 'other'),
      source: oneOf('envelope', 'registry'),
      chain_id: opt('id'),
      registry_ref: opt('id'),
      applied_at: int,
    },
    primaryKey: ['agent_evm'],
  },
  // 07 §3.4 (M1-9i-a, D-115; schema version 5): the agent's own S3-compatible storage, as the owner
  // signed it. signed_json is the applied `storage.set`, verbatim and sealed (its endpoint and bucket
  // identify the user's account); id is its `id`, naming the KeyStore item `s3:<id>`. At most one
  // row in M1. No credential is ever in the store.
  own_storage: {
    columns: { id, signed_json: enc, applied_at: int },
    primaryKey: ['id'],
    maxRows: 1,
  },
  // 07 §3.4 (U3-d, D-138; schema version 7; proposed, owner confirms at merge): the local owner
  // actions as the owner signed them, stored like `contact.check` and re-verified on every load.
  // record names what the row holds: `agent.label` (the one label row, the latest applied one) or,
  // for card U3-f, `app:<id>` (the latest `app.connect` or `app.disconnect` for one AI app).
  // signed_json is the applied SignedOwnerAction, verbatim and sealed (the label is the owner's own
  // text). The nonce row in owner_action_nonces is written in the same transaction.
  local_owner_actions: {
    columns: {
      record: id,
      op: oneOf('agent.label', 'app.connect', 'app.disconnect'),
      signed_json: enc,
      applied_at: int,
    },
    primaryKey: ['record'],
  },
  // 07 §3.5.
  budget_ledger: {
    columns: {
      entry_id: id,
      ledger_epoch: int,
      t: int,
      record_id: id,
      chain_id: int,
      approval_id: opt('id'),
      reserved_usd: usd,
      charged_usd: opt('usd'),
      state: oneOf('reserved', 'charged', 'released'),
      deadline: int,
      replaces: opt('id'),
      settled_at: opt('int'),
    },
    primaryKey: ['entry_id'],
    unique: [{ columns: ['record_id'] }],
  },
  // 07 §3.5: exactly one row, created with `identity`.
  budget_state: {
    columns: {
      slot: oneOf(SINGLETON_SLOT),
      ledger_epoch: int,
      status: oneOf('ok', 'broken'),
      newest_t: int,
      since: int,
      broken_at: opt('int'),
    },
    primaryKey: ['slot'],
    maxRows: 1,
  },
  // 07 §3.5.
  commitment_parts: {
    columns: {
      approval_id: id,
      part: oneOf('envelope', 'record', 'receipt'),
      state: oneOf('unclaimed', 'claimed', 'done', 'void'),
      item_ref: opt('id'),
      item_json: opt('json'),
      ledger_entry_id: opt('id'),
      void_reason: optOneOf('expired', 'superseded', 'void', 'cancelled'),
      replacements: int,
      claimed_at: opt('int'),
      done_at: opt('int'),
      updated_at: int,
    },
    primaryKey: ['approval_id', 'part'],
  },
} as const satisfies Readonly<Record<string, TableSpec>>;

export type Tables = typeof TABLES;
export type TableName = keyof Tables;
export const TABLE_NAMES = Object.freeze(Object.keys(TABLES)) as readonly TableName[];

type BaseValue<C> = C extends { readonly kind: 'int' }
  ? number
  : C extends { readonly kind: 'flag' }
    ? 0 | 1
    : C extends { readonly kind: 'enc' }
      ? Sealed
      : C extends { readonly kind: 'enum'; readonly values: infer E extends readonly string[] }
        ? E[number]
        : string;

/** The TypeScript type of one column's value. */
export type ColumnValue<C> = C extends { readonly nullable: true }
  ? BaseValue<C> | null
  : BaseValue<C>;

/** One row of a table: every column present (null where nullable and empty). */
export type Row<T extends TableName> = {
  readonly [K in keyof Tables[T]['columns']]: ColumnValue<Tables[T]['columns'][K]>;
};

export type ColumnName<T extends TableName> = keyof Tables[T]['columns'] & string;

/** The primary-key columns of a table and their values. */
export type PrimaryKey<T extends TableName> = Pick<
  Row<T>,
  Tables[T]['primaryKey'][number] & keyof Row<T>
>;

/** Any value a Store holds. */
export type StoreValue = string | number | null;
