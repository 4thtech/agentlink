// W4-AUTO-SAVE: received files saved automatically into the Inbox folder (D-142; 04 §4.1; 06 §2.3,
// §3; 08 §1; proposed, owner confirms at merge).
//
// The background loop of the process that holds the publisher lease runs `AutoSaver.run` after each
// pass (06 §6). It takes the `pending` receiver rows that ingest wrote for a contact's message
// (received.ts) and, for each, in order:
// 1. stops when the agent is paused (D-143): nothing starts; a file that arrived during a pause waits
//    for Save after the resume, so resuming never starts a burst of downloads;
// 2. reads the rules in force: auto-save off or a policy that is not valid (fail closed) saves
//    nothing (`auto_save_off`); "Ask before saving" for the contact (`ask_before_saving`);
// 3. checks the sender again: an inbound `ok` message from a contact that is paired, active (not
//    blocked, removed or revoked) and allowed by `contacts.allowed`; checked once more inside the
//    file's lock right before the download, so blocking or removing a contact stops saves that have
//    not started;
// 4. reserves the declared size against the rolling 24-hour limits (per contact, then for the agent)
//    in one store transaction (`auto_save_log`, counts and bytes only); over a limit the file waits
//    (`limit_contact`, `limit_today`). An unreadable counter saves nothing (the transaction fails);
// 5. saves through FileFetcher (the same lock, writing rules and record as Save and
//    `agentlink_fetch_file`), with the quarantine mark required and 1 GiB kept free.
// At most 2 downloads at a time; a failed download is retried after 1 minute, 10 minutes and 1 hour,
// then waits (`download_failed`). A folder that is unavailable, cannot hold the mark or whose disk is
// full pauses auto-save for 10 minutes; files arriving meanwhile wait with that reason.
//
// Never logged: a name, a folder, a path or a link (I-7). Log lines carry counts and fixed codes only.
// Nothing here is reachable from an MCP tool (I-4): only the loop and the local app call it.
import { AUTO_SAVE_DEFAULTS, type AutoSavePolicy, type ContactRule } from '@4thtech-io/types';
import { nowOf, type CoreContext } from '../context.js';
import { CoreError } from '../errors.js';
import { policyLimits, type EffectivePolicy, type PolicyDocument } from '../policy-engine.js';
import { SINGLETON_SLOT, type Row } from '../store/schema.js';
import type { StoreTx } from '../store/store.js';
import type { FetchFileResult, FileFetcher } from './incoming.js';

/** The rolling window of the limits (04 §4.1). */
export const AUTO_SAVE_WINDOW_SECONDS = 86_400;
/** Free space kept on the Inbox folder's volume after the declared size (04 §4.1: 1 GiB). */
export const AUTO_SAVE_RESERVE_BYTES = 1024 ** 3;
/** Downloads at a time per agent (04 §4.1). */
export const AUTO_SAVE_CONCURRENCY = 2;
/** The delays before retries 1, 2 and 3, in seconds (04 §4.1). */
export const AUTO_SAVE_RETRY_DELAYS: readonly number[] = Object.freeze([60, 600, 3600]);
/** A paused folder (disk full, cannot mark, unavailable) is tried again after this (04 §4.1). */
export const AUTO_SAVE_PAUSE_RECHECK_SECONDS = 600;
/** Pending rows looked at in one run; the rest wait for the next pass. */
const RUN_BATCH = 32;
const MB = 1024 * 1024;

type Reason = NonNullable<Row<'files'>['auto_reason']>;
type PauseReason = NonNullable<Row<'auto_save_state'>['paused_reason']>;

/** The agent's pause state (06 §6 "Paused agents", D-143). Supplied by the runtime (W4-PAUSE). */
export interface AutoSavePause {
  /** True while the agent is paused: no automatic download starts. */
  paused(): boolean | Promise<boolean>;
  /** The last pause that ended (unix seconds), if any: files that arrived in it wait for Save. */
  lastPause?():
    | { readonly pausedAt: number; readonly resumedAt: number }
    | undefined
    | Promise<{ readonly pausedAt: number; readonly resumedAt: number } | undefined>;
}

/** What one run did: counts only. */
export interface AutoSaveRun {
  readonly saved: number;
  readonly waiting: number;
  readonly retrying: number;
}

const NOTHING: AutoSaveRun = Object.freeze({ saved: 0, waiting: 0, retrying: 0 });

/**
 * The `files.autoSave` of the rules in force: the policy's, the defaults for a policy signed before
 * D-142 (or the 06 §3 defaults while no policy was applied), or undefined (nothing is saved
 * automatically) while the policy is not valid (fail closed, 06 §3).
 */
export function autoSaveOf(effective: EffectivePolicy): AutoSavePolicy | undefined {
  if (effective.mode === 'fail_closed') return undefined;
  const files = effective.policy.files as { readonly autoSave?: AutoSavePolicy };
  return files.autoSave ?? AUTO_SAVE_DEFAULTS;
}

const askBeforeSaving = (policy: PolicyDocument, contact: string): boolean =>
  (policy.contactRules as readonly ContactRule[]).some(
    (r) => r.contact === contact && r.files?.askBeforeSaving === true,
  );

const allowedContact = (policy: PolicyDocument, contact: string): boolean => {
  const allowed = policy.contacts.allowed;
  return allowed === 'paired' || (allowed as readonly string[]).includes(contact);
};

/**
 * The sender check of 04 §4.1 on stored rows: an inbound `ok` message from a paired, active contact.
 * Undefined when it passes; null (no reason line) when it does not.
 */
function senderCheckTx(tx: StoreTx, file: Row<'files'>): { contact: string } | null {
  const message = tx.get('envelopes', { envelope_id: file.envelope_id });
  if (
    message === undefined ||
    message.direction !== 'in' ||
    message.state !== 'ok' ||
    message.contact_id === null ||
    message.request_accepted_at !== null
  ) {
    return null;
  }
  const contact = tx.get('contacts', { contact_id: message.contact_id });
  if (contact === undefined || contact.status !== 'active' || contact.pairing !== 'complete') {
    return null;
  }
  return { contact: message.contact_id };
}

interface Candidate {
  readonly file: Row<'files'>;
  readonly contact: string;
}

export interface AutoSaverOptions {
  /** The agent's pause state (W4-PAUSE wires it); absent: never paused. */
  readonly pause?: AutoSavePause;
}

export class AutoSaver {
  readonly #ctx: CoreContext;
  readonly #fetcher: Pick<FileFetcher, 'fetch' | 'available'>;
  readonly #loadPolicy: () => Promise<EffectivePolicy>;
  readonly #pause: AutoSavePause | undefined;
  #running: Promise<AutoSaveRun> | undefined;

  constructor(
    ctx: CoreContext,
    fetcher: Pick<FileFetcher, 'fetch' | 'available'>,
    loadPolicy: () => Promise<EffectivePolicy>,
    options: AutoSaverOptions = {},
  ) {
    this.#ctx = ctx;
    this.#fetcher = fetcher;
    this.#loadPolicy = loadPolicy;
    this.#pause = options.pause;
  }

  /** One run (see the header). A run while one is in flight waits for it and returns its counts. */
  run(): Promise<AutoSaveRun> {
    if (this.#running !== undefined) return this.#running;
    const run = this.#run().finally(() => {
      if (this.#running === run) this.#running = undefined;
    });
    this.#running = run;
    return run;
  }

  /** True while the one-time "now saved automatically" notice is due (08 §1, Decision 51). */
  async noticeDue(): Promise<boolean> {
    const row = await this.#ctx.store.transaction((tx) =>
      tx.get('auto_save_state', { slot: SINGLETON_SLOT }),
    );
    return row?.notice === 'show';
  }

  /** The owner dismissed the notice (OK, or Settings from it). Display state only; idempotent. */
  async dismissNotice(): Promise<void> {
    await this.#ctx.store.transaction((tx) => {
      const key = { slot: SINGLETON_SLOT };
      if (tx.get('auto_save_state', key)?.notice === 'show') {
        tx.update('auto_save_state', key, { notice: 'dismissed' });
      }
    });
  }

  async #run(): Promise<AutoSaveRun> {
    const ctx = this.#ctx;
    if (!this.#fetcher.available) return NOTHING; // no file system (the cloud agent, 06 §2.3)
    if (this.#pause !== undefined && (await this.#pause.paused())) return NOTHING;
    const now = nowOf(ctx);
    const due = await ctx.store.transaction((tx) =>
      tx.select(
        'files',
        { auto_save: 'pending', auto_next_at: { lte: now } },
        {
          orderBy: [
            ['auto_next_at', 'asc'],
            ['envelope_id', 'asc'],
            ['idx', 'asc'],
          ],
          limit: RUN_BATCH,
        },
      ),
    );
    if (due.length === 0) return NOTHING;

    const policy = await this.#loadPolicy();
    const rules = autoSaveOf(policy);
    if (rules === undefined || !rules.on || policy.mode === 'fail_closed') {
      return this.#report(await this.#waitAll(due, 'auto_save_off'));
    }
    const doc = policy.policy;

    // A folder paused in the last 10 minutes: files arriving now wait with its reason.
    const pausedState = await ctx.store.transaction((tx) =>
      tx.get('auto_save_state', { slot: SINGLETON_SLOT }),
    );
    const pausedReason = pausedState?.paused_reason ?? null;
    const pausedAt = pausedState?.paused_at ?? null;
    if (pausedReason !== null && pausedAt !== null) {
      if (now - pausedAt < AUTO_SAVE_PAUSE_RECHECK_SECONDS) {
        return this.#report(await this.#waitAll(due, pausedReason));
      }
      await this.#setPaused(null);
    }

    const lastPause = await this.#pause?.lastPause?.();
    const candidates: Candidate[] = [];
    let waiting = 0;
    for (const file of due) {
      const verdict = await ctx.store.transaction((tx) => {
        const current = tx.get('files', { envelope_id: file.envelope_id, idx: file.idx });
        if (current?.auto_save !== 'pending') return 'gone' as const;
        if (current.saved_name !== null || current.deleted_at !== null) {
          // Saved by Save or a fetch meanwhile, or removed: nothing to do automatically.
          waitTx(tx, current, null);
          return 'skip' as const;
        }
        const sender = senderCheckTx(tx, current);
        if (sender === null) {
          waitTx(tx, current, null);
          return 'skip' as const;
        }
        const createdAt = tx.get('envelopes', { envelope_id: current.envelope_id })?.created_at;
        if (
          lastPause !== undefined &&
          (current.auto_tries ?? 0) === 0 &&
          createdAt !== undefined &&
          createdAt >= lastPause.pausedAt &&
          createdAt < lastPause.resumedAt
        ) {
          // It was sent while the agent was paused (a paused agent receives nothing, so it is stored
          // by the catch-up after the resume): it waits for Save (04 §4.1, D-143).
          waitTx(tx, current, null);
          return 'skip' as const;
        }
        if (!allowedContact(doc, sender.contact)) {
          waitTx(tx, current, null);
          return 'skip' as const;
        }
        if (askBeforeSaving(doc, sender.contact)) {
          waitTx(tx, current, 'ask_before_saving');
          return 'skip' as const;
        }
        return { file: current, contact: sender.contact };
      });
      if (verdict === 'skip') waiting += 1;
      else if (verdict !== 'gone') candidates.push(verdict);
    }

    let saved = 0;
    let retrying = 0;
    const maxReceiveBytes = policyLimits(policy).maxReceiveBytes;
    for (let start = 0; start < candidates.length; start += AUTO_SAVE_CONCURRENCY) {
      const batch = candidates.slice(start, start + AUTO_SAVE_CONCURRENCY);
      const outcomes = await Promise.all(
        batch.map((c) => this.#saveOne(c, rules, now, maxReceiveBytes)),
      );
      let pause: PauseReason | undefined;
      for (const outcome of outcomes) {
        if (outcome === 'saved') saved += 1;
        else if (outcome === 'retry') retrying += 1;
        else {
          waiting += 1;
          if (
            outcome === 'disk_full' ||
            outcome === 'folder_cannot_mark' ||
            outcome === 'folder_unavailable'
          ) {
            pause = outcome;
          }
        }
      }
      if (pause !== undefined) {
        await this.#setPaused(pause);
        const rest = candidates.slice(start + AUTO_SAVE_CONCURRENCY).map((c) => c.file);
        waiting += await this.#waitAll(rest, pause);
        break;
      }
    }
    return this.#report({ saved, waiting, retrying });
  }

  /** One file: the limits, then the save. Returns `saved`, `retry` or the reason it now waits. */
  async #saveOne(
    candidate: Candidate,
    rules: AutoSavePolicy,
    now: number,
    maxReceiveBytes: number,
  ): Promise<'saved' | 'retry' | Reason | 'skip'> {
    const ctx = this.#ctx;
    const { file, contact } = candidate;
    const key = { envelope_id: file.envelope_id, idx: file.idx };
    if (file.size > maxReceiveBytes) {
      // Over the per-file cap: the fetch refuses it too; it waits for the owner (04 §4.1).
      await this.#wait(file, 'download_failed');
      return 'download_failed';
    }

    // The limits: one reservation per file, kept across its retries (04 §4.1).
    let limited: Reason | undefined;
    try {
      limited = await ctx.store.transaction((tx) => {
        tx.delete('auto_save_log', { at: { lte: now - AUTO_SAVE_WINDOW_SECONDS } });
        if (tx.get('auto_save_log', key) !== undefined) return undefined;
        const since = { gt: now - AUTO_SAVE_WINDOW_SECONDS };
        let contactFiles = 0;
        let contactBytes = 0;
        let totalFiles = 0;
        let totalBytes = 0;
        for (const r of tx.select('auto_save_log', { at: since })) {
          totalFiles += 1;
          totalBytes += r.bytes;
          if (r.contact_id === contact) {
            contactFiles += 1;
            contactBytes += r.bytes;
          }
        }
        if (
          contactFiles + 1 > rules.perContactFilesPerDay ||
          contactBytes + file.size > rules.perContactMBPerDay * MB
        ) {
          return 'limit_contact';
        }
        if (
          totalFiles + 1 > rules.totalFilesPerDay ||
          totalBytes + file.size > rules.totalMBPerDay * MB
        ) {
          return 'limit_today';
        }
        tx.insert('auto_save_log', {
          envelope_id: file.envelope_id,
          idx: file.idx,
          contact_id: contact,
          at: now,
          bytes: file.size,
        });
        return undefined;
      });
    } catch {
      // An unreadable counter means no automatic save (fail closed, 04 §4.1); try again later.
      ctx.log.warn('auto-save limits unreadable', { code: 'store_failed' });
      return 'skip';
    }
    if (limited !== undefined) {
      await this.#wait(file, limited);
      return limited;
    }

    // Checked again inside the file's lock, right before the download.
    // Checked again inside the file's lock, right before the download (IR-W4-AUTO-SAVE-1 L2,
    // SEC-1 L3): the pause, the rules in force read again, and the sender in the store.
    const stillAllowed = async (): Promise<boolean> => {
      if (this.#pause !== undefined && (await this.#pause.paused())) return false;
      const fresh = await this.#loadPolicy();
      const freshRules = autoSaveOf(fresh);
      if (freshRules === undefined || !freshRules.on || fresh.mode === 'fail_closed') return false;
      const nowDoc = fresh.policy;
      return ctx.store.transaction((tx) => {
        const current = tx.get('files', key);
        if (current?.auto_save !== 'pending' || current.saved_name !== null) return false;
        const sender = senderCheckTx(tx, current);
        return (
          sender !== null &&
          allowedContact(nowDoc, sender.contact) &&
          !askBeforeSaving(nowDoc, sender.contact)
        );
      });
    };

    let result: FetchFileResult;
    try {
      result = await this.#fetcher.fetch(
        { envelopeId: file.envelope_id, fileIndex: file.idx },
        { auto: { reserveBytes: AUTO_SAVE_RESERVE_BYTES, beforeDownload: stillAllowed } },
      );
    } catch (error) {
      const code = error instanceof CoreError ? error.code : 'file_download_failed';
      if (code === 'disk_full' || code === 'folder_cannot_mark') {
        await this.#wait(file, code);
        return code;
      }
      if (code === 'inbox_unavailable' || code === 'files_unavailable') {
        await this.#wait(file, 'folder_unavailable');
        return 'folder_unavailable';
      }
      return this.#retry(file, now);
    }
    if (result.status === 'ok') {
      await ctx.store.transaction((tx) => {
        if (tx.get('files', key)?.auto_save === 'pending') {
          tx.update('files', key, { auto_save: 'saved', auto_reason: null });
        }
      });
      return 'saved';
    }
    if (result.status === 'rejected' && result.code === 'POLICY_DENIED') {
      // The sender check before the download failed (blocked or removed meanwhile), or the rules
      // changed: nothing was written.
      await this.#wait(file, null);
      return 'skip';
    }
    // Not found, integrity, expired link, refused location or too large: Save shows the outcome.
    await this.#wait(file, 'download_failed');
    return 'download_failed';
  }

  async #retry(file: Row<'files'>, now: number): Promise<'retry' | Reason> {
    const tries = (file.auto_tries ?? 0) + 1;
    const delay = AUTO_SAVE_RETRY_DELAYS[tries - 1];
    if (delay === undefined) {
      await this.#wait(file, 'download_failed');
      return 'download_failed';
    }
    await this.#ctx.store.transaction((tx) => {
      const key = { envelope_id: file.envelope_id, idx: file.idx };
      if (tx.get('files', key)?.auto_save === 'pending') {
        tx.update('files', key, { auto_tries: tries, auto_next_at: now + delay });
      }
    });
    return 'retry';
  }

  async #wait(file: Row<'files'>, reason: Reason | null): Promise<void> {
    await this.#ctx.store.transaction((tx) => {
      const current = tx.get('files', { envelope_id: file.envelope_id, idx: file.idx });
      if (current?.auto_save === 'pending') waitTx(tx, current, reason);
    });
  }

  async #waitAll(files: readonly Row<'files'>[], reason: Reason): Promise<number> {
    if (files.length === 0) return 0;
    return this.#ctx.store.transaction((tx) => {
      let n = 0;
      for (const file of files) {
        const current = tx.get('files', { envelope_id: file.envelope_id, idx: file.idx });
        if (current?.auto_save !== 'pending') continue;
        waitTx(tx, current, reason);
        n += 1;
      }
      return n;
    });
  }

  async #setPaused(reason: PauseReason | null): Promise<void> {
    const now = nowOf(this.#ctx);
    await this.#ctx.store.transaction((tx) => {
      const key = { slot: SINGLETON_SLOT };
      const patch = { paused_reason: reason, paused_at: reason === null ? null : now };
      if (tx.get('auto_save_state', key) === undefined) {
        tx.insert('auto_save_state', { slot: SINGLETON_SLOT, notice: null, ...patch });
      } else {
        tx.update('auto_save_state', key, patch);
      }
    });
  }

  #report(run: AutoSaveRun | number): AutoSaveRun {
    const out: AutoSaveRun =
      typeof run === 'number' ? { saved: 0, waiting: run, retrying: 0 } : Object.freeze(run);
    if (out.saved > 0 || out.waiting > 0 || out.retrying > 0) {
      // Counts only (I-7).
      this.#ctx.log.info('auto-save', {
        saved: out.saved,
        waiting: out.waiting,
        retrying: out.retrying,
      });
    }
    return out;
  }
}

function waitTx(tx: StoreTx, file: Row<'files'>, reason: Reason | null): void {
  tx.update(
    'files',
    { envelope_id: file.envelope_id, idx: file.idx },
    { auto_save: 'waiting', auto_reason: reason },
  );
}
