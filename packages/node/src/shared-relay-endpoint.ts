// RELAY-SHARED-CONN L3 (D-159; 04 §4 "Local relay link"): where the per-user shared relay link
// listens, the checks on that place, and the token file every program of this user proves it knows.
//
// - Unix (macOS, Linux, WSL): the socket `<home>/.agentlink/run/relay.sock` in the folder
//   `<home>/.agentlink/run`, created 0700. `lstat` (never following a link) checks, before a connect
//   and right after a bind, that the folder is a real folder of this uid with no group or other
//   permission, and that the socket is a socket of this uid. When that path passes the platform's
//   socket-path limit (sun_path: 104 bytes with the closing NUL on macOS, 108 on Linux), a short
//   per-user path is used instead: `<tmpdir>/agentlink-<uid>/r<hash>.sock` (`<hash>` the first
//   16 hex of SHA-256 of the home path, so each home has its own), else the same under `/tmp`. Its
//   folder gets the same checks; another user who made that folder first only turns sharing off
//   (the program uses its own connections), never gets in.
// - Windows: the named pipe `\\.\pipe\agentlink-relay-<hash>`, same hash. Node cannot set a pipe's
//   access list and pipe names are shared by all users, so the token proof is the only guard.
// - The token: `<home>/.agentlink/run/relay-link.json`, `{"v":1,"token":"<64 hex>"}`, mode 0600, 32
//   bytes from the crypto package's random source. Created atomically (a fresh exclusive temporary
//   file, then a hard link that fails if another program made it first, so racing programs agree);
//   reused by every program of this user; replaced (rename) when it is missing a valid value, a link
//   or not private. Read without following a link and checked on the open handle. Never logged.
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { decodeHex, encodeHex, encodeUtf8, randomBytes, sha256 } from '@4thtech-io/crypto';

/** The run folder under `<home>/.agentlink`. */
export const RELAY_RUN_DIR = 'run';
/** The socket's file name in the run folder. */
export const RELAY_SOCKET_FILE = 'relay.sock';
/** The token file's name in the run folder. */
export const RELAY_TOKEN_FILE = 'relay-link.json';
/** The longest socket path (bytes, without the closing NUL) per platform. */
export const SOCKET_PATH_MAX_BYTES = { darwin: 103, other: 107 } as const;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_TOKEN_FILE_BYTES = 256;
const TOKEN_HEX = /^[0-9a-f]{64}$/;

/** Where the shared link listens. `dir` is the folder the Unix checks cover. */
export type RelayEndpoint =
  | { readonly kind: 'unix'; readonly path: string; readonly dir: string }
  | { readonly kind: 'pipe'; readonly path: string };

export interface EndpointPlatform {
  readonly platform?: NodeJS.Platform;
  readonly tmpdir?: () => string;
  readonly uid?: () => number | undefined;
}

/** What `lstat` answers; injected in tests to simulate another user. */
export type LstatFn = (path: string) => Promise<Stats>;

export const ownUid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

/** The first 16 hex of SHA-256 of the home path (pipe and short-path names). */
function homeHash(home: string): string {
  return encodeHex(sha256(encodeUtf8(home))).slice(0, 16);
}

/** The endpoint for `home`, or undefined when no short path fits (sharing is then off). */
export function resolveEndpoint(
  home: string,
  env: EndpointPlatform = {},
): RelayEndpoint | undefined {
  const platform = env.platform ?? process.platform;
  if (platform === 'win32') {
    return { kind: 'pipe', path: `\\\\.\\pipe\\agentlink-relay-${homeHash(home)}` };
  }
  const limit = platform === 'darwin' ? SOCKET_PATH_MAX_BYTES.darwin : SOCKET_PATH_MAX_BYTES.other;
  const dir = join(home, '.agentlink', RELAY_RUN_DIR);
  const path = join(dir, RELAY_SOCKET_FILE);
  if (Buffer.byteLength(path) <= limit) return { kind: 'unix', path, dir };
  const uid = (env.uid ?? ownUid)();
  if (uid === undefined) return undefined;
  for (const base of [(env.tmpdir ?? osTmpdir)(), '/tmp']) {
    const shortDir = join(base, `agentlink-${uid}`);
    const shortPath = join(shortDir, `r${homeHash(home)}.sock`);
    if (Buffer.byteLength(shortPath) <= limit)
      return { kind: 'unix', path: shortPath, dir: shortDir };
  }
  return undefined;
}

const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

/** The run folder (or the short path's folder) is a real 0700 folder of this uid. */
export async function checkDir(
  dir: string,
  lstatFn: LstatFn = lstat,
  uid: () => number | undefined = ownUid,
): Promise<boolean> {
  try {
    const info = await lstatFn(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    const own = uid();
    if (own === undefined || info.uid !== own) return false;
    return (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** Creates the folder 0700 when missing, then checks it. */
export async function ensureDir(
  dir: string,
  lstatFn: LstatFn = lstat,
  uid: () => number | undefined = ownUid,
): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
  } catch {
    return false;
  }
  return checkDir(dir, lstatFn, uid);
}

/** `missing`, `ok` (a socket of this uid), or `unsafe` (anything else, a link included). */
export async function checkSocket(
  path: string,
  lstatFn: LstatFn = lstat,
  uid: () => number | undefined = ownUid,
): Promise<'missing' | 'ok' | 'unsafe'> {
  let info: Stats;
  try {
    info = await lstatFn(path);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'missing' : 'unsafe';
  }
  if (info.isSymbolicLink() || !info.isSocket()) return 'unsafe';
  const own = uid();
  return own !== undefined && info.uid === own ? 'ok' : 'unsafe';
}

type TokenRead =
  | { readonly ok: true; readonly token: Uint8Array }
  | { readonly ok: false; readonly missing: boolean };

async function readToken(file: string): Promise<TokenRead> {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    return { ok: false, missing: errorCode(error) === 'ENOENT' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_TOKEN_FILE_BYTES) return { ok: false, missing: false };
    if (process.platform !== 'win32') {
      if ((info.mode & 0o077) !== 0 || info.uid !== ownUid()) return { ok: false, missing: false };
    }
    const buffer = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_TOKEN_FILE_BYTES) return { ok: false, missing: false };
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, missing: false };
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(',');
    const value = record['token'];
    if (
      keys !== 'token,v' ||
      record['v'] !== 1 ||
      typeof value !== 'string' ||
      !TOKEN_HEX.test(value)
    ) {
      return { ok: false, missing: false };
    }
    return { ok: true, token: decodeHex(value, { length: 32 }) };
  } catch {
    return { ok: false, missing: false };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Writes a fresh token to an exclusive temporary file next to `file`; returns its path. */
async function writeTemp(dir: string): Promise<string> {
  const temp = join(dir, `.relay-link-${encodeHex(randomBytes(8))}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  );
  try {
    await handle.writeFile(JSON.stringify({ v: 1, token: encodeHex(randomBytes(32)) }));
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  return temp;
}

/**
 * The token every program of this user shares: read, or created when missing, or replaced when not
 * valid. Undefined when the run folder is unusable or the file cannot be written (sharing is off).
 */
export async function ensureLinkToken(home: string): Promise<Uint8Array | undefined> {
  const dir = join(home, '.agentlink', RELAY_RUN_DIR);
  const file = join(dir, RELAY_TOKEN_FILE);
  if (process.platform === 'win32') {
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      return undefined;
    }
  } else if (!(await ensureDir(dir))) {
    return undefined;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await readToken(file);
    if (read.ok) return read.token;
    let temp: string | undefined;
    try {
      temp = await writeTemp(dir);
      if (read.missing) {
        try {
          await link(temp, file); // fails if another program created it first: then read theirs
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
        }
      } else {
        await rename(temp, file);
        temp = undefined;
      }
    } catch {
      // try again (bounded), then give up: the program uses its own connections
    } finally {
      if (temp !== undefined) await unlink(temp).catch(() => undefined);
    }
  }
  const last = await readToken(file);
  return last.ok ? last.token : undefined;
}
