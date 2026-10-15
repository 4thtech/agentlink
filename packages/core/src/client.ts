// AgentLinkClient (07 §2): the core's entry point. M1-7a wires the KeyStore, the Store, the
// StoreCipher and the ApprovalChannel, and adds identity and contacts. Transport, storage, chains and
// the envelope, policy and approval flows join with M1-7b onwards.
//
// I-4: the client holds the agent's KeyStore only. It never holds an OwnerKeyStore, never takes owner
// presence, and exports no key. Owner flows pass a session they unlocked themselves (identity.ts).
import type { KeyStore } from '@agentlink/crypto';
import { createLogger, type Logger } from '@agentlink/log';
import type { ApprovalChannel } from './approval-channel.js';
import { STORE_SCHEMA_VERSION } from './constants.js';
import { ContactBook } from './contacts.js';
import { EnvelopeService } from './envelopes.js';
import type { CoreContext } from './context.js';
import { CoreError } from './errors.js';
import { IdentityService, finishPendingRotation } from './identity.js';
import { OwnerActions, type PolicyVersionMark } from './owner-actions.js';
import { ApprovalService } from './approvals.js';
import { IdempotencyService } from './idempotency.js';
import { PairingService } from './pairing.js';
import { RequestsQueue } from './requests.js';
import { OutboxService } from './outbox.js';
import { SendService, type SendMessageInput, type SendMessageResult } from './send.js';
import type { TransportFactory } from './transport.js';
import { DeliveryAcks } from './acks.js';
import { InboxService } from './inbox.js';
import { policyLimits } from './policy-engine.js';
import { RevocationService } from './revocation.js';
import {
  SyncService,
  countRateTx,
  type CatchUpResult,
  type SyncInboxOptions,
  type SyncInboxResult,
} from './sync.js';
import type { Store, StoreCipher } from './store/store.js';

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
  readonly #send: SendService;
  readonly #sync: SyncService;

  private constructor(
    agentId: string,
    ctx: CoreContext,
    approvals: ApprovalChannel,
    policyMark: PolicyVersionMark | undefined,
    transport: TransportFactory | undefined,
    deliveryAcks: boolean,
  ) {
    this.agentId = agentId;
    this.identity = new IdentityService(ctx);
    this.contacts = new ContactBook(ctx);
    this.pairing = new PairingService(ctx, this.identity, this.contacts);
    this.ownerActions = new OwnerActions(ctx, this.identity, this.contacts, policyMark);
    const ownerActions = this.ownerActions;
    // M1-7h: revoke envelopes are applied or dropped (IR-M1-7h-1 F01), and the per-contact rate
    // limit is counted where the contact's envelope is stored (07 §3.2; IR-M1-7h-1 F02).
    this.envelopes = new EnvelopeService(ctx, this.identity, this.contacts, this.pairing, {
      revocation: new RevocationService(ctx, this.identity, this.contacts),
      rateLimit: {
        limit: async () => policyLimits(await ownerActions.loadPolicy()).rateLimitPerContactPerHour,
        countTx: countRateTx,
      },
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
    });
    this.inbox = new InboxService(ctx, this.contacts, this.requests);
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
    this.#sync = new SyncService(ctx, {
      envelopes: this.envelopes,
      outbox: this.outbox,
      ownerActions: this.ownerActions,
      inbox: this.inbox,
      acks: this.acks,
    });
  }

  /**
   * Pulls from the transport, stores, processes, and returns the new messages from contacts (07 §2;
   * M1-7h): fetch with the 48 h look-back, dedup, verify once, store, per-contact rate limit, then
   * 04 §3.1.1 steps 5 to 9 (`card-update` first) and, behind the flag, delivery acks.
   */
  syncInbox(options?: SyncInboxOptions): Promise<SyncInboxResult> {
    return this.#sync.syncInbox(options);
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
      options.transport,
      options.deliveryAcks === true,
    );
  }
}
