// `clientRequestId` idempotency (06 §1 rule 6; 07 §3.3; M1-7e).
//
// One `idempotency` row per (tool, clientRequestId, approvalId). `begin` reads it in one store
// transaction and decides: run (no row: insert it as `running` with this execution's run_id and a
// 60 s lease), replay (`done` with the same request digest), in progress (another execution holds
// the lease), take over (the lease lapsed: a compare-and-set swaps in this run_id, then the call
// resumes from the stored effects), or `IDEMPOTENCY_KEY_REUSED` (another request under the same key:
// nothing runs and nothing of the original result is returned).
//
// Every store transaction that makes a durable effect for the call includes `effectTx`: a
// compare-and-set on (state `running`, this run_id, lease not lapsed) that also stores the effect
// list. If it changes no row the caller's whole transaction must abort, so two executions can never
// both make an effect, whatever the clocks (IR-G-9-1 H-1). `finish` stores the result with the same
// compare-and-set, or deletes the row for a result without any effect that is not kept.
//
// The request digest is an HMAC under the store's index key (07 §3.1), never a plain hash, so the
// store file alone cannot confirm a guessed message. Without the index key nothing runs (fail closed).
// Results and effect lists are `enc`. Nothing here logs a key, an argument or a result (I-5, I-7).
import {
  canonicalize,
  encodeBase64url,
  encodeUtf8,
  parseJson,
  randomBytes,
} from '@agentlink/crypto';
import { CLOCK_SKEW_SECONDS } from '@agentlink/types';
import {
  IDEMPOTENCY_KEY_REUSED,
  IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_MIN_RETENTION_SECONDS,
} from './constants.js';
import { nowOf, open, seal, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import type { Row, Sealed } from './store/schema.js';
import type { StoreTx } from './store/store.js';

/** 07 §3.3: run_id is 16 random bytes, base64url. */
const RUN_ID_BYTES = 16;

export interface IdempotencyKey {
  /** The MCP tool name (06 §2.0). */
  readonly tool: string;
  /** The caller's value, compared as bytes; its bounds are the MCP input schema's (M1-9c). */
  readonly clientRequestId: string;
  /** The call's `approvalId`; a retry with one after `pending_approval` is a new call. */
  readonly approvalId?: string;
  /** `args` formed as for `action.args` (04 §3.4.1): defaults applied, without `approvalId` and
   * `clientRequestId`, paths resolved with realpath. */
  readonly args: unknown;
}

/** One execution of a call. `effects` grows only through `committed`, after a commit. */
export interface IdempotencyRun {
  readonly tool: string;
  readonly clientRequestId: string;
  readonly approvalId: string;
  readonly runId: string;
  readonly effects: string[];
}

export type IdempotencyStart =
  | { readonly kind: 'run'; readonly run: IdempotencyRun }
  /** A takeover with stored effects: re-check each and finish from there, never run blindly. */
  | { readonly kind: 'resume'; readonly run: IdempotencyRun }
  | { readonly kind: 'replay'; readonly result: unknown }
  /** A kept `pending_approval` whose approval is no longer pending: report its current state. */
  | { readonly kind: 'stale_approval'; readonly approvalId: string }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'key_reused'; readonly code: typeof IDEMPOTENCY_KEY_REUSED };

/** A sealed effect list, prepared before the effect transaction (no sealing inside one, 07 §3.1). */
export interface PreparedEffect {
  readonly effects: readonly string[];
  readonly sealed: Sealed;
}

type Step =
  | { readonly kind: 'run' }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'key_reused' }
  | { readonly kind: 'done'; readonly row: Row<'idempotency'> }
  | { readonly kind: 'takeover'; readonly effectRef: Sealed | null };

const keyOf = (run: Pick<IdempotencyRun, 'tool' | 'clientRequestId' | 'approvalId'>) => ({
  tool: run.tool,
  client_request_id: run.clientRequestId,
  approval_id: run.approvalId,
});

const sealKey = (run: Pick<IdempotencyRun, 'tool' | 'clientRequestId' | 'approvalId'>) => [
  run.tool,
  run.clientRequestId,
  run.approvalId,
];

/** The compare-and-set every write of a running execution carries (07 §3.3). */
const ownLease = (run: IdempotencyRun, now: number) => ({
  ...keyOf(run),
  state: 'running' as const,
  run_id: run.runId,
  lease_until: { gt: now },
});

/** The approval named by a kept `pending_approval` result, if the result is one. */
function pendingApprovalOf(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const r = result as { status?: unknown; approvalId?: unknown };
  return r.status === 'pending_approval' && typeof r.approvalId === 'string'
    ? r.approvalId
    : undefined;
}

export class IdempotencyService {
  readonly #ctx: CoreContext;

  constructor(ctx: CoreContext) {
    this.#ctx = ctx;
  }

  /** HMAC-SHA256 of JCS(args) under the index key (07 §3.1). Fails closed without the index key. */
  async #digest(args: unknown): Promise<string> {
    const cipher = this.#ctx.cipher;
    if (typeof cipher.indexDigest !== 'function') {
      throw new CoreError('idempotency_unavailable', 'Repeat protection is not available.');
    }
    let text: string;
    try {
      text = canonicalize(args);
    } catch {
      throw new CoreError('idempotency_args_invalid', 'The call input could not be recorded.');
    }
    const digest = await cipher.indexDigest(encodeUtf8(text));
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new CoreError('idempotency_unavailable', 'Repeat protection is not available.');
    }
    return digest;
  }

  async begin(key: IdempotencyKey): Promise<IdempotencyStart> {
    const approvalId = key.approvalId ?? '';
    if (
      typeof key.tool !== 'string' ||
      key.tool.length === 0 ||
      typeof key.clientRequestId !== 'string' ||
      typeof approvalId !== 'string'
    ) {
      throw new CoreError('idempotency_args_invalid', 'The call input could not be recorded.');
    }
    const digest = await this.#digest(key.args);
    const run: IdempotencyRun = {
      tool: key.tool,
      clientRequestId: key.clientRequestId,
      approvalId,
      runId: encodeBase64url(randomBytes(RUN_ID_BYTES)),
      effects: [],
    };
    const now = nowOf(this.#ctx);
    const step = await this.#ctx.store.transaction((tx): Step => {
      const row = tx.get('idempotency', keyOf(run));
      if (row === undefined) {
        const approval =
          approvalId === '' ? undefined : tx.get('approvals', { approval_id: approvalId });
        tx.insert('idempotency', {
          ...keyOf(run),
          request_digest: digest,
          state: 'running',
          run_id: run.runId,
          lease_until: now + IDEMPOTENCY_LEASE_SECONDS,
          effect_ref: null,
          result_json: null,
          created_at: now,
          expires_at: Math.max(
            now + IDEMPOTENCY_MIN_RETENTION_SECONDS,
            approval === undefined ? 0 : approval.expires_at + CLOCK_SKEW_SECONDS,
          ),
        });
        return { kind: 'run' };
      }
      // Another request under the same key: nothing runs, nothing of the original is returned.
      if (row.request_digest !== digest) return { kind: 'key_reused' };
      if (row.state === 'done') return { kind: 'done', row };
      if (row.lease_until > now) return { kind: 'in_progress' };
      const taken = tx.update(
        'idempotency',
        { ...keyOf(run), state: 'running', run_id: row.run_id, lease_until: { lte: now } },
        { run_id: run.runId, lease_until: now + IDEMPOTENCY_LEASE_SECONDS },
      );
      return taken === 1
        ? { kind: 'takeover', effectRef: row.effect_ref }
        : { kind: 'in_progress' };
    });

    switch (step.kind) {
      case 'run':
        return { kind: 'run', run };
      case 'in_progress':
        return { kind: 'in_progress' };
      case 'key_reused':
        return { kind: 'key_reused', code: IDEMPOTENCY_KEY_REUSED };
      case 'takeover': {
        if (step.effectRef === null) return { kind: 'run', run };
        run.effects.push(...(await this.#openEffects(run, step.effectRef)));
        return run.effects.length === 0 ? { kind: 'run', run } : { kind: 'resume', run };
      }
      case 'done':
        return this.#replay(run, step.row, now);
    }
  }

  async #openEffects(run: IdempotencyRun, sealed: Sealed): Promise<string[]> {
    const text = await open(this.#ctx, 'idempotency', 'effect_ref', sealKey(run), sealed);
    let value: unknown;
    try {
      value = parseJson(text);
    } catch {
      value = undefined;
    }
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      // Unreadable effects: running again could repeat them (fail closed, 07 §3.3).
      throw new CoreError('store_unreadable', 'A stored value could not be read.');
    }
    return value as string[];
  }

  async #replay(
    run: IdempotencyRun,
    row: Row<'idempotency'>,
    now: number,
  ): Promise<IdempotencyStart> {
    if (row.result_json === null) {
      throw new CoreError('store_unreadable', 'A stored value could not be read.');
    }
    const text = await open(this.#ctx, 'idempotency', 'result_json', sealKey(run), row.result_json);
    let result: unknown;
    try {
      result = parseJson(text);
    } catch {
      throw new CoreError('store_unreadable', 'A stored value could not be read.');
    }
    const approvalId = pendingApprovalOf(result);
    if (approvalId !== undefined) {
      // A stale `pending_approval` is never replayed, so the agent does not loop (07 §3.3).
      const approval = await this.#ctx.store.transaction((tx) =>
        tx.get('approvals', { approval_id: approvalId }),
      );
      const stillPending =
        approval !== undefined &&
        approval.status === 'pending' &&
        approval.signed_decision === null &&
        approval.signed_cancel === null &&
        now <= approval.expires_at;
      if (!stillPending) return { kind: 'stale_approval', approvalId };
    }
    return { kind: 'replay', result };
  }

  /** Seals the call's effect list with `ids` added, for the next effect transaction. */
  async prepareEffect(run: IdempotencyRun, ids: readonly string[]): Promise<PreparedEffect> {
    const effects = [...run.effects, ...ids];
    const sealed = await seal(
      this.#ctx,
      'idempotency',
      'effect_ref',
      sealKey(run),
      canonicalize(effects),
    );
    return { effects, sealed };
  }

  /**
   * Inside the caller's effect transaction: the compare-and-set on this execution's lease, storing
   * the effect list. False means another execution owns the call or the lease lapsed: the caller
   * must abort the whole transaction and write nothing.
   */
  effectTx(tx: StoreTx, run: IdempotencyRun, prepared: PreparedEffect): boolean {
    const now = nowOf(this.#ctx);
    return tx.update('idempotency', ownLease(run, now), { effect_ref: prepared.sealed }) === 1;
  }

  /** After the effect transaction committed: the run now holds those effects. */
  committed(run: IdempotencyRun, prepared: PreparedEffect): void {
    run.effects.splice(0, run.effects.length, ...prepared.effects);
  }

  /** Renews this execution's lease (every 20 s). False: the lease is lost; run nothing more. */
  async renew(run: IdempotencyRun): Promise<boolean> {
    const now = nowOf(this.#ctx);
    const n = await this.#ctx.store.transaction((tx) =>
      tx.update('idempotency', ownLease(run, now), {
        lease_until: now + IDEMPOTENCY_LEASE_SECONDS,
      }),
    );
    return n === 1;
  }

  /**
   * Stores the call's result as `done`, with the compare-and-set. `keep: false` (an `error`,
   * `needs_setup` or `needs_credits` result) deletes the row instead, but only when the call made no
   * durable effect. False: another execution holds the call; the result is returned unstored.
   */
  async finish(
    run: IdempotencyRun,
    result: unknown,
    options: { readonly keep?: boolean } = {},
  ): Promise<boolean> {
    const now = nowOf(this.#ctx);
    if (options.keep === false && run.effects.length === 0) {
      const n = await this.#ctx.store.transaction((tx) =>
        tx.delete('idempotency', ownLease(run, now)),
      );
      return n === 1;
    }
    let text: string;
    try {
      text = canonicalize(result);
    } catch {
      throw new CoreError('idempotency_result_invalid', 'The call result could not be recorded.');
    }
    const sealed = await seal(this.#ctx, 'idempotency', 'result_json', sealKey(run), text);
    const approvalId = pendingApprovalOf(result);
    const n = await this.#ctx.store.transaction((tx) => {
      const row = tx.get('idempotency', keyOf(run));
      if (row === undefined) return 0;
      const approval =
        approvalId === undefined ? undefined : tx.get('approvals', { approval_id: approvalId });
      // Never pruned before the call's approval has expired, plus S (07 §3.3).
      const expiresAt = Math.max(
        row.expires_at,
        approval === undefined ? 0 : approval.expires_at + CLOCK_SKEW_SECONDS,
      );
      return tx.update('idempotency', ownLease(run, now), {
        state: 'done',
        result_json: sealed,
        expires_at: expiresAt,
      });
    });
    return n === 1;
  }
}
