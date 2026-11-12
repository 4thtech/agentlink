// DESK-D12c (S2; D-145 phase 2; 04 §2.3.4, §2.5 "Desktop app owner presence"; I-7): how core runs the
// first-party presence helper of the desktop app (DESK-D12b, apps/desktop/native/*/agentlink-presence.*,
// whose header is the contract). Fixed argv only:
//   available · create · check (macOS) · ecdh <reason> (macOS) · sign <reason> (Windows) · delete (Windows)
// with <reason> one of the fixed ids setup | approve | pay (display-only: the helper shows its own
// fixed text and releases the same secret for every reason). The record goes on stdin as lowercase
// hex and one newline; stdout is lowercase hex and one newline on success, nothing else is accepted;
// stderr carries at most one fixed diagnostic line of the macOS helper (DESK-NATIVE-DEBUG,
// "<stage> <domain> <code>", parsed strictly by readHelperDiagnostic; anything else is dropped). Every exit code maps to one fixed UI state (nativeUiState); no output or message
// of the helper ever reaches an error text, a log or the page. DESK-NATIVE-DEBUG: the fixed name of
// how a run ended (NativeHelperDetail: an exit code's name from the fixed table, a timeout, a kill,
// a spawn failure, a malformed or wrong-length output) rides on NativeHelperError.detail for the
// core's one diagnostic line (approval-server.ts nativeDiagnostic); it is never shown on the page.
//
// DESK-TOUCHID-FIX: the macOS helper may put the fixed note `note secureinput 1` before that line
// (secure input was on as its sheet was about to show); it becomes ONE fixed core diagnostic line
// (createNativeHelper `diagnose`). A cancelled or timed-out run is stopped with SIGTERM (the helper
// invalidates its Touch ID context, so no sheet is left on screen) and core waits for it to exit
// (SIGKILL after NATIVE_HELPER_KILL_GRACE_MS).
//
// The helper is spawned without a shell, with an empty environment (nothing of ours, no PATH, no
// HOME), stdin/stdout pipes only, a bounded stdout and a timeout. Its path is fixed by the app layout
// (desktopHelperPath): next to the bundled Node of the desktop app, never from an argument, an
// environment variable or inbound content.
//
// Honest strength (04 §2.3.4): while builds are unsigned, a same-user process can run the same helper
// with the same record and get the secret after the owner's gesture, exactly as a look-alike
// localhost page can ask for the passkey's PRF output. What it never gets is a secret WITHOUT the
// gesture: the macOS key is `.biometryCurrentSet` and `ecdh` first proves that without a gesture the
// Secure Enclave refuses; Windows Hello always prompts.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import {
  NATIVE_PRESENCE_MACOS,
  NATIVE_PRESENCE_WINDOWS,
  encodeHex,
  type NativePresenceKind,
} from '@4thtech-io/crypto';

/** The fixed reason ids (display-only). */
export const NATIVE_REASONS = Object.freeze(['setup', 'approve', 'pay'] as const);
export type NativeReason = (typeof NATIVE_REASONS)[number];

/** The helpers' fixed exit codes (identical on macOS and Windows; apps/desktop/build/native.mjs). */
export const NATIVE_HELPER_EXIT = Object.freeze({
  ok: 0,
  cancelled: 10,
  failed: 11,
  notInteractive: 12,
  keyUnusable: 13,
  lockout: 14,
  callerRefused: 15,
  notHardware: 16,
  attestationRetry: 17,
  weakKey: 18,
  usage: 64,
  badInput: 65,
  unavailable: 69,
  internalError: 70,
} as const);

/**
 * What the owner is told, fixed: `cancelled` (the prompt was closed, or the Mac is locked: try again),
 * `failed` (not recognised), `lockout` (too many tries: use the master code), `reregister` (the key is
 * no longer valid, e.g. fingers changed: turn it on again), `unavailable` (no Touch ID or Windows
 * Hello, or a key that is not hardware-backed: the master code is the way), `retry_later` (Windows
 * could not check the key yet), `timeout` (the prompt got no answer in NATIVE_HELPER_TIMEOUT_MS;
 * DESK-NATIVE-DEBUG), `error` (anything else).
 */
export type NativeUiState =
  | 'cancelled'
  | 'failed'
  | 'lockout'
  | 'reregister'
  | 'unavailable'
  | 'retry_later'
  | 'timeout'
  | 'error';

export const NATIVE_UI_STATES: readonly NativeUiState[] = Object.freeze([
  'cancelled',
  'failed',
  'lockout',
  'reregister',
  'unavailable',
  'retry_later',
  'timeout',
  'error',
]);

/** The fixed UI state of a helper exit code other than success (0 is `error`: never a refusal). */
export function nativeUiState(code: number | null): NativeUiState {
  switch (code) {
    case NATIVE_HELPER_EXIT.cancelled:
    case NATIVE_HELPER_EXIT.notInteractive:
      return 'cancelled';
    case NATIVE_HELPER_EXIT.failed:
      return 'failed';
    case NATIVE_HELPER_EXIT.lockout:
      return 'lockout';
    case NATIVE_HELPER_EXIT.keyUnusable:
      return 'reregister';
    case NATIVE_HELPER_EXIT.notHardware:
    case NATIVE_HELPER_EXIT.weakKey:
    case NATIVE_HELPER_EXIT.unavailable:
      return 'unavailable';
    case NATIVE_HELPER_EXIT.attestationRetry:
      return 'retry_later';
    default:
      return 'error';
  }
}

/**
 * DESK-NATIVE-DEBUG: how a helper run ended, as a fixed name (for the diagnostic line only): the
 * exit code's name (`exit_<name>`, `exit_other` for a code outside the table), `timeout`, `aborted`
 * (the page went away), `no_start` (spawn failed), `killed` (ended by a signal from outside),
 * `too_much_output`, `bad_output` (not lowercase
 * hex and one newline) or `wrong_length` (a secret of the wrong size).
 */
export type NativeHelperDetail =
  | `exit_${keyof typeof NATIVE_HELPER_EXIT}`
  | 'exit_other'
  | 'timeout'
  | 'aborted'
  | 'no_start'
  | 'killed'
  | 'too_much_output'
  | 'bad_output'
  | 'wrong_length';

/** The fixed name of an exit code (never the number of an unknown one). */
export function nativeExitName(code: number): NativeHelperDetail {
  for (const [name, value] of Object.entries(NATIVE_HELPER_EXIT)) {
    if (value === code) return `exit_${name}` as NativeHelperDetail;
  }
  return 'exit_other';
}

/** A helper refusal: one fixed state, no output, no exit code text (I-7). */
export class NativeHelperError extends Error {
  readonly code = 'native_presence';
  constructor(
    readonly state: NativeUiState,
    /** DESK-NATIVE-DEBUG: how the run ended (fixed name), for the diagnostic line only. */
    readonly detail?: NativeHelperDetail,
    /** DESK-NATIVE-DEBUG: the helper's own fixed diagnostic (readHelperDiagnostic), if any. */
    readonly diag?: string,
  ) {
    super(`native presence: ${state}`);
    this.name = 'NativeHelperError';
  }
}

export interface NativeHelperRunResult {
  /** The exit code, or null when the helper did not start, was killed or timed out. */
  readonly code: number | null;
  readonly stdout: Uint8Array;
  /** DESK-NATIVE-DEBUG: why `code` is null (fixed name); absent when the helper exited. */
  readonly ended?: 'timeout' | 'aborted' | 'no_start' | 'killed' | 'too_much_output';
  /** DESK-NATIVE-DEBUG: the helper's diagnostic line, already checked by readHelperDiagnostic. */
  readonly diag?: string;
  /** DESK-TOUCHID-FIX: the helper noted that macOS secure input was on before its sheet. */
  readonly secureInput?: true;
}

/** The fixed shape of the macOS helper's one stderr line (agentlink-presence.swift header). */
const HELPER_DIAG =
  /^(args|input|create|verify|gate|sensor|sheet|output|signal) (none|la|os|ck) (-?[0-9]{1,7})\n?$/;
const MAX_STDERR = 128;
/** DESK-TOUCHID-FIX: the helper's one fixed note, before its diagnostic line. */
const SECURE_INPUT_NOTE = 'note secureinput 1\n';
/** DESK-TOUCHID-FIX: the one fixed core line for that note. */
export const SECURE_INPUT_LINE = 'native presence: secure input was on when the helper started';

/**
 * DESK-NATIVE-DEBUG: the helper's stderr as `<stage> <domain> <code>` when it is exactly that fixed
 * shape (fixed words and one integer, nothing from the system), else undefined. Nothing else of
 * stderr is ever kept.
 */
export function readHelperDiagnostic(stderr: Uint8Array): string | undefined {
  return readHelperStderr(stderr).diag;
}

/**
 * DESK-TOUCHID-FIX: the helper's stderr as an optional fixed secure-input note followed by an
 * optional fixed diagnostic line. Anything else (other text, a malformed line) drops both.
 */
export function readHelperStderr(stderr: Uint8Array): {
  readonly diag?: string;
  readonly secureInput?: true;
} {
  if (stderr.length === 0 || stderr.length > MAX_STDERR) return {};
  for (const b of stderr) if (b < 0x0a || b > 0x7a) return {};
  let text = new TextDecoder().decode(stderr);
  const secureInput = text.startsWith(SECURE_INPUT_NOTE);
  if (secureInput) text = text.slice(SECURE_INPUT_NOTE.length);
  if (text === '') return secureInput ? { secureInput: true } : {};
  const m = HELPER_DIAG.exec(text);
  if (m === null) return {};
  const diag = `${m[1] ?? ''} ${m[2] ?? ''} ${m[3] ?? ''}`;
  return secureInput ? { diag, secureInput: true } : { diag };
}

/** The error of a run that did not exit 0: its UI state and how it ended. */
function refusal(result: NativeHelperRunResult): NativeHelperError {
  if (result.code === null) {
    const ended = result.ended ?? 'no_start';
    // The OS prompt waited the whole NATIVE_HELPER_TIMEOUT_MS with no answer: its own message.
    return new NativeHelperError(ended === 'timeout' ? 'timeout' : 'error', ended, result.diag);
  }
  return new NativeHelperError(
    nativeUiState(result.code),
    nativeExitName(result.code),
    result.diag,
  );
}

/** Runs the helper once with `args` and `stdin` (tests: a stand-in; production: spawnNativeHelper). */
export type NativeHelperRunner = (
  args: readonly string[],
  stdin: Uint8Array | undefined,
  signal?: AbortSignal,
) => Promise<NativeHelperRunResult>;

/** Core's view of this computer's presence helper. */
export interface NativeHelper {
  readonly kind: NativePresenceKind;
  /** Touch ID / Windows Hello is set up (exit 0). Never prompts. */
  available(): Promise<boolean>;
  /** `create`: the bytes printed (macOS: the record; Windows: record ‖ u16 ‖ signature, one prompt). */
  create(): Promise<Uint8Array>;
  /** macOS `check`: resolves only when the key exists and refuses without a gesture. Never prompts. */
  check(record: Uint8Array): Promise<void>;
  /**
   * `ecdh <reason>` / `sign <reason>`: one OS prompt, the released secret (the caller wipes it).
   * `signal` aborts it (the helper is killed and the prompt goes away): `cancelled`, no bytes.
   */
  release(record: Uint8Array, reason: NativeReason, signal?: AbortSignal): Promise<Uint8Array>;
  /** Windows `delete` (best effort, no prompt); nothing on macOS (the key lives in its record). */
  remove(record: Uint8Array): Promise<void>;
}

const MAX_STDOUT = 16 * 1024;

const hexValue = (b: number): number =>
  b >= 0x30 && b <= 0x39 ? b - 0x30 : b >= 0x61 && b <= 0x66 ? b - 0x61 + 10 : -1;

/**
 * The printed bytes of a successful run (lowercase hex and at most one newline, nothing else), or a
 * fixed error state. Parsed from the bytes without a string copy (Fable review L2); the run's stdout
 * buffer is wiped whatever happens.
 */
function printed(result: NativeHelperRunResult): Uint8Array {
  const raw = result.stdout;
  try {
    if (result.code !== 0) throw refusal(result);
    const n = raw.length > 0 && raw[raw.length - 1] === 0x0a ? raw.length - 1 : raw.length;
    if (n === 0 || n % 2 !== 0) throw new NativeHelperError('error', 'bad_output');
    const out = new Uint8Array(n / 2);
    for (let i = 0; i < out.length; i += 1) {
      const hi = hexValue(raw[2 * i] as number);
      const lo = hexValue(raw[2 * i + 1] as number);
      if (hi < 0 || lo < 0) {
        out.fill(0);
        throw new NativeHelperError('error', 'bad_output');
      }
      out[i] = (hi << 4) | lo;
    }
    return out;
  } finally {
    raw.fill(0);
  }
}

const stdinOf = (record: Uint8Array): Uint8Array =>
  new TextEncoder().encode(`${encodeHex(record)}\n`);

/** The helper behind fixed commands; `kind` picks the macOS (ecdh) or Windows (sign) contract. */
export function createNativeHelper(options: {
  readonly kind: NativePresenceKind;
  readonly run: NativeHelperRunner;
  /** DESK-TOUCHID-FIX: receives SECURE_INPUT_LINE once per run whose helper noted secure input. */
  readonly diagnose?: (line: string) => void;
}): NativeHelper {
  const { kind, run: runOnce, diagnose } = options;
  const run: NativeHelperRunner = async (args, stdin, signal) => {
    const result = await runOnce(args, stdin, signal);
    if (result.secureInput === true) {
      try {
        diagnose?.(SECURE_INPUT_LINE);
      } catch {
        // Diagnostics never change the outcome.
      }
    }
    return result;
  };
  if (kind !== NATIVE_PRESENCE_MACOS && kind !== NATIVE_PRESENCE_WINDOWS) {
    throw new TypeError('native helper: unknown kind');
  }
  const mac = kind === NATIVE_PRESENCE_MACOS;
  return Object.freeze<NativeHelper>({
    kind,
    async available() {
      const result = await run(['available'], undefined);
      return result.code === 0;
    },
    async create() {
      return printed(await run(['create'], undefined));
    },
    async check(record) {
      const result = await run(['check'], stdinOf(record));
      if (result.code !== 0) throw refusal(result);
    },
    async release(record, reason, signal) {
      if (!(NATIVE_REASONS as readonly string[]).includes(reason)) {
        throw new NativeHelperError('error');
      }
      if (signal?.aborted === true) throw new NativeHelperError('cancelled');
      const result = await run([mac ? 'ecdh' : 'sign', reason], stdinOf(record), signal);
      if (isAborted(signal)) {
        // Fable review L1: abandoned; whatever the helper printed is dropped.
        result.stdout.fill(0);
        throw new NativeHelperError('cancelled', 'aborted');
      }
      const out = printed(result);
      const fits = mac ? out.length === 32 : [256, 384, 512].includes(out.length);
      if (!fits) {
        out.fill(0);
        throw new NativeHelperError('error', 'wrong_length');
      }
      return out;
    },
    async remove(record) {
      if (mac) return;
      await run(['delete'], stdinOf(record)).catch(() => undefined);
    },
  });
}

/** The longest a helper call may take: the OS prompt waits for the owner (then it is cancelled). */
export const NATIVE_HELPER_TIMEOUT_MS = 120_000;
/**
 * DESK-TOUCHID-FIX: how long a stopped helper gets after SIGTERM to close its sheet and exit (it
 * needs about a second) before it is killed outright.
 */
export const NATIVE_HELPER_KILL_GRACE_MS = 3_000;

/**
 * Spawns the helper at `path` (no shell, empty environment, stdin/stdout/stderr pipes, stderr only
 * read for its fixed diagnostic line,
 * stdout capped, killed after `timeoutMs`). A helper that cannot start, is killed or prints too much
 * resolves with code null (the `error` state). Never rejects.
 */
export function spawnNativeHelper(
  path: string,
  options: { readonly timeoutMs?: number; readonly killGraceMs?: number } = {},
): NativeHelperRunner {
  const timeoutMs = options.timeoutMs ?? NATIVE_HELPER_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? NATIVE_HELPER_KILL_GRACE_MS;
  return (args, stdin, signal) =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let errSize = 0;
      let size = 0;
      let settled = false;
      /** DESK-TOUCHID-FIX: why we stopped it; the run settles when it has exited. */
      let stopped: 'timeout' | 'aborted' | 'too_much_output' | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const finish = (
        code: number | null,
        ended?: 'timeout' | 'aborted' | 'no_start' | 'killed' | 'too_much_output',
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        signal?.removeEventListener('abort', onAbort);
        // One copy out, then every chunk and the concatenation are wiped (Fable review L2).
        let stdout = new Uint8Array(0);
        if (code !== null) {
          const joined = Buffer.concat(chunks);
          stdout = new Uint8Array(joined);
          joined.fill(0);
        }
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0;
        const notes = errSize <= MAX_STDERR ? readHelperStderr(Buffer.concat(errChunks)) : {};
        errChunks.length = 0;
        const base =
          code === null ? { code, stdout, ended: ended ?? 'no_start' } : { code, stdout };
        resolve({ ...base, ...notes });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(path, [...args], {
          shell: false,
          env: {},
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        resolve({ code: null, stdout: new Uint8Array(0), ended: 'no_start' });
        return;
      }
      // DESK-TOUCHID-FIX: SIGTERM (the helper invalidates its Touch ID context, so the sheet goes
      // away), then wait for it to exit; SIGKILL only if it has not exited after the grace period.
      // Its output after the stop is never used: the run settles with no exit code.
      function stop(why: 'timeout' | 'aborted' | 'too_much_output'): void {
        if (settled || stopped !== undefined) return;
        stopped = why;
        clearTimeout(timer);
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone: 'close' settles.
        }
        grace = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
          // A helper that cannot even be killed is not waited for any longer.
          grace = setTimeout(() => finish(null, why), killGraceMs);
        }, killGraceMs);
      }
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      // Fable review L1: the page went away (client disconnected, prompt abandoned): stop the helper,
      // so its OS prompt closes and no late touch is waited for.
      function onAbort(): void {
        stop('aborted');
      }
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', () => finish(null, 'no_start'));
      // DESK-NATIVE-DEBUG: at most MAX_STDERR bytes are kept, and only a fixed-shape line is used.
      child.stderr?.on('data', (chunk: Buffer) => {
        errSize += chunk.length;
        if (errSize <= MAX_STDERR) errChunks.push(chunk);
      });
      child.stderr?.on('error', () => undefined);
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_STDOUT) {
          chunk.fill(0);
          stop('too_much_output');
          return;
        }
        if (stopped !== undefined) {
          chunk.fill(0);
          return;
        }
        chunks.push(chunk);
      });
      // Stopped by us: no exit code, whatever it exited with. Ended by a signal from outside: no
      // exit code either.
      child.on('close', (code) => {
        if (stopped !== undefined) finish(null, stopped);
        else finish(typeof code === 'number' ? code : null, 'killed');
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(stdin === undefined ? undefined : Buffer.from(stdin));
    });
}

const HELPER_NAME = 'agentlink-presence';

/**
 * The helper's place in the desktop app (apps/desktop/build/build-mac.mjs, build-win.mjs), derived
 * from the bundled Node's own path: macOS `<App>.app/Contents/Resources/node/bin/node` →
 * `<App>.app/Contents/Helpers/agentlink-presence`; Windows `<dir>\resources\node\node.exe` →
 * `<dir>\resources\native\agentlink-presence.exe`. Any other layout (npx, Linux) has none.
 */
export function desktopHelperPath(execPath: string, platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') {
    const bin = posix.dirname(execPath);
    const node = posix.dirname(bin);
    const resources = posix.dirname(node);
    const contents = posix.dirname(resources);
    if (
      posix.basename(execPath) !== 'node' ||
      posix.basename(bin) !== 'bin' ||
      posix.basename(node) !== 'node' ||
      posix.basename(resources) !== 'Resources' ||
      posix.basename(contents) !== 'Contents' ||
      !posix.dirname(contents).endsWith('.app')
    ) {
      return undefined;
    }
    return posix.join(contents, 'Helpers', HELPER_NAME);
  }
  if (platform === 'win32') {
    const node = win32.dirname(execPath);
    const resources = win32.dirname(node);
    if (
      win32.basename(execPath).toLowerCase() !== 'node.exe' ||
      win32.basename(node).toLowerCase() !== 'node' ||
      win32.basename(resources).toLowerCase() !== 'resources'
    ) {
      return undefined;
    }
    return win32.join(resources, 'native', `${HELPER_NAME}.exe`);
  }
  return undefined;
}

/**
 * This computer's helper when core runs as the desktop app's bundled Node and the helper is in place;
 * otherwise undefined (npx, the browser-only CLI, Linux: native presence is not offered).
 */
export function desktopNativeHelper(
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  /** DESK-TOUCHID-FIX: the core's one-line diagnostic sink (the secure-input note). */
  diagnose?: (line: string) => void,
): NativeHelper | undefined {
  const path = desktopHelperPath(execPath, platform);
  if (path === undefined || !exists(path)) return undefined;
  const kind = platform === 'darwin' ? NATIVE_PRESENCE_MACOS : NATIVE_PRESENCE_WINDOWS;
  return createNativeHelper({
    kind,
    run: spawnNativeHelper(path),
    ...(diagnose === undefined ? {} : { diagnose }),
  });
}

/** True once `signal` was aborted (read fresh after an await). */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
