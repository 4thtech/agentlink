// U3-invite: the app host's handoff record and the one loopback handoff (08 §4 "An app host already
// running"; 04 §2.5; I-2, I-7).
//
// `~/.agentlink/app-host.json`, mode 0600, written by a running `ui` host once it listens and removed
// when it closes: `{"v":1,"pid":<n>,"port":<n>,"handoffToken":"<43 base64url>"}`. The token is 32
// random bytes from the host (packages/node), not the page's session token, and grants only one
// thing: setting a waiting invite, which still needs the owner's Touch ID to accept.
//
// `agentlink join` reads it (never following a link; a non-private, foreign, oversized or malformed
// file is ignored), checks that the pid is alive, and sends exactly one request: `POST
// /api/ui/join/handoff` to 127.0.0.1:<port> (no name is resolved) with `Host: localhost:<port>`,
// the token in `X-AgentLink-Handoff`, no Origin, no cookie, and the body `{"invite":"<link>"}` as
// octet-stream. The invite is only in that body: never in the URL, a query, a header, the record, a
// log or an error. Any failure is a plain outcome word; nothing here prints.
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';

/** The record's file name under `~/.agentlink`. */
export const APP_HOST_FILE = 'app-host.json';
/** A valid record is about 120 bytes; anything larger is ignored unread. */
const MAX_RECORD_BYTES = 512;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const POSIX = process.platform !== 'win32';
/** The handoff path (packages/node JOIN_HANDOFF_PATH; a test keeps them equal). */
export const HANDOFF_PATH = '/api/ui/join/handoff';
/** How long the one handoff request may take. */
export const HANDOFF_TIMEOUT_MS = 5_000;

export interface AppHostRecord {
  readonly pid: number;
  readonly port: number;
  readonly handoffToken: string;
}

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
const isPid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** The record from its JSON text, or undefined for any other shape. */
export function parseAppHostRecord(text: string): AppHostRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'handoffToken,pid,port,v' || record['v'] !== 1) {
    return undefined;
  }
  const { pid, port, handoffToken } = record;
  if (
    !isPid(pid) ||
    !isPort(port) ||
    typeof handoffToken !== 'string' ||
    !TOKEN.test(handoffToken)
  ) {
    return undefined;
  }
  return Object.freeze({ pid, port, handoffToken });
}

const recordPath = (home: string): string => join(home, '.agentlink', APP_HOST_FILE);

const ownUid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

/** Reads the record, or undefined (missing, a link, not private, not ours, oversized, malformed). */
export async function readAppHostRecord(home: string): Promise<AppHostRecord | undefined> {
  try {
    // Opened first, never following a link; every check is on the open handle (fstat), so nothing
    // can be swapped between a check and the read.
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
      return parseAppHostRecord(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
      );
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Writes the record with mode 0600: a fresh temporary file (exclusive, no link) renamed in place. */
export async function writeAppHostRecord(home: string, record: AppHostRecord): Promise<void> {
  const root = join(home, '.agentlink');
  await mkdir(root, { recursive: true, mode: DIR_MODE });
  const temp = join(root, `.${APP_HOST_FILE}.${encodeHex(randomBytes(8))}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  );
  try {
    if (POSIX) await handle.chmod(FILE_MODE);
    await handle.writeFile(
      `${JSON.stringify({ v: 1, pid: record.pid, port: record.port, handoffToken: record.handoffToken })}\n`,
      'utf8',
    );
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

/** Removes the record only while it is still this process's (another host may have replaced it). */
export async function removeAppHostRecord(home: string, pid: number = process.pid): Promise<void> {
  const current = await readAppHostRecord(home);
  if (current?.pid !== pid) return;
  await unlink(recordPath(home)).catch(() => undefined);
}

/** True when `pid` is a live process of this user (signal 0; EPERM means another user's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type HandoffOutcome = 'waiting' | 'invite_waiting' | 'failed';

/**
 * The one loopback handoff (08 §4). Connects to 127.0.0.1:<port> (never a name) with exactly
 * `Host: localhost:<port>`, the token header, octet-stream and the body; no Origin, no cookie.
 */
export function sendHandoff(
  record: AppHostRecord,
  link: string,
  timeoutMs: number = HANDOFF_TIMEOUT_MS,
): Promise<HandoffOutcome> {
  const body = Buffer.from(JSON.stringify({ invite: link }), 'utf8');
  return new Promise<HandoffOutcome>((resolve) => {
    let done = false;
    const finish = (outcome: HandoffOutcome): void => {
      if (done) return;
      done = true;
      body.fill(0);
      resolve(outcome);
    };
    const req = request(
      {
        host: '127.0.0.1',
        port: record.port,
        path: HANDOFF_PATH,
        method: 'POST',
        setHost: false,
        agent: false,
        timeout: timeoutMs,
        headers: {
          Host: `localhost:${String(record.port)}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.length),
          'X-AgentLink-Handoff': record.handoffToken,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 1_024) chunks.push(chunk);
        });
        res.on('end', () => {
          if (res.statusCode === 200) return finish('waiting');
          if (res.statusCode === 409) {
            try {
              const answer = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
              if (
                typeof answer === 'object' &&
                answer !== null &&
                (answer as Record<string, unknown>)['error'] === 'invite_waiting'
              ) {
                return finish('invite_waiting');
              }
            } catch {
              // fall through
            }
          }
          finish('failed');
        });
        res.on('error', () => finish('failed'));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish('failed');
    });
    req.on('error', () => finish('failed'));
    req.end(body);
  });
}
