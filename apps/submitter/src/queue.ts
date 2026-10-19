// The per-chain submission queue (07 §7; M1-10a): one Durable Object per served chain, named
// `chain:<chainId>`. It owns the gas wallet's transaction nonces, so every send on a chain goes
// through one instance and the engine's lock (per-chain nonce serialisation), and it polls sent
// transactions with an alarm until nothing is in flight.
//
// Storage, one key per entry (each under the 128 KiB value limit): `i:<item id>` items in flight or
// recently finished (the signed item itself, which a resubmission needs; never an IP), `t:<hash>`
// transactions, `meta` the nonce and the signers cooling off. Finished entries are deleted after the
// retention period.
import { DurableObject } from 'cloudflare:workers';
import type {
  Hex,
  StatusResponse,
  SubmitItem,
  SubmitItemResult,
  SubmitterChain,
} from '@4thtech-io/chain';
import { readConfig } from './config.js';
import {
  emptyQueueState,
  pollQueue,
  queueDepth,
  submitItems,
  txStatus,
  type ItemState,
  type QueueState,
  type TxState,
} from './engine.js';
import type { SubmitterLimits } from './limits.js';

/** How often the alarm checks sent transactions and held items. */
export const POLL_MS = 2_000;

export interface QueueEnv {
  readonly SUBMITTER_LIMITS: DurableObjectNamespace<SubmitterLimits>;
  readonly [name: string]: unknown;
}

export interface QueueDeps {
  /** The chain port for a served chain, or null when its gas key or RPC is not configured. */
  portFor(env: unknown, chainId: number): SubmitterChain | null;
}

export type SubmitAnswer =
  | { readonly ok: true; readonly items: readonly SubmitItemResult[] }
  | { readonly ok: false; readonly error: 'unavailable' };

/** The queue's RPC surface, as the Worker calls it. */
export interface SubmitterQueueApi {
  submit(chainId: number, items: readonly SubmitItem[]): Promise<SubmitAnswer>;
  status(txHash: Hex): Promise<StatusResponse | null>;
  depth(): Promise<number>;
}

interface Meta {
  chainId: number | null;
  nonce: number | null;
  soloUntil: [string, number][];
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function createQueueClass(deps: QueueDeps) {
  return class SubmitterQueue extends DurableObject<QueueEnv> implements SubmitterQueueApi {
    private state: QueueState = emptyQueueState();
    private chainId: number | null = null;

    constructor(ctx: DurableObjectState, env: QueueEnv) {
      super(ctx, env);
      void ctx.blockConcurrencyWhile(async () => {
        const meta = await ctx.storage.get<Meta>('meta');
        const state = emptyQueueState();
        if (meta) {
          this.chainId = meta.chainId;
          state.nonce = meta.nonce;
          for (const [signer, until] of meta.soloUntil) state.soloUntil.set(signer, until);
        }
        for (const [key, entry] of await ctx.storage.list<ItemState>({ prefix: 'i:' })) {
          state.items.set(key.slice(2), entry);
        }
        for (const [key, tx] of await ctx.storage.list<TxState>({ prefix: 't:' })) {
          state.txs.set(key.slice(2), tx);
        }
        this.state = state;
      });
    }

    private async persist(): Promise<void> {
      const { changed } = this.state;
      const puts: Record<string, unknown> = {};
      const deletes: string[] = [];
      for (const id of changed.items) {
        const entry = this.state.items.get(id);
        if (entry) puts[`i:${id}`] = entry;
        else deletes.push(`i:${id}`);
      }
      for (const hash of changed.txs) {
        const tx = this.state.txs.get(hash);
        if (tx) puts[`t:${hash}`] = tx;
        else deletes.push(`t:${hash}`);
      }
      if (changed.meta || this.chainId !== null) {
        puts.meta = {
          chainId: this.chainId,
          nonce: this.state.nonce,
          soloUntil: [...this.state.soloUntil.entries()],
        } satisfies Meta;
      }
      changed.items.clear();
      changed.txs.clear();
      changed.meta = false;
      const keys = Object.keys(puts);
      // At most 128 keys per put call.
      for (let i = 0; i < keys.length; i += 100) {
        const part: Record<string, unknown> = {};
        for (const key of keys.slice(i, i + 100)) part[key] = puts[key];
        await this.ctx.storage.put(part);
      }
      for (let i = 0; i < deletes.length; i += 100) {
        await this.ctx.storage.delete(deletes.slice(i, i + 100));
      }
      if (queueDepth(this.state) > 0 && (await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
      }
    }

    async submit(chainId: number, items: readonly SubmitItem[]): Promise<SubmitAnswer> {
      const config = readConfig(this.env);
      const port = deps.portFor(this.env, chainId);
      if (!config || !port || !config.chains.includes(chainId)) {
        return { ok: false, error: 'unavailable' };
      }
      this.chainId = chainId;
      const limits = this.env.SUBMITTER_LIMITS;
      const hooks = {
        async chargeSigners(counts: ReadonlyMap<string, number>, now: number) {
          const refused = new Set<string>();
          await Promise.all(
            [...counts].map(async ([signer, n]) => {
              const stub = limits.get(limits.idFromName(`s:${String(chainId)}:${signer}`));
              const res = await stub.take(n, config.limits.signerItemsPerHour, 3600, now);
              if (!res.ok) refused.add(signer);
            }),
          );
          return refused;
        },
      };
      try {
        const results = await submitItems(
          port,
          config.settings,
          this.state,
          items,
          nowSeconds(),
          hooks,
        );
        return { ok: true, items: results };
      } catch {
        // A chain read failed before anything was sent; the client fails over.
        return { ok: false, error: 'unavailable' };
      } finally {
        await this.persist();
      }
    }

    status(txHash: Hex): Promise<StatusResponse | null> {
      if (this.chainId === null) return Promise.resolve(null);
      return Promise.resolve(txStatus(this.state, this.chainId, txHash));
    }

    depth(): Promise<number> {
      return Promise.resolve(queueDepth(this.state));
    }

    async alarm(): Promise<void> {
      const config = readConfig(this.env);
      const port = this.chainId === null ? null : deps.portFor(this.env, this.chainId);
      if (!config || !port) return;
      const more = await pollQueue(port, config.settings, this.state, nowSeconds()).finally(() =>
        this.persist(),
      );
      if (more) await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
    }
  };
}
