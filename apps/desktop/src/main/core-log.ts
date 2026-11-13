// The core's stderr, kept for diagnosis (desktop start UX, 2026-11-12). Before this, the core's
// stdio was ignored, so a core that died before `ready` left no trace at all.
//
// - Only stderr is read (stdout stays ignored; the session link travels on fd 3 only).
// - The core writes fixed lines there (host-main.ts, output.ts; its logger is silent unless
//   AGENTLINK_LOG is set, and the shell never passes that). Every line is still REDACTED before it
//   is kept anywhere, and before it is cut to length: links (`scheme://…`), loopback addresses,
//   `t=` and key=value secrets (JSON-quoted too), "code 123456"-style values, generated 24-character
//   codes, and runs of 32+ hex / base64 / base64url characters. Control characters are replaced;
//   lines are capped.
// - The folder and files are checked with lstat: a symlink or non-regular file turns the disk log
//   off (the memory ring still works); the file is opened with O_NOFOLLOW where the OS has it.
// - Memory: a ring of the last RING_LINES lines. Disk: `core.log` in the per-user log folder
//   (macOS ~/Library/Logs/AgentLink, Windows %LOCALAPPDATA%\AgentLink\logs), folder 0700, file 0600,
//   rotated to `core.1.log` at MAX_LOG_BYTES (one old file kept). Errors never reach the app.
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { join, posix, win32 } from 'node:path';

export const RING_LINES = 200;
export const MAX_LINE_CHARS = 1_000;
export const MAX_LOG_BYTES = 1_000_000;
export const CORE_LOG_FILE = 'core.log';
export const CORE_LOG_OLD_FILE = 'core.1.log';

const LINK = '[link removed]';

/** Append, create, write only; O_NOFOLLOW where the OS defines it (not on Windows). */
const APPEND_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  ((fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
const REMOVED = '[removed]';

/** Redacts one line (see the header). Never returns more than MAX_LINE_CHARS + 1 characters. */
export function redactLine(input: string): string {
  let line = input
    .replace(/\r/g, '')
    // Any URL-like text: scheme://…
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, LINK)
    // Loopback addresses without a scheme (a session link minus "http://").
    .replace(/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?\S*/gi, LINK)
    // Token parameters and key=value / key: value secrets.
    .replace(/\bt=\S+/g, `t=${REMOVED}`)
    // Also JSON-quoted keys and values: "passphrase": "a b c" or 'token':'…'.
    .replace(
      /\b(token|secret|passphrase|password|code|key|seed|salt)(["']?\s*[:=]\s*)(?:"[^"]*"?|'[^']*'?|\S+)/gi,
      `$1$2${REMOVED}`,
    )
    // "code 123456", "passphrase hunter22": a secret word, then a value with a digit (6+ chars).
    .replace(
      /\b(token|secret|passphrase|password|code|seed|salt)(\s+)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{6,}/gi,
      `$1$2${REMOVED}`,
    )
    // A generated master or recovery code (24 base32 characters, 04 §2.8), whole or in groups.
    .replace(/\b[A-Z2-7]{4}(?:[ -]?[A-Z2-7]{4}){5}\b/g, REMOVED)
    // Long hex / base64url / base64 runs (no slash).
    .replace(/[A-Za-z0-9+_=-]{32,}/g, REMOVED)
    // Standard base64 with slashes: removed when it has a digit, '+' or '=' (paths rarely do).
    .replace(/[A-Za-z0-9+/=]{32,}/g, (run) => (/[0-9+=]/.test(run) ? REMOVED : run))
    // Control characters (keeps tabs).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?');
  if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}…`;
  return line;
}

/** The per-user log folder of the desktop app. */
export function logDir(
  platform: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === 'darwin') return posix.join(home, 'Library', 'Logs', 'AgentLink');
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    const base =
      local !== undefined && win32.isAbsolute(local) ? local : win32.join(home, 'AppData', 'Local');
    return win32.join(base, 'AgentLink', 'logs');
  }
  const state = env['XDG_STATE_HOME'];
  const base =
    state !== undefined && posix.isAbsolute(state) ? state : posix.join(home, '.local', 'state');
  return posix.join(base, 'agentlink', 'logs');
}

export interface CoreLogOptions {
  readonly dir: string;
  readonly maxBytes?: number;
}

/** The redacted ring and file. */
export class CoreLog {
  readonly #dir: string;
  readonly #file: string;
  readonly #old: string;
  readonly #maxBytes: number;
  readonly #ring: string[] = [];
  readonly #decoder = new TextDecoder('utf-8');
  #partial = '';
  /** True while the rest of an overlong line is being dropped (no secret is split in two). */
  #dropping = false;
  #size = -1;
  #disabled = false;

  constructor(options: CoreLogOptions) {
    this.#dir = options.dir;
    this.#file = join(options.dir, CORE_LOG_FILE);
    this.#old = join(options.dir, CORE_LOG_OLD_FILE);
    this.#maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  }

  get dir(): string {
    return this.#dir;
  }

  /** The last lines (redacted), oldest first. */
  lines(): readonly string[] {
    return [...this.#ring];
  }

  /** A chunk of the core's stderr. */
  write(chunk: Uint8Array | string): void {
    const text = typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    const parts = text.split('\n');
    const last = parts.pop() ?? '';
    for (const part of parts) {
      if (this.#dropping) {
        this.#dropping = false;
        this.#partial = '';
        continue;
      }
      this.#keep(this.#partial + part);
      this.#partial = '';
    }
    if (this.#dropping) return;
    this.#partial += last;
    if (this.#partial.length > MAX_LINE_CHARS * 4) {
      // Redact the whole run first, then cut (redactLine caps the length). Its last word may go on
      // in the next chunk, so it is dropped, never kept half (a cut secret could escape redaction).
      this.#keep(this.#partial.replace(/\S+$/, '…'));
      this.#partial = '';
      this.#dropping = true;
    }
  }

  /** A fixed line from the shell itself (core started / exited), with the time. */
  note(text: string): void {
    this.flush();
    this.#keep(`--- ${new Date().toISOString()} ${text}`);
  }

  /** Keeps an unterminated last line (the core exited). */
  flush(): void {
    if (this.#partial !== '' && !this.#dropping) this.#keep(this.#partial);
    this.#partial = '';
    this.#dropping = false;
  }

  #keep(raw: string): void {
    const line = redactLine(raw);
    this.#ring.push(line);
    if (this.#ring.length > RING_LINES) this.#ring.splice(0, this.#ring.length - RING_LINES);
    this.#append(`${line}\n`);
  }

  /** Creates the log folder (0700) if needed, e.g. before it is opened in the file manager. */
  ensureDir(): boolean {
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      // lstat: never follow a symlink put in place of the log folder.
      if (!lstatSync(this.#dir).isDirectory()) return false;
      chmodSync(this.#dir, 0o700);
      return true;
    } catch {
      return false;
    }
  }

  #append(text: string): void {
    if (this.#disabled) return;
    try {
      if (this.#size < 0) {
        if (!this.ensureDir()) throw new Error('core log: no folder');
        const info = lstatOrNull(this.#file);
        if (info !== null && !info.isFile()) throw new Error('core log: not a regular file');
        this.#size = info?.size ?? 0;
        if (info !== null) chmodSync(this.#file, 0o600);
        const old = lstatOrNull(this.#old);
        if (old !== null && !old.isFile()) throw new Error('core log: not a regular file');
      }
      const bytes = Buffer.byteLength(text, 'utf8');
      if (this.#size > 0 && this.#size + bytes > this.#maxBytes) {
        renameSync(this.#file, this.#old);
        chmodSync(this.#old, 0o600);
        this.#size = 0;
      }
      const fd = openSync(this.#file, APPEND_FLAGS, 0o600);
      try {
        if (!fstatSync(fd).isFile()) throw new Error('core log: not a regular file');
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      this.#size += bytes;
    } catch {
      // A log that cannot be written is skipped; the ring in memory still works.
      this.#disabled = true;
    }
  }
}
