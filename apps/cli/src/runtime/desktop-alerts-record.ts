// N7 (PLAN-NOTIFY §3.5; S2): while the desktop app runs, it owns the OS notifications (Electron's
// Notification in its main process). Its core host marks that in `~/.agentlink/desktop-alerts.json`
// (`{"v":1,"pid":n}`, mode 0600, written through a fresh temporary file and a rename, removed when
// it stops), and `agentlink mcp` then raises no osascript / notify-send alert for a new approval, so
// the owner never gets two. The browser/CLI app keeps today's alert and its switch.
//
// The record holds a process ID only. It is read like app-host.json: opened without following a
// link, a regular file of this user with no group or other access, at most MAX_RECORD_BYTES, exactly
// `{v: 1, pid}`; anything else does not count. A record whose process is gone does not count either.
// The worst a same-user process can do with it is silence the osascript alert (the approval still
// waits on Home and in the AI app's answer), which it could already do by other means (04 §2.5).
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { pidAlive } from './app-host-record.js';

/** The record's file name under `~/.agentlink`. */
export const DESKTOP_ALERTS_FILE = 'desktop-alerts.json';
const MAX_RECORD_BYTES = 128;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const POSIX = process.platform !== 'win32';

const recordPath = (home: string): string => join(home, '.agentlink', DESKTOP_ALERTS_FILE);

const ownUid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

/** The pid in a record's text, or undefined for any other shape. */
function parseRecord(text: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'pid,v' || record['v'] !== 1) return undefined;
  const pid = record['pid'];
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** The recorded pid, or undefined (missing, a link, not private, not ours, oversized, malformed). */
async function readRecord(home: string): Promise<number | undefined> {
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

/** Marks that the desktop app (this pid) owns the OS notifications. */
export async function writeDesktopAlertsRecord(home: string, pid: number): Promise<void> {
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
    await handle.writeFile(`${JSON.stringify({ v: 1, pid })}\n`, 'utf8');
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
  if ((await readRecord(home)) !== pid) return;
  await unlink(recordPath(home)).catch(() => undefined);
}

/** True while a running desktop app owns the OS notifications. */
export async function desktopOwnsAlerts(
  home: string,
  alive: (pid: number) => boolean = pidAlive,
): Promise<boolean> {
  const pid = await readRecord(home);
  return pid !== undefined && alive(pid);
}

/**
 * Whether `agentlink mcp` may raise the osascript / notify-send approval alert: never while the
 * desktop app owns notifications; otherwise the owner's "Approvals waiting" switch (`approvalsOn`).
 */
export async function osApprovalAlertsOn(
  home: string,
  approvalsOn: () => Promise<boolean>,
  alive: (pid: number) => boolean = pidAlive,
): Promise<boolean> {
  if (await desktopOwnsAlerts(home, alive)) return false;
  return approvalsOn();
}
