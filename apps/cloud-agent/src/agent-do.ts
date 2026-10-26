// M2-3a: AgentDO, the cloud agent's Durable Object (08 §3.1; 03 §3; 06 §6; D-131).
//
// - Exactly one per deployment: the Worker reaches it only as `idFromName("agent")`, so it is the
//   single publisher of the agent (06 §6). It holds the store (core's schema plus the cloud-only rows,
//   07 §3.1), opened in the constructor under `blockConcurrencyWhile`.
// - Relay sync runs on alarms only (D-131 (f), spike S-5), every SYNC_INTERVAL_SECONDS (default 60):
//   the alarm re-arms itself first, so a failure below cannot stop the loop; a run is idempotent
//   (core's seen set, envelopeHash dedup and one store transaction per envelope, 07 §3.2) and opens
//   at most 5 relay sockets, which it closes before it returns. The per-relay cursor (`sync_cursors`)
//   and its 48 h look-back are transport-nostr's SyncEngine (07 §4.2); the end-of-stored-events wait
//   is the pass budget ALARM_SYNC_BUDGET_MS. No relay socket stays open between runs.
// - Keys: the Worker KeyStore (worker-keystore.ts) over AGENT_SEED or the sealed seed; the store key
//   is derived per run and dropped with the run's cipher. Nothing about a seed or key is logged,
//   stored unwrapped or sent anywhere (I-1, I-7). The Worker runs in the user's own Cloudflare
//   account (D-131), never a 4thTech service (I-3).
// - Autonomous actions are off (08 §3.4): a run only fetches, stores and processes inbound envelopes
//   under the owner's signed rules; it sends no delivery acks (deliveryAcks false) and nothing acts
//   on message content. Inbound content stays queued for the chat app or the owner.
// - The policy-version mark is the agent item `policy-version` (policy-mark.ts).
// - Seams for later cards, all unused by the Worker today: `provisionSeed` (M2-3f-1 `/setup`),
//   `syncNow` (M2-3b tools), PendingApprovalChannel (M2-3f-2), the FILES R2 binding (M2-3h).
import { DurableObject } from 'cloudflare:workers';
import { AgentLinkClient, CoreError, nostrTransport } from '@4thtech-io/core';
import { createLogger, type Logger } from '@4thtech-io/log';
import type { RelayConnector } from '@4thtech-io/transport-nostr';
import { PendingApprovalChannel } from './approval-channel.js';
import { syncIntervalSeconds } from './config.js';
import { DurableObjectStore } from './do-store.js';
import { CloudAgentError } from './errors.js';
import { durableObjectPolicyMark } from './policy-mark.js';
import { RunSocketBudget, WorkerRelayConnector } from './relay-connector.js';
import { openStoreCipher } from './store-cipher.js';
import {
  WorkerKeyStore,
  provisionSealedSeed,
  resolveSeedSource,
  type SeedSecrets,
} from './worker-keystore.js';

/** The Worker's bindings (wrangler.toml). Secrets are optional: which one is set is the deploy path. */
export interface CloudAgentEnv extends SeedSecrets {
  readonly AGENT: DurableObjectNamespace<AgentDO>;
  /** The user's R2 bucket for received files (08 §3.1 Storage; used from M2-3h). */
  readonly FILES: R2Bucket;
  readonly SYNC_INTERVAL_SECONDS?: string;
}

/** The one object of a deployment (06 §6: the single publisher). */
export const AGENT_OBJECT_NAME = 'agent';

/** 08 §3.4: autonomous actions are off; nothing in this package turns them on. */
export const AUTONOMOUS_ACTIONS = false;

/** The relay pass of one alarm run, including the wait for end-of-stored-events (spike S-5). */
export const ALARM_SYNC_BUDGET_MS = 10_000;

/** What one run did: counts and fixed codes only (I-7). */
export interface SyncRunSummary {
  readonly status: 'ok' | 'not_set_up' | 'busy' | 'failed';
  /** A fixed error code when `failed` (CloudAgentError or CoreError codes, or `unexpected`). */
  readonly code?: string;
  readonly stored: number;
  readonly partial: boolean;
  readonly sockets: number;
}

/** The fixed codes this object may write in a log line's `code` field. */
const LOG_CODES = ['sync_ok', 'sync_failed', 'alarm_rearmed', 'not_set_up'] as const;

function errorCode(error: unknown): string {
  if (error instanceof CloudAgentError) return error.code;
  if (error instanceof CoreError) return error.code;
  return 'unexpected';
}

export class AgentDO extends DurableObject<CloudAgentEnv> {
  #store: DurableObjectStore | undefined;
  #running: Promise<SyncRunSummary> | undefined;
  readonly #log: Logger;

  constructor(ctx: DurableObjectState, env: CloudAgentEnv) {
    super(ctx, env);
    this.#log = createLogger({ name: 'cloud-agent', codes: LOG_CODES });
    void ctx.blockConcurrencyWhile(async () => {
      this.#store = DurableObjectStore.open(ctx.storage);
      await this.#ensureAlarm();
    });
  }

  /** The relay connector of one run. Tests replace it with an in-memory relay. */
  protected createRelayConnector(): RelayConnector {
    return new WorkerRelayConnector();
  }

  /** Unix seconds. */
  protected now(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** The store, for subclasses (tests). Never handed to the Worker or a tool. */
  protected get store(): DurableObjectStore {
    if (this.#store === undefined) throw new CloudAgentError('store_failed');
    return this.#store;
  }

  /** True once the agent has an identity (the owner signed its first card, M2-3f-1). */
  async #setUp(): Promise<boolean> {
    return (await this.store.transaction((tx) => tx.count('identity'))) > 0;
  }

  #intervalMs(): number {
    return syncIntervalSeconds(this.env.SYNC_INTERVAL_SECONDS) * 1000;
  }

  /** Arms the alarm once the agent is set up and none is armed. Idempotent (restart, `start`). */
  async #ensureAlarm(): Promise<boolean> {
    if (!(await this.#setUp())) return false;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + this.#intervalMs());
    }
    return true;
  }

  /**
   * The alarm (spike S-5): re-arm first, then one sync run. The run never throws past here; a failure
   * is a fixed code in the log, and the next alarm is already armed.
   */
  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + this.#intervalMs());
    const summary = await this.#run();
    if (summary.status === 'not_set_up') {
      // Nothing to sync until setup: stop the loop; `start` arms it again.
      await this.ctx.storage.deleteAlarm();
    }
  }

  /** Arms the sync loop if the agent is set up. Returns whether it is armed. */
  async start(): Promise<boolean> {
    return this.#ensureAlarm();
  }

  /** One sync run now (M2-3b: the tools' catch-up). Same rules as an alarm run. */
  async syncNow(): Promise<SyncRunSummary> {
    return this.#run();
  }

  /**
   * Deploy-button path: generates and seals the agent seed once (08 §3.2). Only `/setup` (M2-3f-1)
   * calls it, after the setup code. Returns whether it created one; nothing about the seed.
   */
  async provisionSeed(): Promise<'created' | 'exists'> {
    return provisionSealedSeed(this.env, this.store);
  }

  /** Whether the agent is set up and its loop armed. Booleans only. */
  async health(): Promise<{ readonly setUp: boolean; readonly alarmArmed: boolean }> {
    return {
      setUp: await this.#setUp(),
      alarmArmed: (await this.ctx.storage.getAlarm()) !== null,
    };
  }

  #run(): Promise<SyncRunSummary> {
    if (this.#running !== undefined) {
      return Promise.resolve({ status: 'busy', stored: 0, partial: true, sockets: 0 });
    }
    const run = this.#sync().finally(() => {
      this.#running = undefined;
    });
    this.#running = run;
    return run;
  }

  async #sync(): Promise<SyncRunSummary> {
    let budget: RunSocketBudget | undefined;
    try {
      const store = this.store;
      const identity = await store.transaction((tx) => tx.select('identity')[0]);
      if (identity === undefined) {
        this.#log.info('cloud agent not set up', { code: 'not_set_up' });
        return { status: 'not_set_up', stored: 0, partial: false, sockets: 0 };
      }
      const keyStore = await WorkerKeyStore.open(resolveSeedSource(this.env, store), {
        agentId: identity.agent_id,
        keyEpoch: identity.key_epoch,
      });
      try {
        const cipher = await openStoreCipher(keyStore);
        try {
          budget = new RunSocketBudget(this.createRelayConnector());
          const client = await AgentLinkClient.create({
            keyStore,
            store,
            cipher,
            approvals: new PendingApprovalChannel(),
            clock: () => this.now(),
            logger: this.#log,
            policyMark: durableObjectPolicyMark(store),
            transport: nostrTransport({ connector: budget, addressCheck: 'platform' }),
            deliveryAcks: false,
          });
          try {
            const result = await client.syncInbox({ budgetMs: ALARM_SYNC_BUDGET_MS });
            this.#log.info('cloud agent sync', {
              code: 'sync_ok',
              stored: result.stored,
              partial: result.partial,
            });
            return {
              status: 'ok',
              stored: result.stored,
              partial: result.partial,
              sockets: budget.opened,
            };
          } finally {
            client.close();
          }
        } finally {
          budget?.closeAll();
          cipher.close();
        }
      } finally {
        await keyStore.close();
      }
    } catch (error) {
      const code = errorCode(error);
      // Only the fixed code: never the error object, whose text could name a value (I-7).
      this.#log.warn('cloud agent sync failed', { code: 'sync_failed', reason: code });
      budget?.closeAll();
      return { status: 'failed', code, stored: 0, partial: true, sockets: budget?.opened ?? 0 };
    }
  }
}
