// OWNER-START-OVER (D-153; 04 §2.5.4 "Start over on this computer"; 08 §1; I-4, I-7): the engine
// behind "Forgot your master code? Start over on this computer", in the desktop app (Mac, Windows)
// and the browser app. Its only caller is the approval server's start-over gate (approval-server.ts);
// the package entry never exports it (the 04 §8.1 fence), and no MCP tool reaches it (I-4).
//
// What it does, after the typed phrase and a fresh OS presence gesture:
//   1. reads the agent IDs of the IDs in ~/.agentlink (config.json `agentId`, names only, no store)
//      and writes them to `start-over.json` in that folder (0600; public IDs, no secret);
//   2. closes the ID the app has open, then MOVES ~/.agentlink to ~/.agentlink.backup-YYYYMMDD-HHMMSS
//      (one rename, never a delete; `-2`… when that name is taken; a link is refused, 04 §4);
//   3. erases the keychain accounts of those IDs (eraseKeychainAgent: the exact agent items, seed
//      last) and, only when every one went and ~/.agentlink has not come back with an ID or key
//      file, this owner's fixed accounts, by exact name under the one service `agentlink` (`owner`
//      last, so first run stays refused until every one is gone);
//   4. marks the records done (a failed write is a failure) and lets the app open first run.
// A failure at any step is answered (`partial`, with the step), never silent. A move that fails
// erases nothing and the ID is opened again. A retry is a new start over: it moves the folder that is
// there now (if any) and also finishes every unfinished record found in a backup, so nothing is moved
// or erased twice and nothing is left behind. IR M2: when an earlier record is unfinished and the
// `owner` item is no longer the one it recorded (`ownerTag`), a new owner exists: the run only
// finishes the earlier IDs and never moves that owner's folder or erases its items.
//
// Presence (the gesture proves a person is at this computer now; it unlocks nothing). It stops web
// origins, AI apps over MCP and accidents; it is no barrier against a same-user process (04 §2.5),
// which could move the folder itself anyway:
//   - native (desktop app): the server spawns the helper, so a real OS sheet is shown. macOS:
//     `create` (no sheet), then one Touch ID sheet (`ecdh reset`: "start over AgentLink on this
//     computer") whose secret is wiped at once. Windows: `create` is the one Windows Hello prompt;
//     the throwaway key is then removed.
//   - passkey (browser): a WebAuthn creation with user verification for this begin's challenge and
//     this origin (owner-setup.ts checkSetupRegistration: UP, UV, rpIdHash, attested credential ID).
//     Attestation is `none`, so a same-user process could forge one.
// Begin answers a single-use nonce bound to the page session, 120 s. Three gestures in a row that
// were made and not recognised make the next begin wait (60 s, doubling, at most 15 minutes); a
// cancel, a missing sensor or a timeout does not count.
//
// I-7: nothing here is logged; answers are fixed codes. The backup path is shown with `~`.
import { lstat, open, readdir, rename as fsRename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  NATIVE_PRESENCE_MACOS,
  encodeBase64url,
  encodeHex,
  equalBytes,
  randomBytes,
  sha256,
  wipe,
  type JsonValue,
} from '@4thtech-io/crypto';
import { readSmallRegularText } from './approval-os.js';
import { KEYCHAIN_CALL_TIMEOUT_MS, eraseKeychainAgent, guarded } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { NativeHelperError, type NativeHelper } from './owner-native-helper.js';
import { OWNER_PASSKEY_KEY_ACCOUNT, PASSKEY_RP_ID } from './owner-passkey.js';
import {
  OWNER_ACCOUNT,
  OWNER_NATIVE_ACCOUNT,
  OWNER_NATIVE_REVOKED_ACCOUNT,
  OWNER_NEXT_ACCOUNT,
  OWNER_PASSKEY_ACCOUNT,
} from './owner-keystore.js';
import { checkSetupRegistration, parseSetupRegistration } from './owner-setup.js';

/** What the person types (case and outer spaces do not matter). */
export const START_OVER_PHRASE = 'start over';
/** How long a begin's nonce lives. */
export const START_OVER_TTL_MS = 120_000;
/** The record in the moved folder: which IDs' items to erase, and whether that is done. */
export const START_OVER_RECORD = 'start-over.json';
/** The backup folder's name before its date. */
export const START_OVER_BACKUP_PREFIX = '.agentlink.backup-';
/** Refused gestures in a row before begin waits. */
const FREE_TRIES = 3;
const FIRST_WAIT_S = 60;
const MAX_WAIT_S = 15 * 60;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_AGENTS = 256;

const AGENT_ID = /^0x[0-9a-f]{40}$/;
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const BACKUP_NAME = /^\.agentlink\.backup-\d{8}-\d{6}(?:-\d{1,2})?$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;

/**
 * The owner's keychain accounts, in erase order: first the ones first run does not look at, then
 * the four it does (owner-setup.ts noOwnerAndNoAgent), `owner` last. While any of those four is
 * left, first run refuses, so a new owner can never be made over a half-erased one.
 */
export const OWNER_ERASE_ORDER: readonly string[] = Object.freeze([
  OWNER_PASSKEY_KEY_ACCOUNT,
  OWNER_NATIVE_REVOKED_ACCOUNT,
  OWNER_NEXT_ACCOUNT,
  OWNER_NATIVE_ACCOUNT,
  OWNER_PASSKEY_ACCOUNT,
  OWNER_ACCOUNT,
]);

/**
 * `native`: the desktop app's OS sheet. `passkey`: a browser's user-verified creation. `typed`
 * (owner decision, 14 Nov 2026): no user-verifying presence here, so the phrase is typed a second
 * time on its own confirmation step. Never chosen where a gesture is available.
 */
export type StartOverPresence = 'native' | 'passkey' | 'typed';

export interface StartOverAnswer {
  readonly status: number;
  readonly body: JsonValue;
}

export interface StartOverOptions {
  /** The OS user's home (tests: a temporary one). */
  readonly home: string;
  readonly keychain: () => KeychainBackend;
  /** `http://localhost:<port>`: the origin a passkey creation must name. */
  readonly origin: string;
  readonly now?: () => number;
  /** The desktop app's presence helper; undefined in a browser (then: passkey). */
  readonly native?: NativeHelper | undefined;
  readonly keychainTimeoutMs?: number;
  /** Test seam: the folder move. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** Closes the ID the app has open (its store and folder lock) before the move. */
  readonly closeOpen?: () => Promise<void>;
  /** After the run: opens another ID if one is there, else leaves the app on first run. */
  readonly reopen?: () => Promise<void>;
}

export interface StartOverEngine {
  /** `GET state`: which gesture this app uses, and whether an earlier start over is unfinished. */
  state(): Promise<StartOverAnswer>;
  /** `POST begin` input `{phrase}`. */
  begin(session: string, input: JsonValue | undefined): Promise<StartOverAnswer>;
  /** `POST finish` input `{nonce}` (typed: `{nonce, phrase}`); `mode` is the `X-AgentLink-Presence` value; `body` the creation. */
  finish(
    session: string,
    input: JsonValue | undefined,
    mode: string | undefined,
    body: Uint8Array,
  ): Promise<StartOverAnswer>;
  close(): void;
}

interface Pending {
  readonly session: string;
  readonly nonce: string;
  readonly challenge: Uint8Array;
  readonly presence: StartOverPresence;
  readonly expires: number;
}

interface StartOverRecord {
  readonly v: 1;
  readonly startedAt: number;
  readonly agents: readonly string[];
  readonly done: boolean;
  /**
   * IR M2: SHA-256 (hex) of the `owner` keychain item's stored bytes (its ciphertext) when the run
   * began, or null when there was none. An `owner` item that differs later is a NEW owner's (first
   * run ran): it and its folder are never touched again. Not a secret: a digest of ciphertext.
   */
  readonly ownerTag: string | null;
  readonly finishedAt?: number;
}

const answer = (status: number, body: JsonValue): StartOverAnswer =>
  Object.freeze({ status, body });
const refuse = (status: number, error: string): StartOverAnswer => answer(status, { error });

const code = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

/** The phrase as typed: trimmed, lower case, inner runs of spaces as one. */
function phraseMatches(phrase: unknown): boolean {
  if (typeof phrase !== 'string' || phrase.length > 64) return false;
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ') === START_OVER_PHRASE;
}

/**
 * Begin's input: `{phrase}`, or `{phrase, sensor: "none"}` from a browser page that found no
 * user-verifying platform authenticator. Undefined when malformed or the phrase is wrong.
 */
function beginInput(input: JsonValue | undefined): { readonly noSensor: boolean } | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  const value = input as Record<string, unknown>;
  if (!keys.includes('phrase') || !keys.every((k) => k === 'phrase' || k === 'sensor')) {
    return undefined;
  }
  if (keys.includes('sensor') && value['sensor'] !== 'none') return undefined;
  if (!phraseMatches(value['phrase'])) return undefined;
  return { noSensor: value['sensor'] === 'none' };
}

/** Finish's input: `{nonce}`, or `{nonce, phrase}` for the typed confirmation. */
function finishInput(
  input: JsonValue | undefined,
): { readonly nonce: string; readonly phrase?: unknown } | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (!keys.includes('nonce') || !keys.every((k) => k === 'nonce' || k === 'phrase')) {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  const nonce = value['nonce'];
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return undefined;
  return keys.includes('phrase') ? { nonce, phrase: value['phrase'] } : { nonce };
}

const two = (n: number): string => String(n).padStart(2, '0');

/** `YYYYMMDD-HHMMSS` in local time. */
export function backupStamp(at: number): string {
  const d = new Date(at);
  return (
    `${String(d.getFullYear())}${two(d.getMonth() + 1)}${two(d.getDate())}-` +
    `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  );
}

/** True when nothing is at `path` (only ENOENT); any other error rejects (fail closed). */
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (code(error) === 'ENOENT') return true;
    throw error;
  }
}

/**
 * A small regular file's text (not a link), or undefined. Opened first (no link followed, never
 * blocking) and checked through the open handle, then read from that same handle, so nothing can
 * swap the file between the check and the read (CodeQL js/file-system-race).
 */
function smallText(path: string): Promise<string | undefined> {
  return readSmallRegularText(path, MAX_RECORD_BYTES);
}

function parseRecord(text: string | undefined): StartOverRecord | undefined {
  if (text === undefined) return undefined;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (
      raw['v'] !== 1 ||
      typeof raw['startedAt'] !== 'number' ||
      typeof raw['done'] !== 'boolean' ||
      !Array.isArray(raw['agents']) ||
      raw['agents'].length > MAX_AGENTS ||
      !raw['agents'].every((a) => typeof a === 'string' && AGENT_ID.test(a))
    ) {
      return undefined;
    }
    return {
      v: 1,
      startedAt: raw['startedAt'],
      agents: raw['agents'] as string[],
      done: raw['done'],
      ownerTag:
        typeof raw['ownerTag'] === 'string' && /^[0-9a-f]{64}$/.test(raw['ownerTag'])
          ? raw['ownerTag']
          : null,
      ...(typeof raw['finishedAt'] === 'number' ? { finishedAt: raw['finishedAt'] } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Writes the record (0600) through a temporary file and a rename. */
async function writeRecord(dir: string, record: StartOverRecord): Promise<void> {
  const temp = join(dir, `.${START_OVER_RECORD}.${encodeBase64url(randomBytes(6))}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsRename(temp, join(dir, START_OVER_RECORD));
}

/** The agent IDs of the ID folders in `dir/agents` (unreadable configs are skipped). */
async function agentIdsIn(dir: string): Promise<string[]> {
  const agentsDir = join(dir, 'agents');
  let names: string[];
  try {
    names = await readdir(agentsDir);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const name of names) {
    if (!AGENT_NAME.test(name) || ids.size >= MAX_AGENTS) continue;
    const text = await smallText(join(agentsDir, name, 'config.json'));
    if (text === undefined) continue;
    try {
      const agentId = (JSON.parse(text) as { agentId?: unknown }).agentId;
      if (typeof agentId === 'string' && AGENT_ID.test(agentId)) ids.add(agentId);
    } catch {
      // A damaged config names no ID.
    }
  }
  return [...ids];
}

export function createStartOverEngine(options: StartOverOptions): StartOverEngine {
  const now = options.now ?? Date.now;
  const home = options.home;
  const dir = join(home, '.agentlink');
  const timeoutMs = options.keychainTimeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const move = options.rename ?? ((from: string, to: string) => fsRename(from, to));
  /**
   * The gesture this computer uses. Desktop app: the OS sheet when the helper says Touch ID or
   * Windows Hello is set up, else the typed confirmation (the server decides; the page cannot ask
   * for less). Browser: a passkey creation, unless the page found no user-verifying platform
   * authenticator (`noSensor`; a page claim, see 04 §2.5.4).
   */
  async function presenceFor(noSensor: boolean): Promise<StartOverPresence | 'retry'> {
    const helper = options.native;
    if (helper !== undefined) {
      // Typing only when the helper answered "unavailable" (exit 69: no Touch ID / Windows Hello,
      // or not set up). A lockout, a timeout or an error is `retry`: never a drop to typing.
      const state = await helper.availability().catch(() => undefined);
      if (state === undefined) return 'retry';
      if (state.available) return 'native';
      return state.transient === true ? 'retry' : 'typed';
    }
    return noSensor ? 'typed' : 'passkey';
  }
  let pending: Pending | undefined;
  let refused = { count: 0, until: 0 };
  let running = false;
  let closed = false;

  const wipePending = (): void => {
    if (pending !== undefined) wipe(pending.challenge);
    pending = undefined;
  };

  /** Every backup folder of this home with a record, newest first. */
  async function backups(): Promise<{ readonly path: string; readonly record: StartOverRecord }[]> {
    let names: string[];
    try {
      names = await readdir(home);
    } catch {
      return [];
    }
    const out: { path: string; record: StartOverRecord }[] = [];
    for (const name of names
      .filter((n) => BACKUP_NAME.test(n))
      .sort()
      .reverse()) {
      const path = join(home, name);
      try {
        const info = await lstat(path);
        if (!info.isDirectory()) continue;
      } catch {
        continue;
      }
      const record = parseRecord(await smallText(join(path, START_OVER_RECORD)));
      if (record !== undefined) out.push({ path, record });
    }
    return out;
  }

  async function freeBackupPath(): Promise<string> {
    const base = join(home, `${START_OVER_BACKUP_PREFIX}${backupStamp(now())}`);
    if (await absent(base)) return base;
    for (let n = 2; n <= 99; n += 1) {
      const next = `${base}-${String(n)}`;
      if (await absent(next)) return next;
    }
    throw new Error('no free backup name');
  }

  /** Deletes one account and reads it back; true when it is gone. */
  async function eraseAccount(keychain: KeychainBackend, account: string): Promise<boolean> {
    try {
      await guarded(() => keychain.delete(account), timeoutMs);
      const left = await guarded(() => keychain.get(account), timeoutMs);
      if (left === null) return true;
      wipe(left);
      return false;
    } catch {
      return false;
    }
  }

  /**
   * The owner's accounts go only while no new owner can be here: ~/.agentlink holds no ID folder and
   * no key file (first run makes those). Otherwise they are a new owner's and stay.
   */
  async function ownerSlotFree(): Promise<boolean> {
    for (const sub of ['agents', 'keystore']) {
      try {
        if ((await readdir(join(dir, sub))).length > 0) return false;
      } catch (error) {
        if (code(error) !== 'ENOENT') return false;
      }
    }
    return true;
  }

  /** The digest of the `owner` item's stored bytes, or null without one (rejects on a keychain error). */
  async function ownerTagNow(keychain: KeychainBackend): Promise<string | null> {
    const item = await guarded(() => keychain.get(OWNER_ACCOUNT), timeoutMs);
    if (item === null) return null;
    try {
      return encodeHex(sha256(item));
    } finally {
      wipe(item);
    }
  }

  /** Erases the items of `agents`; true when every one is gone. */
  async function eraseAgents(
    keychain: KeychainBackend,
    agents: readonly string[],
  ): Promise<boolean> {
    let ok = true;
    for (const agentId of agents) {
      try {
        await eraseKeychainAgent(keychain, agentId, [], { timeoutMs });
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  /**
   * IR M1/M2: the owner's items, only after every ID's items went and only while ~/.agentlink holds
   * no ID folder and no key file (a folder that came back, e.g. a running AI app recreating it, is
   * a failure: the records stay undone). The rest stay at the first failure: `owner` goes last.
   */
  async function eraseOwner(keychain: KeychainBackend): Promise<boolean> {
    if (!(await ownerSlotFree())) return false;
    for (const account of OWNER_ERASE_ORDER) {
      if (!(await eraseAccount(keychain, account))) return false;
    }
    return true;
  }

  /** Marks the records done; false when a write failed (never swallowed, IR M2). */
  async function markDone(
    todo: readonly { readonly path: string; readonly record: StartOverRecord }[],
  ): Promise<boolean> {
    let ok = true;
    for (const b of todo) {
      try {
        await writeRecord(b.path, { ...b.record, done: true, finishedAt: now() });
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  const shown = (path: string): string => join('~', path.slice(home.length + 1));

  /** The run after the gesture. */
  async function run(): Promise<StartOverAnswer> {
    const keychain = options.keychain();
    const earlier = (await backups()).filter((b) => !b.record.done);
    // IR M2: an earlier start over did not finish, and the `owner` item here now is not the one it
    // started with: that is a NEW owner (first run ran, so the old owner was fully erased). Finish
    // the earlier records' IDs only; never move this folder or erase the owner again. The next
    // start over (no unfinished record left) is a full one.
    if (earlier.length > 0) {
      let current: string | null;
      try {
        current = await ownerTagNow(keychain);
      } catch {
        return answer(200, { status: 'partial', backup: null, failed: 'keychain' });
      }
      // A keychain owner that is not the recorded one; or (Fable r2) no `owner` item although every
      // earlier record had one, and the folder holds an ID or key file: a new owner on the file
      // KeyStore (04 §2.8). Either way its folder is never moved and its items never erased.
      const newOwnerHere =
        current !== null
          ? earlier.every((b) => b.record.ownerTag !== current)
          : earlier.every((b) => b.record.ownerTag !== null) && !(await ownerSlotFree());
      if (newOwnerHere) {
        const agents = [...new Set(earlier.flatMap((b) => b.record.agents))];
        const ok = (await eraseAgents(keychain, agents)) && (await markDone(earlier));
        const backup = shown((earlier[0] as { path: string }).path);
        return ok
          ? answer(200, { status: 'done', backup, earlierOnly: true })
          : answer(200, { status: 'partial', backup, failed: 'keychain' });
      }
    }
    let moved: string | undefined;
    let movedRecord: StartOverRecord | undefined;
    // 1–2: the folder that is here now, if any.
    let here: boolean;
    try {
      here = !(await absent(dir));
    } catch {
      return answer(200, { status: 'partial', backup: null, failed: 'move' });
    }
    if (here) {
      try {
        const info = await lstat(dir);
        // 04 §4: never follow a link; the folder must be the OS user's real one.
        if (!info.isDirectory()) throw new Error('not a folder');
        movedRecord = {
          v: 1,
          startedAt: now(),
          agents: await agentIdsIn(dir),
          ownerTag: await ownerTagNow(keychain),
          done: false,
        };
        await writeRecord(dir, movedRecord);
      } catch {
        return answer(200, { status: 'partial', backup: null, failed: 'move' });
      }
      await options.closeOpen?.().catch(() => undefined);
      try {
        const target = await freeBackupPath();
        await move(dir, target);
        moved = target;
      } catch {
        await options.reopen?.().catch(() => undefined);
        return answer(200, { status: 'partial', backup: null, failed: 'move' });
      }
    }
    // 3: the IDs of this run and of every unfinished earlier one, then (only if all went) the owner.
    const todo = (await backups()).filter((b) => !b.record.done);
    if (moved !== undefined && movedRecord !== undefined && !todo.some((b) => b.path === moved)) {
      todo.unshift({ path: moved, record: movedRecord });
    }
    const agents = [...new Set(todo.flatMap((b) => b.record.agents))];
    const ok =
      (await eraseAgents(keychain, agents)) &&
      (await eraseOwner(keychain)) &&
      // 4: the records are done only when every account is gone, and the write must land.
      (await markDone(todo));
    await options.reopen?.().catch(() => undefined);
    const backupPath = moved ?? todo[0]?.path;
    const backup = backupPath === undefined ? null : shown(backupPath);
    return ok
      ? answer(200, { status: 'done', backup })
      : answer(200, { status: 'partial', backup, failed: 'keychain' });
  }

  /**
   * A refused gesture: its answer, and whether it counts toward the wait (only a gesture that was
   * made and not recognised does; a cancel, a missing sensor or a timeout does not).
   */
  interface Refusal {
    readonly answer: StartOverAnswer;
    readonly counts: boolean;
  }

  /** Desktop app: one OS sheet the server raises itself (the page cannot fake it). */
  async function nativeGesture(): Promise<Refusal | undefined> {
    const helper = options.native;
    if (helper === undefined) {
      return { answer: refuse(400, 'presence_required'), counts: false };
    }
    let record: Uint8Array | undefined;
    try {
      record = await helper.create();
      if (helper.kind === NATIVE_PRESENCE_MACOS) {
        // `create` shows no sheet on macOS: the one Touch ID sheet is this release (Q-153-3: the
        // sheet reads "start over AgentLink on this computer").
        wipe(await helper.release(record, 'reset'));
      } else {
        // Windows: `create` was the one Windows Hello prompt; the throwaway key goes.
        await helper.remove(record).catch(() => undefined);
      }
      return undefined;
    } catch (error) {
      const state = error instanceof NativeHelperError ? error.state : 'error';
      return {
        answer: answer(403, { error: 'presence_rejected', native: state }),
        counts: state === 'failed',
      };
    } finally {
      if (record !== undefined) wipe(record);
    }
  }

  /** Browser: a user-verified creation for this begin's challenge and origin. */
  function passkeyGesture(p: Pending, body: Uint8Array): Refusal | undefined {
    try {
      const registration = parseSetupRegistration(body);
      try {
        checkSetupRegistration(registration, { challenge: p.challenge, origin: options.origin });
      } finally {
        wipe(registration.prfOutput);
      }
      return undefined;
    } catch {
      return { answer: refuse(403, 'presence_rejected'), counts: true };
    }
  }

  /**
   * The gesture of this finish, by kind; undefined when it was made. A further kind (the no-sensor
   * path, owner decision pending: e.g. a second typed confirmation) is one more entry here plus a
   * `presence` value that begin answers.
   */
  function gesture(p: Pending, body: Uint8Array, phrase: unknown): Promise<Refusal | undefined> {
    switch (p.presence) {
      case 'native':
        return nativeGesture();
      case 'passkey':
        return Promise.resolve(passkeyGesture(p, body));
      case 'typed':
        // The second typing of the phrase, on its own step, checked here again. No body.
        return Promise.resolve(
          body.length === 0 && phraseMatches(phrase)
            ? undefined
            : { answer: refuse(400, 'phrase'), counts: false },
        );
    }
  }

  return Object.freeze<StartOverEngine>({
    async state() {
      const unfinished = (await backups()).some((b) => !b.record.done);
      const presence = await presenceFor(false);
      // A sensor that is there but not usable right now still shows its own button.
      return answer(200, { presence: presence === 'retry' ? 'native' : presence, unfinished });
    },

    async begin(session, input) {
      if (closed) return refuse(503, 'closed');
      const at = now();
      if (refused.until > at) {
        return answer(429, { error: 'wait', retryAfter: Math.ceil((refused.until - at) / 1000) });
      }
      const given = beginInput(input);
      if (given === undefined) return refuse(400, 'phrase');
      const presence = await presenceFor(given.noSensor);
      // Touch ID locked out, or the helper did not answer: a fixed "try again", nothing started.
      if (presence === 'retry') return refuse(503, 'try_again');
      wipePending();
      const nonce = encodeBase64url(randomBytes(16));
      const challenge = randomBytes(32);
      pending = { session, nonce, challenge, presence, expires: now() + START_OVER_TTL_MS };
      const base = { status: 'presence', presence, nonce, expiresInMs: START_OVER_TTL_MS };
      if (presence !== 'passkey') return answer(200, base);
      return answer(200, {
        ...base,
        publicKey: {
          rpId: PASSKEY_RP_ID,
          rpName: 'AgentLink',
          userId: encodeBase64url(randomBytes(16)),
          userName: 'AgentLink start over',
          challenge: encodeBase64url(challenge),
        },
      });
    },

    async finish(session, input, mode, body) {
      if (closed) return refuse(503, 'closed');
      const given = finishInput(input);
      const nonce = given?.nonce;
      const p = pending;
      // Single use: whatever the outcome, this begin is spent (its challenge is wiped below).
      pending = undefined;
      if (
        nonce === undefined ||
        p === undefined ||
        p.session !== session ||
        !equalBytes(new TextEncoder().encode(p.nonce), new TextEncoder().encode(nonce))
      ) {
        if (p !== undefined) wipe(p.challenge);
        return refuse(400, 'expired');
      }
      try {
        if (p.expires < now()) return refuse(400, 'expired');
        if (mode !== p.presence) return refuse(400, 'presence_required');
        if (running) return refuse(409, 'busy');
        running = true;
        try {
          const refusal = await gesture(p, body, given?.phrase);
          if (refusal !== undefined) {
            if (!refusal.counts) return refusal.answer;
            refused.count += 1;
            if (refused.count >= FREE_TRIES) {
              const seconds = Math.min(
                MAX_WAIT_S,
                FIRST_WAIT_S * 2 ** (refused.count - FREE_TRIES),
              );
              refused.until = now() + seconds * 1000;
            }
            return refusal.answer;
          }
          refused = { count: 0, until: 0 };
          return await run();
        } finally {
          running = false;
        }
      } finally {
        wipe(p.challenge);
      }
    },

    close() {
      closed = true;
      wipePending();
    },
  });
}
