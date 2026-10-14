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
import { PairingService } from './pairing.js';
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

  private constructor(agentId: string, ctx: CoreContext, approvals: ApprovalChannel) {
    this.agentId = agentId;
    this.identity = new IdentityService(ctx);
    this.contacts = new ContactBook(ctx);
    this.pairing = new PairingService(ctx, this.identity, this.contacts);
    this.envelopes = new EnvelopeService(ctx, this.identity, this.contacts, this.pairing);
    this.approvals = approvals;
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
    return new AgentLinkClient(bundle.agentId, ctx, approvals);
  }
}
