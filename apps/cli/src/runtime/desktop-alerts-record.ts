// N7 (PLAN-NOTIFY §3.5; S2): while the desktop app runs, it owns the OS notifications for the ID it
// has open (Electron's Notification in its main process). Its core host marks that in
// `~/.agentlink/desktop-alerts.json`, and `agentlink mcp` for THAT ID then raises no osascript /
// notify-send alert for a new approval, so the owner never gets two. Every other ID keeps its alert
// (IR-N7-1 L-5), and so does the browser/CLI app, with its switch.
//
// The record is `{"v":1,"pid":n,"started":ms,"at":ms,"id":"<agent name>"}` (mode 0600, written
// through a fresh temporary file and a rename, removed when the host stops or no ID is open):
// - `id`: the open ID's folder name (an agent name), the only ID mcp stays quiet for;
// - `started`: when the host process started; `at`: when the record was last written. The host
//   renews it every minute (host-core.ts RECORD_RENEW_MS). A record is ignored when it is older than
//   RECORD_LEASE_MS, when its process started before this boot, or when that pid is not alive, so a
//   record left by a hard kill or a power loss stops counting even if the pid is reused (L-2).
//
// It is read like app-host.json: opened without following a link, a regular file of this user with
// no group or other access, at most MAX_RECORD_BYTES, exactly these keys; anything else does not
// count. The worst a same-user process can do with it is silence the osascript alert for one ID (the
// approval still waits on Home and in the AI app's answer), which it could already do by other means
// (04 §2.5; IR-N7-1 L-1).
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { pidAlive } from './app-host-record.js';
import { isAgentName } from './agent-name.js';

/** The record's file name under `~/.agentlink`. */
export const DESKTOP_ALERTS_FILE = 'desktop-alerts.json';
/** A record not renewed for this long no longer counts (the host renews it every minute). */
export const RECORD_LEASE_MS = 3 * 60_000;
/** Clock slack for the boot comparison. */
const BOOT_SLACK_MS = 60_000;
const MAX_RECORD_BYTES = 256;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const POSIX = process.platform !== 'win32';

export interface DesktopAlertsRecord {
  readonly pid: number;
  /** When the host process started (ms since the epoch). */
  readonly started: number;
  /** When this record was written (ms since the epoch). */
  readonly at: number;
  /** The ID the desktop app alerts for (an agent name). */
  readonly id: string;
}

/** The checks a reader makes (tests replace them). */
export interface DesktopAlertsChecks {
  readonly alive?: (pid: number) => boolean;
  /** Now, ms since the epoch. */
  readonly now?: () => number;
  /** When this machine booted, ms since the epoch. */
  readonly bootedAt?: () => number;
}

const recordPath = (home: string): string => join(home, '.agentlink', DESKTOP_ALERTS_FILE);

const ownUid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

const whole = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** The record from its text, or undefined for any other shape. */
function parseRecord(text: string): DesktopAlertsRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'at,id,pid,started,v' || record['v'] !== 1) {
    return undefined;
  }
  const { pid, started, at, id } = record;
  if (!whole(pid) || !whole(started) || !whole(at) || !isAgentName(id)) return undefined;
  return Object.freeze({ pid, started, at, id });
}

/** The record, or undefined (missing, a link, not private, not ours, oversized, malformed). */
async function readRecord(home: string): Promise<DesktopAlertsRecord | undefined> {
  try {
    const handle = await open(
      recordPath(home),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) return undefined;
      if (POSIX && ((info.mode & 0o077) !== 0 || info.uid !== ownUid())) return undefined;
      if (info.size > MAX_RECORD_BYTES) return undefined;
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_RECORD_BYTES) return undefined;
      return parseRecord(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
      );
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** When this process started (ms since the epoch). */
export function processStartedAt(): number {
  return Math.max(1, Math.round(Date.now() - process.uptime() * 1000));
}

/** Marks that the desktop app (this pid) owns the OS notifications for `id`. */
export async function writeDesktopAlertsRecord(
  home: string,
  record: { readonly pid: number; readonly started: number; readonly id: string },
  now: () => number = Date.now,
): Promise<void> {
  if (!isAgentName(record.id) || !whole(record.pid) || !whole(record.started)) {
    throw new Error('desktop alerts record: invalid');
  }
  const root = join(home, '.agentlink');
  await mkdir(root, { recursive: true, mode: DIR_MODE });
  const temp = join(root, `.${DESKTOP_ALERTS_FILE}.${encodeHex(randomBytes(8))}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  );
  try {
    if (POSIX) await handle.chmod(FILE_MODE);
    const body = { v: 1, pid: record.pid, started: record.started, at: now(), id: record.id };
    await handle.writeFile(`${JSON.stringify(body)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, recordPath(home));
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Removes the mark only while it is still this pid's. */
export async function removeDesktopAlertsRecord(home: string, pid: number): Promise<void> {
  if ((await readRecord(home))?.pid !== pid) return;
  await unlink(recordPath(home)).catch(() => undefined);
}

/** True while a running desktop app owns the OS notifications for the ID `id`. */
export async function desktopAlertsFor(
  home: string,
  id: string,
  checks: DesktopAlertsChecks = {},
): Promise<boolean> {
  const record = await readRecord(home);
  if (record === undefined || record.id !== id) return false;
  const now = (checks.now ?? Date.now)();
  const bootedAt = (checks.bootedAt ?? (() => Date.now() - uptime() * 1000))();
  // A record from before this boot, from a process that started before it, or not renewed.
  if (record.started < bootedAt - BOOT_SLACK_MS) return false;
  if (record.at < record.started || now - record.at > RECORD_LEASE_MS) return false;
  return (checks.alive ?? pidAlive)(record.pid);
}

/**
 * Whether `agentlink mcp` for the ID `id` may raise the osascript / notify-send approval alert: not
 * while the desktop app alerts for that ID; otherwise the owner's "Approvals waiting" switch.
 */
export async function osApprovalAlertsOn(
  home: string,
  id: string,
  approvalsOn: () => Promise<boolean>,
  checks: DesktopAlertsChecks = {},
): Promise<boolean> {
  if (await desktopAlertsFor(home, id, checks)) return false;
  return approvalsOn();
}
