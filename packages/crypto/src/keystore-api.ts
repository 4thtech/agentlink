// The key interfaces of 03 §3 and 04 §3.1.1 (G-2): EnvelopeKeys, KeyStore, OwnerKeyStore and
// OwnerSession; 04 §2.5 owner presence; 04 §8.1 secret-key operations go through a KeyStore.
//
// G-2: the interfaces live in @4thtech-io/crypto, not core, so transport-nostr (which depends only on
// crypto) can take them without a dependency cycle. They are types only and hold no secret, so they
// are in the main entry. The in-memory implementations, which hold a seed, are in the test-only
// subpath @4thtech-io/crypto/testing. Backends: Node keychain and file (packages/node, M1-8a, M1-8f)
// and the self-host Worker (M2-3a).
//
// Contract for every implementation:
// - No method returns a private key or a seed. Signing, NIP-44 key agreement and the CEK unwrap
//   happen inside; callers get public keys, signatures, ciphertext, the plaintext they asked for, or
//   (unwrapCek) the one content key they wipe after use.
// - Signing and encryption always use the current key epoch. Only the decrypting methods, the
//   public-key lookup and signDropRequest (DELETE only, M1-1g-f) take an epoch; an epoch above the
//   current one is `epoch_unavailable`.
// - No method signs an untagged digest, and none opens HPKE under a caller-chosen info.
// - Owner signatures exist only on an OwnerSession, and the only way to get one is
//   OwnerKeyStore.unlock(presence). A session is short-lived, and lock, close and expiry wipe its
//   key material.
// - The key epoch moves only through KeyEpochControl.advanceEpoch (M1-1g-d), an owner-only
//   compare-and-set on the backend's management surface, never on the KeyStore the agent path uses.
// - Restore, export and storage credentials go through KeyExportControl, KeyImportControl and
//   StorageCredentialControl (M1-9i-b2), owner-flow surfaces of the same kind; no raw seed crosses
//   them.
// - Errors are fixed sentences that never contain an input (I-7).
import type { AgentCard } from './agent-card.js';
import type { DropAuthRequest } from './drop-auth.js';
import type { TypedData } from './eip712.js';
import type { DirectTransaction } from './evm-tx.js';
import type { WrappedCek } from './hpke.js';
import type { PublicIdentity } from './keys.js';
import type { JsonObject } from './jcs.js';
import type { NostrEvent, UnsignedNostrEvent } from './nostr-event.js';
import type { RecoveryCodeSecret } from './owner-seed-wrap.js';
import type {
  OpenRecoveryKitOptions,
  RecoveryKitContents,
  RecoveryKitSource,
  RecoveryKitStoreSink,
  RecoveryKitStoreSource,
} from './recovery-kit.js';
import type { StorageCredential } from './credential-digest.js';

/** Why a KeyStore refused an operation for its state, not its input. Stable strings. */
export type KeyStoreErrorCode =
  /** The store was closed and its secrets wiped. */
  | 'keystore_closed'
  /** The owner session expired, was closed, or the owner store was locked. Unlock again. */
  | 'owner_locked'
  /** unlock() got no presence proof of a known kind. */
  | 'presence_required'
  /** The presence proof did not unlock the owner key. */
  | 'presence_rejected'
  /** A key epoch above the store's current epoch. */
  | 'epoch_unavailable'
  /**
   * The store is not at the key epoch the caller named: a compare-and-set advance (or a preview)
   * found another epoch, because another flow advanced it first or the caller's view is stale.
   * Nothing changed.
   */
  | 'epoch_conflict'
  /** This backend does not implement the operation yet; it fails closed. */
  | 'unsupported_operation'
  /**
   * A well-formed request this signer will not perform, such as an OwnerSession asked to sign a
   * Nostr kind other than 13 or 22242 (04 §3.1.1). A capability limit, not an input error.
   */
  | 'operation_not_allowed'
  /**
   * The item an owner-flow control would write already exists (M1-9i-b2: restore never overwrites,
   * D-115 C; a storage credential id is new on every connect). Nothing was written.
   */
  | 'item_exists';

/** The error a KeyStore throws for its state. Input refusals stay CryptoInputError. */
export class KeyStoreError extends Error {
  readonly code: KeyStoreErrorCode;

  constructor(code: KeyStoreErrorCode, message: string) {
    super(message);
    this.name = 'KeyStoreError';
    this.code = code;
  }
}

/**
 * The key epoch for a decrypting method or the public-key lookup (04 §2.6, §3.1.1). Defaults to the
 * current epoch. Older epochs stay usable so history remains readable after rotation; an epoch above
 * the current one is refused (`epoch_unavailable`). Signing methods never take one, except
 * signDropRequest for a DELETE (M1-1g-f).
 */
export interface EpochOptions {
  readonly epoch?: number;
}

/**
 * The secret-key operations that build and open envelopes (04 §3.1.1, 07 §4.1). The agent's KeyStore
 * and an owner's OwnerSession both implement it, so transport and core use one path for both.
 */
export interface EnvelopeKeys {
  /**
   * The envelope `sig` (04 §3.1.1): BIP-340 by the Nostr key over
   * taggedHash("agentlink/envelope/v1", envelopeHash), as 128 lowercase hex. `envelopeHash` is the
   * 32-byte sha256(JCS(envelope without sig)) of the parsed envelope (M1-1c). The tag is applied
   * here, so no caller gets a signature over an untagged digest.
   */
  signEnvelopeHash(envelopeHash: Uint8Array): Promise<string>;

  /**
   * Signs a Nostr event (NIP-01) with the Nostr key; sets pubkey, id and sig. Seals (kind 13) and
   * NIP-42 AUTH (kind 22242). An OwnerSession signs those two kinds only and refuses every other.
   */
  signNostr(event: UnsignedNostrEvent): Promise<NostrEvent>;

  /**
   * NIP-44 v2 to `peer` (64 lowercase hex x-only key) with the Nostr key; the conversation key is
   * derived and wiped inside. Returns the base64 payload.
   */
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;

  /** NIP-44 v2 from `peer`, with the Nostr key of `options.epoch` (default: current). */
  nip44Decrypt(peer: string, payload: string, options?: EpochOptions): Promise<string>;

  /**
   * Opens one recipient entry (04 §3.3) with the enc key of `options.epoch` (default: current) and
   * returns the 32-byte CEK, the one secret an EnvelopeKeys hands out: callers wipe it after the
   * payload AEAD. The HPKE info is built inside from the 16-byte `envelopeId`
   * ("agentlink/v1/cek" ‖ id), so this is never a general HPKE-open oracle (IR-M1-1c-1 F5).
   */
  unwrapCek(
    wrapped: WrappedCek,
    envelopeId: Uint8Array,
    options?: EpochOptions,
  ): Promise<Uint8Array>;
}

/**
 * The agent's KeyStore (03 §3, 04 §3.1.1). All keys are the agent's own, derived per 04 §2.1, at the
 * current `keyEpoch` for signing and encryption; the EVM key is always epoch 0. It never holds owner
 * keys and never opens an owner entry.
 */
export interface KeyStore extends EnvelopeKeys {
  /** The agent's public identity (04 §2.4 card fields, agentId, kid) at `options.epoch`. */
  getPublicBundle(options?: EpochOptions): Promise<PublicIdentity>;

  /**
   * EIP-712 signature by the agent EVM key (records, receipts, `cardAgentSig`), in the canonical
   * ECDSA form of 04 §2.4.1: `0x` + 130 lowercase hex.
   */
  sign712(typedData: TypedData): Promise<string>;

  /**
   * The card's `cardPop` (M1-4d-d; 04 §2.9, D-102): BIP-340 by the Nostr key of the current epoch
   * over taggedHash("agentlink/card-pop/v1", sha256(JCS(card))), as 128 lowercase hex. Only for this
   * agent's own card at the current epoch: a card that does not parse, or whose agentEvm, agentNostr,
   * agentEnc or keyEpoch is not this store's current one, is CryptoInputError `invalid_argument` with
   * one fixed message (cardPopSnapshot), so the store never names another agent or key as its own.
   * The tag is applied here, so this is never a general signer.
   */
  signCardPop(card: AgentCard): Promise<string>;

  /**
   * Signs one encrypted-drop request (M1-1g-e; 07 §5.4, 04 §2.1, §4) with the agent's separate drop
   * key at the current epoch, never the Nostr or EVM identity key, and returns the `Authorization`
   * header value `Nostr <base64url(JSON event)>`. The `DropSigner` of @4thtech-io/storage's drop
   * adapter. The KeyStore builds the event itself: kind 27235 and the `domain` tag are fixed, so it
   * is never a general Nostr signer. It signs only POST and DELETE to an https URL in serialised
   * form, over the drop's signed JSON body (`v: 1`, a nonce and `ts`), with `createdAt` equal to
   * the body's `ts`; anything else is CryptoInputError `invalid_argument` with one fixed message.
   *
   * `options.epoch` (M1-1g-f; 04 §2.1) is the one epoch a signing method takes: a DELETE may sign
   * with the drop key of a retained older epoch, the one its object was uploaded under (the locator
   * records it), so the object stays deletable after a rotation. It is accepted only with DELETE
   * (a POST always signs with the current epoch) and never above the current epoch
   * (`epoch_unavailable`); a POST with an epoch or a malformed epoch gets the same fixed refusal.
   * Every check happens before a key is read.
   */
  signDropRequest(
    request: DropAuthRequest,
    createdAt: number,
    options?: EpochOptions,
  ): Promise<string>;

  /**
   * Signs one direct-mode transaction (M1-4c-b; 07 §6.2, 05 §2.5) with the agent EVM key (epoch 0)
   * and returns the serialised signed transaction, `0x02…` lowercase hex. The agent's own account
   * sends a Notary or vault call and pays the network fee itself.
   *
   * It is never a general transaction signer: only EIP-1559 on a chain of DIRECT_TX_ALLOWLIST (the
   * launch testnets; never a mainnet), to that chain's Notary, fee vault or an offered fee token
   * (never a contract creation), with one of the direct-mode calls (`notarizeDirect`,
   * `notarizeBatch`, `acknowledge`, `acknowledgeBatch`; `deposit`, `withdraw` to this agent's own
   * address; `approve` with the vault as spender), bounded value, calldata, gas and fees
   * (directTransactionSnapshot). Anything else is CryptoInputError `transaction_refused` with the
   * fixed message of the rule (TRANSACTION_REFUSED). Every check happens before a key is read.
   * No MCP tool reaches it (I-4): only the chain package's direct mode calls it.
   */
  signTransaction(tx: DirectTransaction): Promise<string>;

  /** Wipes what the store holds in memory; every later call fails with `keystore_closed`. */
  close(): Promise<void>;
}

/**
 * The key-epoch management surface of a KeyStore backend (M1-1g-d; IR-M1-7a-1 Q1; 04 §2.6, §3.1.1).
 * Owner flows only: the CLI's own terminal and the local UI hold it next to the OwnerSession they
 * unlocked, and pass it to core's identity.rotate. It is not part of `KeyStore`, so the agent path
 * (MCP tools, transport, core's send and receive) has no typed way to move the epoch, and backends
 * keep the control as a separate object that the KeyStore instance cannot reach (I-4;
 * IR-M1-1g-d-1 M-1).
 *
 * Rotation order (core): previewEpoch(n + 1), sign the n + 1 card with the owner session, store it
 * as pending, advanceEpoch(n, owner), then commit key_epoch = n + 1. Whatever step a crash
 * interrupts, the agent either finishes the rotation from the owner-signed pending card or refuses
 * to send (`rotation_pending`); it never sends under keys no contact knows.
 *
 * Contract for every backend (Node keychain and file, M1-8a, M1-8f; Worker, M2-3a):
 * - The control is a distinct object, constructed only by owner flows and paired with the
 *   OwnerKeyStore whose sessions it accepts. The KeyStore instance has no method, field or
 *   reference that reaches it, so a cast of the agent KeyStore cannot advance the epoch.
 * - advanceEpoch accepts only a session that the paired OwnerKeyStore minted, checked by identity
 *   (for example a module-private WeakSet or WeakMap of issued sessions), never by shape: a
 *   look-alike object or a Proxy is `presence_required`, and an ended session is `owner_locked`.
 * - advanceEpoch is a compare-and-set: it moves the current epoch from exactly `expected` to
 *   `expected + 1`, or fails with `epoch_conflict` and changes nothing. Two advances from the same
 *   epoch never both succeed, in one process or across processes.
 * - It is atomic and durable before it resolves: after a crash, the stored epoch is either
 *   `expected` or `expected + 1`, never anything else and never a torn record.
 * - Every KeyStore instance over the same backend sees the advance at once: no instance caches the
 *   epoch past an advance (IR-M1-1g-d-1 L-5). Core re-reads the KeyStore right after advancing.
 * - The session check proves the session is a genuine owner session of the paired store, not which
 *   agent's owner it is; core binds that, because the same session must first sign the n + 1 card
 *   under the owner keys of the stored card. A same-user process that edits the backend's stored
 *   epoch directly only stops the agent from sending (04 §2.5 residual; IR-M1-7a-1 Q1).
 * - Older epochs stay usable for decryption and the public-key lookup only; signing and encryption
 *   always use the current epoch. No method here returns a secret.
 */
export interface KeyEpochControl {
  /**
   * The public keys of `epoch`, which must be the current epoch + 1, without advancing: the owner
   * signs the next card before the advance. Public keys only; getPublicBundle, signing and
   * decryption at that epoch stay `epoch_unavailable` until advanceEpoch. Any other epoch is refused:
   * the current one or lower with `epoch_conflict`, a later one with `epoch_unavailable`.
   */
  previewEpoch(epoch: number): Promise<PublicIdentity>;

  /**
   * Compare-and-set: advances the current epoch from `expected` to `expected + 1` and returns the
   * public bundle of the new epoch. Fails with `epoch_conflict` (nothing changed) unless the store is
   * at `expected`; with `presence_required` unless `owner` is a session the paired OwnerKeyStore
   * issued, and with `owner_locked` once that session has ended.
   */
  advanceEpoch(expected: number, owner: OwnerSession): Promise<PublicIdentity>;
}

// --- Owner-flow controls for export, restore and storage credentials (M1-9i-b2, D-115) -----------
//
// Three more management surfaces on the KeyEpochControl model above (04 §2.3.3 "Export: who sees
// the seeds", restore step 5; 04 §2.5.1 `storage.set`). Contract for every backend (Node keychain and
// file, M1-9i-c):
// - Each control is a distinct object, constructed only by owner flows (the CLI's own terminal and
//   the local UI), never by the agent path. The KeyStore, the OwnerKeyStore and an OwnerSession have
//   no method, field or reference that reaches one, and no MCP tool handler is given or imports one
//   (I-4; the import fence in apps/cli/test/owner-controls-fence.test.ts).
// - No raw seed crosses them, in either direction: callers pass ids, names, the recovery code typed
//   at the prompt and the store snapshot; the backend reads and writes the seeds and items itself.
//   The only bytes a control returns are DisplayCodes (keystore-controls.test.ts).
// - A method that takes an OwnerSession accepts only a session its paired OwnerKeyStore minted,
//   checked by identity, never by shape (as for advanceEpoch): a look-alike or a Proxy is
//   `presence_required`, an ended session `owner_locked`.
// - Every seed, item value and code the backend held is wiped after use and on every failure
//   (04 §8 rule 3). Errors are fixed sentences that never contain an input (I-7).

declare const DISPLAY_CODE: unique symbol;

/**
 * A code that is shown once and never stored, logged or passed on: the recovery code of a new kit,
 * a new owner code, or a new file-KeyStore unlock code, as ASCII bytes (04 §2.3.3, §2.8 display
 * rules). The caller shows it, then wipes it. A plain Uint8Array (a seed, for example) is not one.
 */
export type DisplayCode = Uint8Array & { readonly [DISPLAY_CODE]: true };

/** An agent to include in a recovery kit (04 §2.3.3 manifest `agents`). */
export interface RecoveryKitExportAgent {
  /** `0x` + 40 lowercase hex (04 §2.9). */
  readonly agentId: string;
  /** The local agent name (06 §6). */
  readonly name: string;
}

/** What `agentlink backup export` asks the export control to seal (04 §2.3.3). */
export interface RecoveryKitExportRequest {
  /** The `kitId` of the `backup.export` actions the owner signed and the core applied first. */
  readonly kitId: string;
  /** Unix seconds, the manifest's `createdAt`. */
  readonly createdAt: number;
  readonly contents: RecoveryKitContents;
  /** Every agent to include, by default every local agent of this owner (I-10). */
  readonly agents: readonly RecoveryKitExportAgent[];
  /**
   * The store snapshot of one agent. The backend calls it for each agent while it holds that
   * agent's inter-process lock (06 §6), right after it read the agent's `policy-version` and
   * `receipts-kept` items, so the marks and the store are one consistent cut (04 §2.3.3
   * "Snapshot"). For an `identity` kit the snapshot already has its message rows deleted.
   *
   * The callback runs inside the backend's lock hold, so it must not take the agent's lock itself
   * (that would deadlock) and must not write to the KeyStore. It returns a finished private
   * temporary file (`VACUUM INTO` done and closed): the backend seals from it after the lock is
   * released. Residual: a callback that never resolves holds the agent's lock, which only stalls
   * the owner's own export (owner-side DoS, no secret exposed).
   */
  readonly snapshots: (agentId: string) => Promise<RecoveryKitStoreSource>;
  /**
   * Where the kit is written. The backend creates it itself (Node: `O_CREAT | O_EXCL |
   * O_NOFOLLOW`, mode 0600, refused under `~/.agentlink`) and deletes it on any failure.
   */
  readonly path: string;
}

/**
 * The recovery-kit export surface (04 §2.3.3 "Export: who sees the seeds"; M1-9i-b2). Owner flows
 * only, paired with the OwnerKeyStore whose sessions it accepts. The agent KeyStore gains no method.
 *
 * sealRecoveryKit reads the owner seed and each agent's items (`seed`, `store-key` and those of
 * `policy-version`, `receipts-kept`, `storage-mark` and `key-epoch` that exist; never `s3:*`, D-115 D) inside the
 * backend, seals them with the snapshots as `ALKK` v1 under a new generated recovery code
 * (sealRecoveryKit of @4thtech-io/crypto/keystore) and returns that code, for display only. The
 * owner signs and the core applies one `backup.export` per included agent before this is called
 * (its nonce row is the audit record, 07 §3.4); the session check proves only that the session is
 * genuine, as for advanceEpoch.
 */
export interface KeyExportControl {
  sealRecoveryKit(owner: OwnerSession, request: RecoveryKitExportRequest): Promise<DisplayCode>;
}

declare const RECOVERY_KIT_IMPORT: unique symbol;

/** One agent of an opened kit, as the restore lists it (04 §2.3.3 step 3). Public facts only. */
export interface RecoveryKitImportAgent {
  /** `0x` + 40 lowercase hex, derived from the kit's agent seed. */
  readonly agentId: string;
  /** The local agent name from the manifest, as ASCII bytes (`[a-z][a-z0-9-]{0,31}`). */
  readonly name: Uint8Array;
  /** The sink that holds the agent's quarantined store snapshot (04 §4 quarantine rules, D-84). */
  readonly store: RecoveryKitStoreSink;
  readonly storeLength: number;
}

/**
 * An opened and checked recovery kit inside a KeyImportControl (04 §2.3.3 steps 3, 5 and 6). It shows
 * only public facts; the seeds and items stay in the backend, where only importAgent and importOwner
 * reach them. Brand: the opened kit of openRecoveryKit, which holds the seeds, is not one.
 */
export interface RecoveryKitImport {
  readonly [RECOVERY_KIT_IMPORT]: true;
  readonly ownerNostr: Uint8Array;
  /** The 16 raw bytes of the manifest's kitId. */
  readonly kitId: Uint8Array;
  readonly createdAt: number;
  readonly contents: RecoveryKitContents;
  /** In manifest order (sorted by agentId). */
  readonly agents: readonly RecoveryKitImportAgent[];
  /** Wipes every seed and item the backend holds for this kit; later imports fail. */
  wipe(): void;
}

/** Options for KeyImportControl.importAgent. */
export interface ImportAgentOptions {
  /**
   * The local name to restore under (`--agent <newname>`, 06 §6); default the kit's name. The
   * backend checks it against `/^[a-z][a-z0-9-]{0,31}$/` (06 §6) before it names any file (the
   * `.alks`, the agent folder) and refuses any other value, so it can never become a path.
   */
  readonly name?: string;
  /**
   * The session of the owner item already on this machine (04 §2.3.3 restore table: an existing
   * owner is kept only after its own code opens it to the kit's owner). Required when an owner item
   * exists, and then checked by the backend (M1-9i-c): it must be a session the paired
   * OwnerKeyStore minted (by identity; a look-alike is `presence_required`, an ended one
   * `owner_locked`), and that store's `ownerNostr` must equal `kit.ownerNostr`, otherwise nothing
   * is written. Not needed on a machine without an owner item (step 6, importOwner).
   */
  readonly owner?: OwnerSession;
}

/** What an agent import leaves the owner to see. */
export interface ImportedAgentKeys {
  /**
   * The file KeyStore's new generated unlock code for the new `.alks` (04 §2.8), shown once; undefined
   * for the keychain backend.
   */
  readonly unlockCode: DisplayCode | undefined;
}

/**
 * The restore surface (04 §2.3.3 "Restore", D-115 C and E; M1-9i-b2). Owner flows only: the CLI's
 * `agentlink backup restore` †, which signs no owner action (D-115 E). Its authority is the kit plus
 * its recovery code typed at the prompt, never an argument, environment variable, file or pipe.
 *
 * - openRecoveryKit opens and checks the kit inside the backend (openRecoveryKit of
 *   @4thtech-io/crypto/keystore, with `options.expectedOwnerNostr` when an owner item exists) and
 *   returns a handle with public facts only. Every failure is one generic error, nothing is kept and
 *   every sink is discarded.
 * - importAgent and importOwner accept only a handle that an import control of the same
 *   implementation minted (checked by identity, so the CLI may open the kit before it picks the
 *   backend, 04 §2.3.3 steps 3 and 4); a look-alike is refused and a wiped handle is
 *   `keystore_closed`.
 * - importAgent writes every item of that agent at once (keychain items, or a new `.alks` under a
 *   new generated unlock code), with `storage-mark` as `{"v":1,"active":null}` (D-115 D). It never
 *   overwrites: any existing item of that agent, or an existing `.alks`, is `item_exists` and
 *   nothing is written (D-115 C). The store snapshot and `config.json` are the restore's to write.
 * - importOwner writes the owner seed as `ALKO` under a new generated owner code with the
 *   `owner-next` write, read-back and open protocol of `owner change-code` (04 §2.8) and returns
 *   that code for display. An existing owner item is `item_exists`; the recovery code never becomes
 *   the owner code.
 */
export interface KeyImportControl {
  openRecoveryKit(
    kit: RecoveryKitSource,
    code: RecoveryCodeSecret,
    options: OpenRecoveryKitOptions,
  ): Promise<RecoveryKitImport>;
  importAgent(
    kit: RecoveryKitImport,
    agentId: string,
    options?: ImportAgentOptions,
  ): Promise<ImportedAgentKeys>;
  importOwner(kit: RecoveryKitImport): Promise<DisplayCode>;
}

/**
 * The storage credential surface of one agent (04 §2.5.1 `storage.set`, §2.2 `s3:<id>`; 07 §5.2;
 * M1-9i-b2). Owner flows only (`agentlink storage connect` †, the local UI), paired with the agent's
 * KeyStore backend and the OwnerKeyStore whose sessions it accepts. `id` is the `storage.set` id: 8
 * CSPRNG bytes as 16 lowercase hex, new on every connect; any other form is refused.
 *
 * - writeCredential draws a new 16-byte salt, writes the item `s3:<id>` (encodeStorageCredentialItem)
 *   under the agent's inter-process lock (06 §6), reads it back, and returns its credentialDigest for
 *   the `storage.set` the owner then signs. An existing `s3:<id>` is `item_exists` and is left as it
 *   was. The credential is the caller's: it is copied, never kept, and the caller wipes it.
 * - removeCredential deletes `s3:<id>` under the same lock (after a newer connect is applied, or when
 *   a connect fails before its apply); an item that does not exist is not an error.
 * - No method returns the credential: the S3 adapter's credentials provider reads the item itself
 *   (M1-9i-a, M1-9i-c), and the values never become log fields (I-7).
 */
export interface StorageCredentialControl {
  writeCredential(owner: OwnerSession, id: string, credential: StorageCredential): Promise<string>;
  removeCredential(owner: OwnerSession, id: string): Promise<void>;
}

/**
 * What KeyEraseControl.eraseAgentKeys erases (U3-e; 04 §2.5 "Removing an agent" step 6). Ids and
 * the signed retirement only: no key, item value or path crosses it.
 */
export interface AgentKeyEraseRequest {
  /** The agent's EVM address, `0x` + 40 lowercase hex (04 §2.9); any other form is refused. */
  readonly agentId: string;
  /**
   * The `storage.set` ids whose `s3:<id>` items go (16 lowercase hex each; at most 64), read from
   * the agent's store before it is deleted. The backend adds the id its `storage-mark` names.
   */
  readonly storageIds: readonly string[];
  /**
   * The exact text of the agent's signed `agent.revoke` (the owner's revoked-list entry). The keys of
   * an agent are erased only once it is retired for good: a text that is not a verifying
   * `agent.revoke` for `agentId` refuses the erase before anything is deleted.
   */
  readonly revoke: string;
}

/**
 * Erasing one agent's keys when the owner removes it (U3-e; 04 §2.5 "Removing an agent" step 6;
 * D-138; I-2, I-4, I-7). An owner-flow surface like the controls above: the local app's removal
 * builds it, and no KeyStore, OwnerKeyStore, session or package entry reaches it.
 *
 * - The erase list is fixed and built inside from `agentId` alone: on the OS keychain the agent seed
 *   (account `<agentId>`) and the items `<agentId>:store-key`, `policy-version`, `receipts-kept`,
 *   `storage-mark` and `s3:<id>` for each id; on the file KeyStore the file `<agentId>.alks` and its
 *   temporary files. Nothing else is ever deleted: never an owner item (`owner`, `owner-passkey`,
 *   `owner-next`, `owner.alko`, `owner.alkp`) and never another agent's item; a request that names
 *   anything else is refused.
 * - It is idempotent: an item that is already gone is not an error, so a removal stopped part-way can
 *   run it again. It resolves only when every listed item is gone; otherwise it rejects with a fixed
 *   error, and the removal stops before the agent's folder is deleted.
 * - Errors are fixed sentences that never contain an input (I-7).
 */
export interface KeyEraseControl {
  eraseAgentKeys(request: AgentKeyEraseRequest): Promise<void>;
}

/**
 * A proof of owner presence (04 §2.5): what unlocks the owner key. It carries the secret that
 * unwraps the owner seed, so a process without the owner's input cannot make one that works.
 * The store wipes the bytes it is given, whether or not they unlock it, malformed proofs included.
 *
 * Real backends (M1-8a, M1-8c, M1-8f) collect presence themselves, at an interactive prompt or a
 * native or passkey dialog the agent does not control, and never accept it from an environment
 * variable, a file or agent-reachable code (D-54, IR-M1-1g-1 I-4). This type is the hand-off from
 * that prompt to the store, not an argument for MCP tools or other agent-facing code.
 */
export type OwnerPresence =
  /** The owner passphrase or generated owner code, typed at a prompt the agent does not control. */
  | { readonly kind: 'passphrase'; readonly secret: Uint8Array }
  /** The 32-byte WebAuthn PRF output of the owner passkey (04 §2.3), after the owner's gesture. */
  | { readonly kind: 'passkey-prf'; readonly prfOutput: Uint8Array };

/** The owner's public keys (04 §2.4 card fields). Public; available without presence. */
export interface OwnerPublicKeys {
  /** 20-byte EVM address. */
  readonly ownerEvm: Uint8Array;
  /** 32-byte BIP-340 x-only key. */
  readonly ownerNostr: Uint8Array;
  /** 32-byte X25519 key. */
  readonly ownerEnc: Uint8Array;
}

/** Options for OwnerKeyStore.unlock. */
export interface UnlockOptions {
  /** Session lifetime in milliseconds, 1 to OWNER_SESSION_MAX_TTL_MS. Default 60 s. */
  readonly ttlMs?: number;
}

/** Default owner-session lifetime (proposed: the local UI and the CLI sign within seconds). */
export const OWNER_SESSION_DEFAULT_TTL_MS = 60_000;
/** Longest owner-session lifetime a caller may ask for (proposed). */
export const OWNER_SESSION_MAX_TTL_MS = 300_000;

/**
 * The owner key store (04 §2.5). It signs nothing itself: owner signatures come only from an
 * OwnerSession, and unlock(presence) is the only way to get one. lock() and close() also cancel
 * an unlock that is still in flight: it fails with `owner_locked` instead of returning a session.
 */
export interface OwnerKeyStore {
  /** The owner's public keys. No presence needed. */
  getPublicKeys(): Promise<OwnerPublicKeys>;

  /**
   * Checks the presence proof and returns a short-lived session. Refuses a missing or malformed
   * proof (`presence_required`) and one that does not unlock the key (`presence_rejected`).
   */
  unlock(presence: OwnerPresence, options?: UnlockOptions): Promise<OwnerSession>;

  /** Ends every open session and wipes its key material. The store can be unlocked again. */
  lock(): Promise<void>;

  /** Locks, wipes everything the store holds, and refuses every later call. */
  close(): Promise<void>;
}

/**
 * A short-lived owner handle from OwnerKeyStore.unlock (04 §2.5, §3.1.1). After expiry, close() or the
 * store's lock() or close(), every method fails with `owner_locked`.
 *
 * As EnvelopeKeys it signs and opens the owner channel with the owner Nostr and enc keys: the
 * envelope `sig` and the seal of `approval`, `policy` and `revoke` (in the same gesture as the
 * SignedOwnerAction they carry), NIP-42 AUTH to DM relays, and reading the owner's copies. The owner
 * keys have epoch 0 only (owner-key rotation is P2): any other epoch is `epoch_unavailable`.
 * signNostr signs kinds 13 and 22242 only.
 *
 * A session is a bearer handle: whatever holds it can sign owner actions until it ends. The CLI and
 * the local UI keep it inside the owner flow and never pass it to MCP tools or other agent-reachable
 * code (I-4; IR-M1-1g-1 I-5).
 *
 * Expiry is enforced on a monotonic clock (`performance.now`) and on the wall clock, whichever ends
 * the session first, so setting the system clock back never extends a session (IR-M1-1g-1 L-1).
 */
export interface OwnerSession extends EnvelopeKeys {
  /** When the session ends, in milliseconds since the epoch (Date.now clock). For display only. */
  readonly expiresAt: number;

  /** True until the session expires or is closed or locked. */
  isActive(): boolean;

  /**
   * 04 §2.5.1: BIP-340 by the owner Nostr key over
   * taggedHash("agentlink/owner-action/v1", sha256(JCS(body))), as 128 lowercase hex. `body` is an
   * OwnerAction with `v` = 1 and `owner` equal to this owner's Nostr key (64 lowercase hex). Its
   * strict schema is @4thtech-io/types (M1-2a, M1-2b); verification is core (M1-7d).
   */
  signOwnerAction(body: JsonObject): Promise<string>;

  /**
   * EIP-712 by the owner EVM key: AgentCard `cardSig` (M1-1e), Registration (M1-1j). Canonical ECDSA,
   * `0x` + 130 lowercase hex (04 §2.4.1).
   */
  sign712(typedData: TypedData): Promise<string>;

  /** Ends this session now and wipes its key material. */
  close(): Promise<void>;
}
