// R1: why the app host last closed. `~/.agentlink/last-exit.json`, mode 0600, written atomically and
// overwritten by every `ui` run: `{"v":1,"at":<unix seconds>,"version":"<x.y.z>","reason":"<code>"}`.
// The reason is one of a closed set of fixed codes; no name, label, path, message, URL or token ever
// reaches this file (I-7), and a record that does not match this exact shape is ignored. `agentlink
// doctor` reads it. Writing never throws: a computer that cannot take the file just has no record.
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';

export const LAST_EXIT_FILE = 'last-exit.json';

export const LAST_EXIT_REASONS = Object.freeze([
  'ctrl_c',
  'sigterm',
  'sighup',
  'idle',
  // APP-CONTINUITY: the desktop app took over this terminal host.
  'moved_to_app',
  'uncaught',
  'rejections',
  'start_no_owner',
  'start_no_ids',
  'start_removing',
  'start_port',
  'start_keychain',
  'start_open',
  'start_broken_id',
  'start_failed',
  // BROWSER-UPDATE: Restart now in Settings › Updates handed this terminal to the new version.
  'updated',
] as const);

export type LastExitReason = (typeof LAST_EXIT_REASONS)[number];

export interface LastExit {
  /** Unix seconds. */
  readonly at: number;
  readonly version: string;
  readonly reason: LastExitReason;
}

const MAX_BYTES = 512;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const POSIX = process.platform !== 'win32';

const isReason = (value: unknown): value is LastExitReason =>
  typeof value === 'string' && (LAST_EXIT_REASONS as readonly string[]).includes(value);

const pathOf = (home: string): string => join(home, '.agentlink', LAST_EXIT_FILE);

/** Writes the record (a fresh private temporary file renamed over the old one). Never throws. */
export async function writeLastExit(
  home: string,
  record: { readonly reason: LastExitReason; readonly version: string; readonly at?: number },
): Promise<void> {
  try {
    if (!isReason(record.reason)) return;
    const version = VERSION.test(record.version) ? record.version : '0.0.0';
    const at = record.at ?? Math.floor(Date.now() / 1000);
    const root = join(home, '.agentlink');
    await mkdir(root, { recursive: true, mode: DIR_MODE });
    const temp = join(root, `.${LAST_EXIT_FILE}.${encodeHex(randomBytes(8))}.tmp`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      FILE_MODE,
    );
    try {
      if (POSIX) await handle.chmod(FILE_MODE);
      await handle.writeFile(
        `${JSON.stringify({ v: 1, at, version, reason: record.reason })}\n`,
        'utf8',
      );
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, pathOf(home));
    } catch {
      await unlink(temp).catch(() => undefined);
    }
  } catch {
    // No record is better than a failed close.
  }
}

/** The record, or undefined (missing, a link, oversized, not exactly this shape, unknown reason). */
export async function readLastExit(home: string): Promise<LastExit | undefined> {
  try {
    const handle = await open(
      pathOf(home),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES) return undefined;
      const buffer = Buffer.alloc(MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES, 0);
      const parsed: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
      );
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
      const r = parsed as Record<string, unknown>;
      if (Object.keys(r).sort().join(',') !== 'at,reason,v,version' || r['v'] !== 1) {
        return undefined;
      }
      const { at, version, reason } = r;
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined;
      if (typeof version !== 'string' || !VERSION.test(version) || !isReason(reason)) {
        return undefined;
      }
      return Object.freeze({ at, version, reason });
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
