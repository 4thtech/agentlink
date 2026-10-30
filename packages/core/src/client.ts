// AgentLinkClient (07 §2): the core's entry point. M1-7a wires the KeyStore, the Store, the
// StoreCipher and the ApprovalChannel, and adds identity and contacts. Transport, storage, chains and
// the envelope, policy and approval flows join with M1-7b onwards.
//
// I-4: the client holds the agent's KeyStore only. It never holds an OwnerKeyStore, never takes owner
// presence, and exports no key. Owner flows pass a session they unlocked themselves (identity.ts).
import type { KeyStore } from '@4thtech-io/crypto';
import { createLogger, type Logger } from '@4thtech-io/log';
import type { ApprovalChannel } from './approval-channel.js';
import { STORE_SCHEMA_VERSION } from './constants.js';
import { ContactBook, type ProofPackSigner } from './contacts.js';
import { EnvelopeService } from './envelopes.js';
import { nowOf, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import { IdentityService, finishPendingRotation } from './identity.js';
import { OwnStorage, type OwnStorageKeys } from './own-storage.js';
import { OwnerActions, type PolicyVersionMark, type ReceiptsKeptMark } from './owner-actions.js';
import { ApprovalService } from './approvals.js';
import { IdempotencyService } from './idempotency.js';
import { PairingService } from './pairing.js';
import { RequestsQueue } from './requests.js';
import { OutboxService } from './outbox.js';
import { AgentPause } from './agent-pause.js';
import { McpSession } from './mcp-session.js';
import { PublisherLease } from './publisher-lease.js';
import { SendService, type SendMessageInput, type SendMessageResult } from './send.js';
import type { TransportFactory } from './transport.js';
import { DeliveryAcks } from './acks.js';
import { AgentRemovalService } from './agent-removal.js';
import { CardUpdateSender, type CardUpdateSendResult } from './card-update.js';
import { AutoSaver, type AutoSavePause } from './files/auto-save.js';
import { FileFetcher, type FetchFileInput, type FetchFileResult } from './files/incoming.js';
import { savedNameOf } from './files/received.js';
import { saveReceivedFile, type SaveReceivedFileResult } from './files/save.js';
import type { FilesPlatform } from './files/platform.js';
import { FilesView } from './files/view.js';
import { FilesIoView, MessagesView } from './ui-messages.js';
import {
  FileLinks,
  type RequestFileLinkInput,
  type RequestFileLinkResult,
} from './files/refresh-link.js';
import { ActivityService } from './activity.js';
import {
  deleteExpiredFiles,
  deleteFilesOnReceipt,
  type ReceiptRetentionResult,
} from './files/retention.js';
import { InboxService } from './inbox.js';
import { policyLimits } from './policy-engine.js';
import { RevocationService } from './revocation.js';
import {
  SyncService,
  countRateTx,
  type CatchUpResult,
  type InboxSubscription,
  type SubscribeInboxOptions,
  type SyncInboxOptions,
  type SyncInboxResult,
} from './sync.js';
import type { Store, StoreCipher } from './store/store.js';
import {
  TermsService,
  type ProposeTermsInput,
  type ProposeTermsResult,
  type RecordLookup,
  type RespondToTermsInput,
  type RespondToTermsResult,
} from './terms-flow.js';
import { TermsInbound } from './terms-store.js';
import type { ProofsPlatform } from './proofs/platform.js';
import {
  ProofService,
  type AcknowledgeInput,
  type AcknowledgeResult,
  type ExportProofPackInput,
  type ExportProofPackResult,
  type NotarizeInput,
  type NotarizeResult,
  type ProofView,
  PROOF_LOG_CODES,
} from './proofs/service.js';

export interface AgentLinkClientOptions {
  /** The agent's KeyStore (04 §3.1.1): keychain or file backend (M1-8a, M1-8f), Worker (M2-3a). */
  readonly keyStore: KeyStore;
  readonly store: Store;
  /** Seals `enc` columns under the store key (07 §3.1; M1-8b). */
  readonly cipher: StoreCipher;
  readonly approvals: ApprovalChannel;
  /** Unix seconds. Default: the system clock. */
  readonly clock?: () => number;
  /** Default: the redacting logger (04 §8 rule 4, I-7). */
  readonly logger?: Logger;
  /**
   * The policy-version high-water mark, a KeyStore item (04 §2.5.1; M1-7d). Without it no policy.set
   * applies and a loaded policy always fails closed (G-6).
   */
  readonly policyMark?: PolicyVersionMark;
  /**
   * The receipts-kept marker, a KeyStore item (04 §2.2; 06 §3, D-109; M1-33a). Without it the
   * owner's choice to keep delivery receipts on from an older default is not remembered, so every
   * `policy.set` asks again.
   */
  readonly receiptsKept?: ReceiptsKeptMark;
  /**
   * The own-storage KeyStore items, `storage-mark` and the `credentialDigest` of `s3:<id>` (04 §2.2,
   * §2.5.1; M1-9i-a, D-115). Without them no `storage.set` or `storage.remove` applies, and
   * `ownStorage.load()` reads `broken` (fail closed).
   */
  readonly ownStorageKeys?: OwnStorageKeys;
  /**
   * The relay transport (07 §4.1; M1-7k): `nostrTransport({connector, addressCheck, nip11})` with the
   * runtime's relay I/O (packages/node supplies it). Without one the client cannot send or publish
   * (`transport_unavailable`); reading the store still works.
   */
  readonly transport?: TransportFactory;
  /**
   * Delivery acknowledgements (02 F-23, P1; M1-7h): when true, `syncInbox` sends a signed
   * "received" `ack` for each new message from a contact. Default false.
   */
  readonly deliveryAcks?: boolean;
  /**
   * The verified on-chain records this agent knows (M1-7g, M1b): lets a commitment see whether the
   * answered envelope is recorded. Without it, no record is known.
   */
  readonly records?: RecordLookup;
  /**
   * The https origins of the encrypted drop (D-48), so an inbox page shows a received file stored
   * there as `drop` and any other URL as `own` (06 §2.2 `FileInfo.delivery`). Default: none.
   */
  readonly dropOrigins?: readonly string[];
  /**
   * The files platform (M1-7f; files/platform.ts): allowed-folder realpaths, own storage, the drop's
   * SSRF-safe fetch, the SSRF-safe download and the inbox folder. Without it, a send with files and
   * `fetchFile` fail with `files_unavailable`; messages work as before.
   */
  readonly files?: FilesPlatform;
  /**
   * W4-AUTO-SAVE (D-142): the agent's pause state for the automatic save (W4-PAUSE wires it, D-143).
   * Absent: never paused.
   */
  readonly autoSavePause?: AutoSavePause;
  /**
   * The chains for proofs (M1-7g; 07 §6.2, §6.3): read clients, chain-state ports and submitters,
   * built by the runtime from the shipped chain list. Without it, the proof calls return
   * `PROOFS_UNAVAILABLE` and `proof` envelopes are stored but not acted on.
   */
  readonly proofs?: ProofsPlatform;
}

const systemClock = (): number => Math.floor(Date.now() / 1000);

export class AgentLinkClient {
  /** The agent's ID: its EVM address, derived from the seed (04 §2.9). */
  readonly agentId: string;
  readonly identity: IdentityService;
  readonly contacts: ContactBook;
  /** Envelope build, receive and processing (M1-7b; 04 §3.1.1). */
  readonly envelopes: EnvelopeService;
  /** Invites and pairing (M1-7c; 04 §3.6, §3.6.1). Inbound pairing runs in envelopes.processReceived. */
  readonly pairing: PairingService;
  readonly approvals: ApprovalChannel;
  /** Owner-signed actions and the signed policy (M1-7d; 04 §2.5.1). Authority is the signature. */
  readonly ownerActions: OwnerActions;
  /** Own storage as the owner signed it: `none`, `ready` or `broken` (M1-9i-a; 07 §3.4, §5.6). */
  readonly ownStorage: OwnStorage;
  /** Approval requests and their one use (M1-7e; 04 §3.4.1, 06 §2.5). Decides nothing. */
  readonly approvalService: ApprovalService;
  /** The requests queue for unknown senders: count, list and ignore (M1-7e; 07 §3.2). */
  readonly requests: RequestsQueue;
  /** `clientRequestId` idempotency (M1-7e; 06 §1 rule 6, 07 §3.3). */
  readonly idempotency: IdempotencyService;
  /** The outbox: staged envelopes, delivery passes and retries (M1-7k; 07 §3.2, §4.2). */
  readonly outbox: OutboxService;
  /**
   * W4-PAUSE (D-143 (5); 06 §6 "Paused agents"; 07 §3.2 `agent_pause`): the owner's pause of this
   * agent. Only the app host's pause kind calls `pause()`; only a verified `agent.resume` ends it.
   */
  readonly pause: AgentPause;
  /** Inbox items with their untrusted-content metadata, and store-only counts (M1-7h; 06 §2.1, §4). */
  readonly inbox: InboxService;
  /** Delivery acknowledgements (02 F-23; M1-7h): behind the `deliveryAcks` flag. */
  readonly acks: DeliveryAcks;
  /** The `card-update` sender (M1-4d-f; 04 §3.4.1): the current card to contacts that lack it. */
  readonly cardUpdates: CardUpdateSender;
  /**
   * U3-e: removing this agent from the local app (04 §2.5): what removal reads first, and the
   * owner-signed `revoke` carriers to its contacts. The local app's removal only; never an MCP tool.
   */
  readonly removal: AgentRemovalService;
  /**
   * Terms and commitments (M1-32; 06 §2.2a, 04 §3.4.2): propose, respond, the negotiations, the
   * commitment card, and the deferred-receipt lookup and part claim for M1-7g.
   */
  readonly terms: TermsService;
  /**
   * Notarize, receipts, proof envelopes, replacement and the proof-pack export (M1-7g).
   */
  readonly proofs: ProofService;
  /** The allowed folders as the rules name them and as resolved (M1-11r-a, the local UI). Read-only. */
  readonly files: FilesView;
  /** refresh-link (M1-7f-3; 04 §4): requests, and answers after each processing pass. */
  readonly fileLinks: FileLinks;
  /** The local app's Messages (MSG-FILES-IO-a): read-only, store only, never a read mark. */
  readonly messages: MessagesView;
  /** The local app's Files Received and Sent (MSG-FILES-IO-a): read-only, store only. */
  readonly filesIo: FilesIoView;
  /**
   * W4-AUTO-SAVE (D-142, 04 §4.1): received files saved automatically. The background loop of the
   * lease holder calls `run`; the local app reads and dismisses the one-time notice. No MCP tool.
   */
  readonly autoSave: AutoSaver;
  /** The activity feed (M1-11r-a, M1-11r-d; the local UI): messages, files, approvals, proofs, blocks, rules. */
  readonly activity: ActivityService;
  readonly #send: SendService;
  readonly #sync: SyncService;
  readonly #files: FileFetcher;
  readonly #filesPlatform: FilesPlatform | undefined;
  /** Where the next delete-on-receipt pass starts (M1-1g-h; files/retention.ts). */
  readonly #retentionCursor: { after: string | null } = { after: null };
  readonly #ctx: CoreContext;

  private constructor(
    agentId: string,
    ctx: CoreContext,
    approvals: ApprovalChannel,
    policyMark: PolicyVersionMark | undefined,
    receiptsKept: ReceiptsKeptMark | undefined,
    transport: TransportFactory | undefined,
    deliveryAcks: boolean,
    records: RecordLookup | undefined,
    dropOrigins: readonly string[],
    files: FilesPlatform | undefined,
    proofs: ProofsPlatform | undefined,
    ownStorageKeys: OwnStorageKeys | undefined,
    autoSavePause?: AutoSavePause,
  ) {
    this.agentId = agentId;
    this.#ctx = ctx;
    this.identity = new IdentityService(ctx);
    this.contacts = new ContactBook(ctx);
    this.pause = new AgentPause({ store: ctx.store, now: () => nowOf(ctx) });
    // W4-PAUSE (IR-W4-PAUSE-1): invites refuse while paused (CLI and app routes alike).
    this.pairing = new PairingService(ctx, this.identity, this.contacts, files?.drop, this.pause);
    this.ownerActions = new OwnerActions(
      ctx,
      this.identity,
      this.contacts,
      policyMark,
      receiptsKept,
      ownStorageKeys,
    );
    this.ownStorage = new OwnStorage(ctx, this.identity, ownStorageKeys);
    const ownerActions = this.ownerActions;
    // M1-7h: revoke envelopes are applied or dropped (IR-M1-7h-1 F01), and the per-contact rate
    // limit is counted where the contact's envelope is stored (07 §3.2; IR-M1-7h-1 F02).
    this.envelopes = new EnvelopeService(ctx, this.identity, this.contacts, this.pairing, {
      revocation: new RevocationService(ctx, this.identity, this.contacts),
      rateLimit: {
        limit: async () => policyLimits(await ownerActions.loadPolicy()).rateLimitPerContactPerHour,
        countTx: countRateTx,
      },
      // M1-32: the negotiation chain runs on receive, from this agent's own store (04 §3.4).
      terms: new TermsInbound(ctx, async () => (await this.identity.get())?.agentId),
    });
    this.approvals = approvals;
    this.idempotency = new IdempotencyService(ctx);
    this.approvalService = new ApprovalService(
      ctx,
      this.identity,
      this.ownerActions,
      approvals,
      this.idempotency,
    );
    this.requests = new RequestsQueue(ctx);
    // W4-PAUSE: nothing is published while the agent is paused (queued rows wait).
    this.outbox = new OutboxService(ctx, this.identity, this.contacts, transport, this.pause);
    this.removal = new AgentRemovalService(ctx, {
      identity: this.identity,
      contacts: this.contacts,
      outbox: this.outbox,
    });
    this.#send = new SendService(ctx, {
      identity: this.identity,
      contacts: this.contacts,
      envelopes: this.envelopes,
      ownerActions: this.ownerActions,
      idempotency: this.idempotency,
      outbox: this.outbox,
      ...(files === undefined ? {} : { files }),
    });
    this.#files = new FileFetcher(ctx, files, () => ownerActions.loadPolicy());
    this.autoSave = new AutoSaver(ctx, this.#files, () => ownerActions.loadPolicy(), {
      ...(autoSavePause === undefined ? {} : { pause: autoSavePause }),
    });
    this.#filesPlatform = files;
    this.files = new FilesView(ctx, files, () => ownerActions.loadPolicy());
    this.fileLinks = new FileLinks(
      ctx,
      {
        identity: this.identity,
        envelopes: this.envelopes,
        outbox: this.outbox,
        ownerActions: this.ownerActions,
      },
      files,
    );
    this.activity = new ActivityService(ctx, this.contacts);
    this.messages = new MessagesView(ctx, this.contacts);
    // MSG-FILES-IO-d: "saved as" from the sealed files.saved_name; a value that does not open shows
    // that one item without it (FilesIoView catches per row).
    this.filesIo = new FilesIoView(ctx, this.contacts, {
      savedName: (row) => savedNameOf(ctx, row),
    });
    this.inbox = new InboxService(ctx, this.contacts, this.requests, { dropOrigins });
    this.proofs = new ProofService(
      ctx,
      {
        identity: this.identity,
        contacts: this.contacts,
        envelopes: this.envelopes,
        outbox: this.outbox,
        ownerActions: this.ownerActions,
        approvals: this.approvalService,
        terms: () => this.terms,
      },
      proofs,
    );
    this.terms = new TermsService(ctx, {
      identity: this.identity,
      contacts: this.contacts,
      envelopes: this.envelopes,
      outbox: this.outbox,
      ownerActions: this.ownerActions,
      approvals: this.approvalService,
      idempotency: this.idempotency,
      // The verified records this agent knows (M1-7g); a caller-supplied lookup replaces it.
      records: records ?? this.proofs,
      // Records for `notarize` on the terms tools (M1-9d-3), only with the proof platform.
      ...(proofs === undefined ? {} : { recorder: this.proofs }),
    });
    this.acks = new DeliveryAcks(
      ctx,
      {
        identity: this.identity,
        envelopes: this.envelopes,
        outbox: this.outbox,
        ownerActions: this.ownerActions,
      },
      deliveryAcks,
    );
    this.cardUpdates = new CardUpdateSender(ctx, {
      identity: this.identity,
      envelopes: this.envelopes,
      outbox: this.outbox,
      ownerActions: this.ownerActions,
    });
    this.#sync = new SyncService(ctx, {
      envelopes: this.envelopes,
      outbox: this.outbox,
      ownerActions: this.ownerActions,
      inbox: this.inbox,
      acks: this.acks,
      proofs: this.proofs,
      fileLinks: this.fileLinks,
    });
  }

  /**
   * Pulls from the transport, stores, processes, and returns the new messages from contacts (07 §2;
   * M1-7h): fetch with the 48 h look-back, dedup, verify once, store, per-contact rate limit, then
   * 04 §3.1.1 steps 5 to 9 (`card-update` first) and, behind the flag, delivery acks.
   */
  async syncInbox(options?: SyncInboxOptions): Promise<SyncInboxResult> {
    await this.pause.assertRunning();
    const result = await this.#sync.syncInbox(options);
    // M1-4d-f: announce the current card to contacts that lack it (after a rotation, also one made
    // without a transport). Best effort: it never fails the sync, and the next pass tries again.
    await this.cardUpdates.sendPending().catch(() => {
      this.#ctx.log.warn('card updates not sent');
    });
    // M1-1g-h: delete on receipt, per `files.deleteAfter`. Best effort, as above.
    await this.deleteFilesOnReceipt().catch(() => {
      this.#ctx.log.warn('delete on receipt not run');
    });
    // M1-7f-2: retention at expiry on both sides. Best effort, as above.
    await this.deleteExpiredFiles().catch(() => {
      this.#ctx.log.warn('expiry retention not run');
    });
    return result;
  }

  /**
   * Retention at expiry (M1-7f-2; 04 §4, 06 §3, D-98), under every policy: for each file whose
   * `expiresAt` has passed, the sender deletes the stored object (the drop with a DELETE signed at
   * the upload epoch) and its `files` row with the sealed file key; the receiver deletes its own
   * row, after which the file cannot be opened. Nothing is deleted before `expiresAt` (I-9).
   * `syncInbox` runs it; idempotent, and a failed delete is retried on the next pass.
   */
  deleteExpiredFiles(): Promise<ReceiptRetentionResult> {
    return deleteExpiredFiles(this.#ctx, this.#filesPlatform);
  }

  /**
   * Delete on receipt (M1-1g-h; 04 §4, 06 §3, 07 §5.4): with `files.deleteAfter: receipt` in the
   * effective policy, deletes the stored object of every file of a sent envelope whose DELIVERED
   * receipt the chain shows and that was itself sent under `receipt` (M1-1g-i: the policy at send
   * time, kept per file), the drop with a DELETE signed at the upload epoch. Under `expiry` (the
   * default, and always while the policy fails closed) it does nothing. `syncInbox` runs it;
   * idempotent, and a failed delete is retried on the next pass.
   */
  async deleteFilesOnReceipt(): Promise<ReceiptRetentionResult> {
    const limits = policyLimits(await this.ownerActions.loadPolicy());
    if (limits.deleteAfter !== 'receipt') return { deleted: 0, failed: 0 };
    return deleteFilesOnReceipt(this.#ctx, this.#filesPlatform, {
      delivered: (envelopeId) => this.proofs.deliveredReceiptOnChain(envelopeId),
      cursor: this.#retentionCursor,
    });
  }

  /**
   * Sends the current card in a `card-update` (with `cardSig`, `cardAgentSig` and `cardPop`) to every
   * active contact that does not hold it yet (M1-4d-f; 04 §2.6, §2.9, §3.4.1). The owner flow calls
   * it after a rotation; `syncInbox` also runs it. Idempotent.
   */
  async sendCardUpdates(): Promise<CardUpdateSendResult> {
    await this.pause.assertRunning();
    return this.cardUpdates.sendPending();
  }

  /**
   * A live relay subscription for the MCP background loop (M1-9s; 06 §6, 07 §4.1): new envelopes
   * on the own relays are stored and processed as they arrive, through the same receive path as
   * `syncInbox` (dedup by gift-wrap id and envelopeHash, one store transaction, rate limit). Only
   * the publisher-lease holder opens one; close it on lease loss and before the store closes.
   */
  async subscribeInbox(options?: SubscribeInboxOptions): Promise<InboxSubscription> {
    await this.pause.assertRunning();
    return this.#sync.subscribeInbox(options);
  }

  /**
   * The fetch-only catch-up for read-only callers (M1-7h addendum, D-73; 06 §2.0): fetches and
   * stores envelopes and counts them by sender. Processes nothing: no handshake, ack, card update,
   * receipt or read mark.
   */
  async catchUp(options?: SyncInboxOptions): Promise<CatchUpResult> {
    await this.pause.assertRunning();
    return this.#sync.catchUp(options);
  }

  /**
   * Sends a Talk message (`text | note | request | delivery`) to a paired contact (07 §2; 06 §2.2;
   * M1-7k): policy check, envelope, one gift wrap per distinct recipient key, the envelope and its
   * outbox rows in one store transaction, then the first publish. Idempotent under
   * `clientRequestId` (06 §1 rule 6).
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    // W4-PAUSE: before the idempotency claim, so no result is kept and the same call works later.
    await this.pause.assertRunning();
    return this.#send.send(input);
  }

  /**
   * Fetches one file of a received message into the inbox folder (06 §2.3 `agentlink_fetch_file`;
   * 04 §4; M1-7f): the size cap first, the SSRF-safe download capped at the exact ALF1 length, both
   * hashes verified before the file gets its (sanitised, never overwriting) name (D-84). Never
   * executes anything.
   */
  async fetchFile(input: FetchFileInput): Promise<FetchFileResult> {
    await this.pause.assertRunning();
    return this.#files.fetch(input);
  }

  /** W4-FILES-SAVE (IR L2): saves in flight per item, so one file is never saved twice at once. */
  readonly #savesInFlight = new Map<string, Promise<unknown>>();

  /**
   * W4-FILES-SAVE (04 §2.5.1 `file.save`; 08 §1): saves one received file from the local app with
   * an owner-signed `file.save` (files/save.ts): only that op, verified and nonce-recorded by
   * `ownerActions.apply`, then the same fetch as `fetchFile` with the signed envelope and index. A file
   * already saved is answered before anything is applied. Never a path in the result.
   */
  async saveReceivedFile(signed: unknown): Promise<SaveReceivedFileResult> {
    // W4-PAUSE (08 §1 "What stops"): no file fetch while paused, refused before the nonce is used.
    await this.pause.assertRunning();
    return saveReceivedFile(
      {
        ownerActions: this.ownerActions,
        filesIo: this.filesIo,
        fetcher: this.#files,
        inFlight: this.#savesInFlight,
      },
      signed,
    );
  }

  /**
   * Asks the contact that sent a stored file for a fresh link (M1-7f-3; 04 §4 "Delivery", 07 §5.2):
   * a `request` envelope `{kind: "refresh-link", envelopeId, fileIndex}`. The sender's core answers
   * when it is online, from its own storage and never past the file's `expiresAt`; the answer
   * replaces this file's link, so `fetchFile` works again. Refused locally once retention has passed
   * (`LINK_EXPIRED`) and for an inline file (`NOT_REFRESHABLE`).
   */
  async requestFileLink(input: RequestFileLinkInput): Promise<RequestFileLinkResult> {
    await this.pause.assertRunning();
    return this.fileLinks.request(input);
  }

  /**
   * W4-PAUSE (06 §6 "Paused agents"): true while the owner has paused this agent, and when its pause
   * row cannot be read (fail closed). Every process checks it before a tool call, a command and a
   * loop step.
   */
  paused(): Promise<boolean> {
    return this.pause.paused();
  }

  /**
   * A new handle on the agent's publisher lease (07 §3.2; 06 §6; M1-7k-b), with its own random
   * holder ID. Only a long-running server process (`agentlink mcp`, M1-9r) creates one, once at
   * start, and calls `take` every 20 s; CLI commands never do. Creating it writes nothing.
   */
  publisherLease(): PublisherLease {
    return new PublisherLease({ store: this.#ctx.store, now: this.#ctx.now });
  }

  /**
   * W4-LIVE-STATUS (D-143; 06 §6 "MCP session heartbeat"): this process's MCP session row, with its
   * own random session ID. Only `agentlink mcp` creates one, once at start, and starts it when it
   * answers `initialize`; creating it writes nothing. Status, not authority (07 §3.2).
   */
  mcpSession(options: {
    readonly pid: number;
    readonly pidAlive?: (pid: number) => boolean;
  }): McpSession {
    return new McpSession({
      store: this.#ctx.store,
      now: this.#ctx.now,
      agentId: this.agentId,
      pid: options.pid,
      ...(options.pidAlive === undefined ? {} : { pidAlive: options.pidAlive }),
    });
  }

  /**
   * The proof pack `signer` card for an envelope sent from `from` (07 §8; M1-4d-d, D-102): this
   * agent's own card or a contact's, with its proof of possession when stored. For
   * `exportProofPack` (M1-7g). Own cards of earlier key epochs are kept (M1-4d-f); undefined for an
   * unknown key, a contact's earlier-epoch key, or an own epoch whose card is not stored.
   */
  proofSigner(from: string): Promise<ProofPackSigner | undefined> {
    return this.contacts.proofSigner(from);
  }

  /**
   * Sends an `offer` (07 §2 `proposeTerms`; 06 §2.2a `agentlink_propose_terms`; M1-32): the core
   * fills `termsId`, `version`, `parties`, `previousTermsHash` and `termsHash` from its store.
   */
  async proposeTerms(input: ProposeTermsInput): Promise<ProposeTermsResult> {
    await this.pause.assertRunning();
    return this.terms.propose(input);
  }

  /**
   * Answers an offer, or their accept of our offer (07 §2 `respondToTerms`; 06 §2.2a; M1-32):
   * `accept` is a commitment under one approval per agreement (04 §3.4.2).
   */
  async respondToTerms(input: RespondToTermsInput): Promise<RespondToTermsResult> {
    await this.pause.assertRunning();
    const result = await this.terms.respond(input);
    // An accept whose offer is already recorded: its ACCEPTED receipt is signed now, under the
    // same approval (07 §2.1 step 3; D-55). Never fails the call.
    if (result.status === 'ok') {
      // The proof flow's fixed codes: any other `code` value is redacted (I-7).
      const log = this.#ctx.log.withCodes(PROOF_LOG_CODES);
      try {
        await this.proofs.runDeferredReceipts();
      } catch {
        log.warn('deferred receipt failed', { code: 'deferred_error' });
      }
      // The result says what happened to the receipt in that run, not the state before it
      // (M1-7g-f): the part is read again. Never fails the call.
      if (result.receipt !== undefined) {
        try {
          const status = await this.terms.receiptStatus(input.envelopeId);
          if (status !== undefined && status !== result.receipt.status) {
            return { ...result, receipt: { ...result.receipt, status } };
          }
        } catch {
          log.warn('deferred receipt failed', { code: 'deferred_error' });
        }
      }
    }
    return result;
  }

  /**
   * Records an envelope this agent sent (07 §2 `notarize`; 06 §2.4 `agentlink_notarize`; M1-7g):
   * kind from the payload, automatic chain selection, policy `proofs.*` and budget, then the
   * Record and, once on-chain, the `proof` envelope with the salt to the recipient.
   */
  async notarize(input: NotarizeInput): Promise<NotarizeResult> {
    await this.pause.assertRunning();
    return this.proofs.notarize(input);
  }

  /**
   * An explicit receipt on a record received (07 §2 `acknowledge`; 06 §2.4): `opened` only when
   * the user asked; `accepted` / `rejected` are commitments (`commitments.accept`, D-31).
   */
  async acknowledge(input: AcknowledgeInput): Promise<AcknowledgeResult> {
    await this.pause.assertRunning();
    return this.proofs.acknowledge(input);
  }

  /** The proof of an envelope or record (07 §2 `getProof`; 06 §2.4). Read-only. */
  getProof(input: {
    readonly envelopeId?: string;
    readonly recordId?: string;
  }): Promise<ProofView | undefined> {
    return this.proofs.getProof(input);
  }

  /**
   * The 07 §8 proof pack of an own record (07 §2 `exportProofPack`; 06 §2.4). It exports a pack,
   * never a key: the content key only with the owner's approval (`proofs.allowKeyDisclosure`), and
   * then with the envelope; the recipient and salt only on request. The client guard test lists it
   * as the one approved `export*` name.
   */
  exportProofPack(input: ExportProofPackInput): Promise<ExportProofPackResult> {
    return this.proofs.exportProofPack(input);
  }

  /**
   * Ends any live subscription and closes the relay connections of this client's transport
   * (idempotent; a no-op without one).
   * One-shot callers (the CLI commands) call it when they are done so the process can end. It
   * closes neither the store nor the KeyStore: those belong to whoever opened them.
   */
  close(): void {
    this.#sync.closeSubscriptions();
    this.outbox.closeTransport();
  }

  /**
   * Opens a client over a store. Refuses a store of another schema version (07 §3.7: forward
   * migrations only; none exist yet) and a store whose identity belongs to other keys (04 §2.9: a
   * mismatch is an error, never a new identity).
   */
  static async create(options: AgentLinkClientOptions): Promise<AgentLinkClient> {
    const { keyStore, store, cipher, approvals } = options;
    if (store.schemaVersion > STORE_SCHEMA_VERSION) {
      throw new CoreError(
        'store_schema_newer',
        'This store was written by a newer version of AgentLink. Update AgentLink to open it.',
      );
    }
    if (store.schemaVersion < STORE_SCHEMA_VERSION) {
      throw new CoreError(
        'store_schema_older',
        'This store needs a migration that is not available.',
      );
    }
    const bundle = await keyStore.getPublicBundle();
    const row = await store.transaction((tx) => tx.select('identity')[0]);
    if (row !== undefined) {
      if (row.agent_id !== bundle.agentId) {
        throw new CoreError(
          'identity_mismatch',
          'The keys do not belong to the agent in this store.',
        );
      }
      // The KeyStore is at the stored epoch, or one ahead while a rotation is unfinished (M1-1g-d).
      // One ahead: a pending card the owner signed for exactly these keys finishes it below;
      // without one the client opens but must not send: identity.sendState() is
      // `rotation_pending` and assertCanSend() refuses (IR-M1-7a-1 L-1, Q1). Anything else is refused.
      if (bundle.keyEpoch !== row.key_epoch && bundle.keyEpoch !== row.key_epoch + 1) {
        throw new CoreError('key_epoch_mismatch', 'The key store epoch does not match this agent.');
      }
    }
    const ctx: CoreContext = {
      keyStore,
      store,
      cipher,
      now: options.clock ?? systemClock,
      log: options.logger ?? createLogger({ name: 'core' }),
    };
    if (row !== undefined) await finishPendingRotation(ctx);
    return new AgentLinkClient(
      bundle.agentId,
      ctx,
      approvals,
      options.policyMark,
      options.receiptsKept,
      options.transport,
      options.deliveryAcks === true,
      options.records,
      options.dropOrigins ?? [],
      options.files,
      options.proofs,
      options.ownStorageKeys,
      options.autoSavePause,
    );
  }
}
