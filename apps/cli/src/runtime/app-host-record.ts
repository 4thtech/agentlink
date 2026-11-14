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
//
// APP-CONTINUITY (08 §1 "One AgentLink, browser or app"): the desktop app's record adds
// `"host":"desktop"`. Before its own host starts, the app takes over a terminal `agentlink ui` host
// (`POST /api/ui/host/yield`, same rules, empty body) or clears a stale record; terminal
// `agentlink ui` asks a running desktop app to show its window (`POST /api/ui/host/show`) instead of
// starting a second host. The token grants nothing more than a same-user process already has
// (stopping a process, opening the app).
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
/** APP-CONTINUITY: the takeover and show paths (packages/node HOST_YIELD_PATH, HOST_SHOW_PATH). */
export const HOST_YIELD_PATH = '/api/ui/host/yield';
export const HOST_SHOW_PATH = '/api/ui/host/show';
/** How long the desktop app waits for a host it took over to end (then it starts anyway). */
export const TAKEOVER_WAIT_MS = 8_000;
/** How long the one handoff request may take. */
export const HANDOFF_TIMEOUT_MS = 5_000;

export interface AppHostRecord {
  readonly pid: number;
  readonly port: number;
  readonly handoffToken: string;
  /** APP-CONTINUITY: the desktop app's host says so; a terminal `agentlink ui` host has none. */
  readonly host?: 'desktop';
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
  const keys = Object.keys(record).sort().join(',');
  // APP-CONTINUITY: `host` is optional and only ever "desktop" (an older CLI ignores such a record
  // and starts its own host, as with no record).
  if (
    (keys !== 'handoffToken,pid,port,v' && keys !== 'handoffToken,host,pid,port,v') ||
    record['v'] !== 1
  ) {
    return undefined;
  }
  const { pid, port, handoffToken, host } = record;
  if (
    !isPid(pid) ||
    !isPort(port) ||
    typeof handoffToken !== 'string' ||
    !TOKEN.test(handoffToken) ||
    (host !== undefined && host !== 'desktop')
  ) {
    return undefined;
  }
  return Object.freeze(
    host === 'desktop' ? { pid, port, handoffToken, host } : { pid, port, handoffToken },
  );
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
      `${JSON.stringify({
        v: 1,
        pid: record.pid,
        port: record.port,
        handoffToken: record.handoffToken,
        ...(record.host === 'desktop' ? { host: 'desktop' } : {}),
      })}\n`,
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

export type HostCallOutcome = 'done' | 'kept' | 'failed';

/**
 * APP-CONTINUITY (08 §1 "One AgentLink, browser or app"): one empty request of the handoff kind to
 * the running host, exactly like the handoff (127.0.0.1, `Host: localhost:<port>`, the token, no
 * Origin, no cookie). `done` on 200, `kept` on 409 or 404 (an older host without the route).
 */
export function sendHostCall(
  record: AppHostRecord,
  call: 'yield' | 'show',
  timeoutMs: number = HANDOFF_TIMEOUT_MS,
): Promise<HostCallOutcome> {
  return new Promise<HostCallOutcome>((resolve) => {
    let done = false;
    const finish = (outcome: HostCallOutcome): void => {
      if (done) return;
      done = true;
      resolve(outcome);
    };
    const req = request(
      {
        host: '127.0.0.1',
        port: record.port,
        path: call === 'yield' ? HOST_YIELD_PATH : HOST_SHOW_PATH,
        method: 'POST',
        setHost: false,
        agent: false,
        timeout: timeoutMs,
        headers: {
          Host: `localhost:${String(record.port)}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': '0',
          'X-AgentLink-Handoff': record.handoffToken,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode === 200) return finish('done');
          if (res.statusCode === 409 || res.statusCode === 404) return finish('kept');
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
    req.end();
  });
}

export type TakeoverOutcome = 'none' | 'stale' | 'yielded' | 'kept';

export interface TakeoverOptions {
  /** How long to wait for the host to end (default TAKEOVER_WAIT_MS). */
  readonly waitMs?: number;
  readonly alive?: (pid: number) => boolean;
}

/**
 * APP-CONTINUITY: before the desktop app's own host starts. No record (or this process's): `none`.
 * A record whose process is gone (a crash): removed, `stale`. A terminal `agentlink ui` host: asked
 * to close (it answers, then closes its server and removes its record) and waited for: `yielded`.
 * Another desktop app, an older host without the route, or no answer: `kept` (both run, each on
 * its own port; nothing breaks). Never throws.
 */
export async function takeOverAppHost(
  home: string,
  options: TakeoverOptions = {},
): Promise<TakeoverOutcome> {
  const alive = options.alive ?? pidAlive;
  const record = await readAppHostRecord(home);
  if (record === undefined || record.pid === process.pid) return 'none';
  if (!alive(record.pid)) {
    // Only this exact record (another host may have replaced it meanwhile).
    await removeAppHostRecord(home, record.pid);
    return 'stale';
  }
  if (record.host === 'desktop') return 'kept';
  const asked = await sendHostCall(record, 'yield').catch(() => 'failed' as const);
  if (asked !== 'done') return 'kept';
  const until = Date.now() + (options.waitMs ?? TAKEOVER_WAIT_MS);
  while (Date.now() < until) {
    const now = await readAppHostRecord(home);
    if (!alive(record.pid) || now === undefined || now.pid !== record.pid) return 'yielded';
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return 'kept';
}

/**
 * APP-CONTINUITY: terminal `agentlink ui` while the desktop app runs: ask it to show its window
 * (`shown`) instead of starting a second host. Anything else (no record, a terminal host, a stale
 * record, no answer): `none`, and `ui` starts as before. Never throws.
 */
export async function showRunningApp(
  home: string,
  alive: (pid: number) => boolean = pidAlive,
): Promise<'shown' | 'none'> {
  const record = await readAppHostRecord(home);
  if (record?.host !== 'desktop' || record.pid === process.pid || !alive(record.pid)) {
    return 'none';
  }
  const asked = await sendHostCall(record, 'show').catch(() => 'failed' as const);
  return asked === 'done' ? 'shown' : 'none';
}
