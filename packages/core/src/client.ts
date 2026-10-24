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
import type { CoreContext } from './context.js';
import { CoreError } from './errors.js';
import { IdentityService, finishPendingRotation } from './identity.js';
import { OwnStorage, type OwnStorageKeys } from './own-storage.js';
import { OwnerActions, type PolicyVersionMark, type ReceiptsKeptMark } from './owner-actions.js';
import { ApprovalService } from './approvals.js';
import { IdempotencyService } from './idempotency.js';
import { PairingService } from './pairing.js';
import { RequestsQueue } from './requests.js';
import { OutboxService } from './outbox.js';
import { PublisherLease } from './publisher-lease.js';
import { SendService, type SendMessageInput, type SendMessageResult } from './send.js';
import type { TransportFactory } from './transport.js';
import { DeliveryAcks } from './acks.js';
import { CardUpdateSender, type CardUpdateSendResult } from './card-update.js';
import { FileFetcher, type FetchFileInput, type FetchFileResult } from './files/incoming.js';
import type { FilesPlatform } from './files/platform.js';
import { FilesView } from './files/view.js';
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
  /** Inbox items with their untrusted-content metadata, and store-only counts (M1-7h; 06 §2.1, §4). */
  readonly inbox: InboxService;
  /** Delivery acknowledgements (02 F-23; M1-7h): behind the `deliveryAcks` flag. */
  readonly acks: DeliveryAcks;
  /** The `card-update` sender (M1-4d-f; 04 §3.4.1): the current card to contacts that lack it. */
  readonly cardUpdates: CardUpdateSender;
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
  ) {
    this.agentId = agentId;
    this.#ctx = ctx;
    this.identity = new IdentityService(ctx);
    this.contacts = new ContactBook(ctx);
    this.pairing = new PairingService(ctx, this.identity, this.contacts);
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
    this.outbox = new OutboxService(ctx, this.identity, this.contacts, transport);
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
  sendCardUpdates(): Promise<CardUpdateSendResult> {
    return this.cardUpdates.sendPending();
  }

  /**
   * A live relay subscription for the MCP background loop (M1-9s; 06 §6, 07 §4.1): new envelopes
   * on the own relays are stored and processed as they arrive, through the same receive path as
   * `syncInbox` (dedup by gift-wrap id and envelopeHash, one store transaction, rate limit). Only
   * the publisher-lease holder opens one; close it on lease loss and before the store closes.
   */
  subscribeInbox(options?: SubscribeInboxOptions): Promise<InboxSubscription> {
    return this.#sync.subscribeInbox(options);
  }

  /**
   * The fetch-only catch-up for read-only callers (M1-7h addendum, D-73; 06 §2.0): fetches and
   * stores envelopes and counts them by sender. Processes nothing: no handshake, ack, card update,
   * receipt or read mark.
   */
  catchUp(options?: SyncInboxOptions): Promise<CatchUpResult> {
    return this.#sync.catchUp(options);
  }

  /**
   * Sends a Talk message (`text | note | request | delivery`) to a paired contact (07 §2; 06 §2.2;
   * M1-7k): policy check, envelope, one gift wrap per distinct recipient key, the envelope and its
   * outbox rows in one store transaction, then the first publish. Idempotent under
   * `clientRequestId` (06 §1 rule 6).
   */
  sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    return this.#send.send(input);
  }

  /**
   * Fetches one file of a received message into the inbox folder (06 §2.3 `agentlink_fetch_file`;
   * 04 §4; M1-7f): the size cap first, the SSRF-safe download capped at the exact ALF1 length, both
   * hashes verified before the file gets its (sanitised, never overwriting) name (D-84). Never
   * executes anything.
   */
  fetchFile(input: FetchFileInput): Promise<FetchFileResult> {
    return this.#files.fetch(input);
  }

  /**
   * Asks the contact that sent a stored file for a fresh link (M1-7f-3; 04 §4 "Delivery", 07 §5.2):
   * a `request` envelope `{kind: "refresh-link", envelopeId, fileIndex}`. The sender's core answers
   * when it is online, from its own storage and never past the file's `expiresAt`; the answer
   * replaces this file's link, so `fetchFile` works again. Refused locally once retention has passed
   * (`LINK_EXPIRED`) and for an inline file (`NOT_REFRESHABLE`).
   */
  requestFileLink(input: RequestFileLinkInput): Promise<RequestFileLinkResult> {
    return this.fileLinks.request(input);
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
  proposeTerms(input: ProposeTermsInput): Promise<ProposeTermsResult> {
    return this.terms.propose(input);
  }

  /**
   * Answers an offer, or their accept of our offer (07 §2 `respondToTerms`; 06 §2.2a; M1-32):
   * `accept` is a commitment under one approval per agreement (04 §3.4.2).
   */
  async respondToTerms(input: RespondToTermsInput): Promise<RespondToTermsResult> {
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
  notarize(input: NotarizeInput): Promise<NotarizeResult> {
    return this.proofs.notarize(input);
  }

  /**
   * An explicit receipt on a record received (07 §2 `acknowledge`; 06 §2.4): `opened` only when
   * the user asked; `accepted` / `rejected` are commitments (`commitments.accept`, D-31).
   */
  acknowledge(input: AcknowledgeInput): Promise<AcknowledgeResult> {
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
    );
  }
}
