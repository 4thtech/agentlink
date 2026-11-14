// The core supervisor (plan Decision 2): starts the core desktop host on the bundled Node with a
// CLEAN environment and a fixed argv, talks to it over fd 3 only (pipe.ts), restarts it with backoff
// when it dies, and stops it on quit (shutdown message, then a kill after a grace period).
//
// - argv: exactly [<bundled node>, <host script>]. No Node options, ever.
// - stdio: [ignore, ignore, pipe, overlapped]. stdout is ignored; the session link travels only on
//   fd 3. fd 3 is 'overlapped' (WIN-DESK-1): the same as 'pipe' outside Windows; on Windows the
//   core's end is an asynchronous handle, so its pending read never blocks its write of `ready`.
//   stderr is read and handed to `onStderr` (core-log.ts redacts it and keeps the last lines in
//   memory and in a 0600 log file), so a core that dies before `ready` leaves a trace.
// - env: built from an allowlist (home, temp, locale, PATH and the OS basics). NODE_OPTIONS, NODE_*,
//   ELECTRON_*, AGENTLINK_* secrets (passphrases, master codes) and everything else are dropped.
// - A protocol violation closes the pipe and stops that core; the supervisor starts a new one with
//   backoff. After MAX_FAST_FAILURES quick deaths in a row it gives up (state "failed").
// - A core that says `stopped` with a start-failure reason (no owner, keychain, port, …) is not
//   restarted: a restart cannot fix it. The state goes to "failed" with that reason
//   (`failureReason`), and the shell shows a fixed message for it (D2 open question 4).
// - `failureKind` says why the state is "failed": that start-failure reason; `port` when the last
//   core said its port was taken; `exited` when no core of the series reached `ready` (including a
//   core that could not be spawned); `retries` when a core had been ready but kept stopping.
import {
  isStartFailure,
  type CoreMessage,
  type ShellMessage,
  type StartFailureReason,
  type StopReason,
} from '../shared/protocol.js';
import { PipeClient, type PipeStream, type PipeViolation } from './pipe.js';

/** The AI app markers (same list as apps/cli/src/runtime/guards.ts HARNESS_MARKERS). */
export const AI_APP_MARKERS: readonly string[] = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'GEMINI_CLI',
]);

/** Environment variables passed to the core (exact names; case-insensitive match on Windows). */
export const CORE_ENV_ALLOWLIST: readonly string[] = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  // Windows basics (the keychain, the per-user folders, process creation).
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  // Linux desktop session (Secret Service keychain, the opener); WP-D17.
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  // AI app markers (apps/cli/src/runtime/guards.ts HARNESS_MARKERS). Passed through so the core's
  // guard against an AI starting the owner pages (G-1) still sees an app launched from an AI app.
  ...AI_APP_MARKERS,
];

/**
 * True when an AI app marker is set to a non-empty value (names match case-insensitively on
 * Windows). The core refuses to start then (G-1); the shell uses this only to show a clear page.
 */
export function aiAppMarkerSet(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): boolean {
  const markers = new Set(AI_APP_MARKERS);
  return Object.entries(env).some(([name, value]) => {
    const key = platform === 'win32' ? name.toUpperCase() : name;
    return markers.has(key) && value !== undefined && value !== '';
  });
}

/** Backoff between restarts: 1 s, 2 s, 4 s … capped at 30 s. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** A run at least this long resets the backoff. */
export const STABLE_RUN_MS = 60_000;
/** This many quick deaths in a row → give up. */
export const MAX_FAST_FAILURES = 5;
/** After `shutdown`, the core gets this long to exit before it is killed. */
export const SHUTDOWN_GRACE_MS = 5_000;
/** After the first kill, this long before SIGKILL. */
export const KILL_GRACE_MS = 2_000;

/** The clean environment for the core: only allowlisted variables, values unchanged. */
export function cleanCoreEnv(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const allow = new Set(CORE_ENV_ALLOWLIST);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const key = platform === 'win32' ? name.toUpperCase() : name;
    if (allow.has(key)) out[name] = value;
  }
  return out;
}

/**
 * WIN-STARTUP-LOG: the one logging variable the core gets, always this fixed value (never the user's
 * own). The core's redacting logger (@4thtech-io/log) then writes its warnings, with fixed codes only,
 * to stderr, which core-log.ts redacts again and keeps in core.log.
 */
export const CORE_LOG_LEVEL = 'warn';

/** The environment the core is spawned with: the clean one, plus the fixed log level. */
export function coreSpawnEnv(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): Record<string, string> {
  return { ...cleanCoreEnv(env, platform), AGENTLINK_LOG: CORE_LOG_LEVEL };
}

/** The child process as the supervisor uses it (node:child_process ChildProcess). */
export interface CoreChild {
  readonly stdio: readonly unknown[];
  readonly exitCode: number | null;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): boolean;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

export interface SpawnOptions {
  readonly env: Record<string, string>;
  readonly stdio: readonly ['ignore', 'ignore', 'pipe', 'overlapped'];
  readonly windowsHide: true;
  readonly shell: false;
  readonly detached: false;
  readonly cwd: string;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => CoreChild;

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export type SupervisorState = 'idle' | 'running' | 'waiting' | 'stopping' | 'stopped' | 'failed';

export interface CoreSupervisorOptions {
  /** Absolute path of the bundled node binary. */
  readonly nodePath: string;
  /** Absolute path of the core desktop host script. */
  readonly hostScript: string;
  /** The working directory (the user's home). */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly spawn: SpawnFn;
  readonly timers: Timers;
  readonly onMessage: (message: CoreMessage) => void;
  /** A new core process started (its origin may differ: reset the window's lock). */
  readonly onStart?: () => void;
  readonly onViolation?: (violation: PipeViolation) => void;
  readonly onStateChange?: (state: SupervisorState) => void;
  /** A chunk of the core's stderr (core-log.ts redacts it; it goes nowhere else). */
  readonly onStderr?: (chunk: Uint8Array) => void;
  /** A core process exited (also after a spawn error: code and signal null). */
  readonly onExit?: (code: number | null, signal: string | null) => void;
}

/** Why the supervisor is in "failed". */
export type CoreFailureKind = StartFailureReason | 'port' | 'retries' | 'exited';

interface ReadableLike {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

const isReadable = (value: unknown): value is ReadableLike =>
  typeof value === 'object' && value !== null && typeof (value as ReadableLike).on === 'function';

const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\\/.test(path);

const isPipeStream = (value: unknown): value is PipeStream =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PipeStream).on === 'function' &&
  typeof (value as PipeStream).write === 'function' &&
  typeof (value as PipeStream).destroy === 'function';

export class CoreSupervisor {
  readonly #options: CoreSupervisorOptions;
  #state: SupervisorState = 'idle';
  #child: CoreChild | null = null;
  #pipe: PipeClient | null = null;
  #startedAt = 0;
  #failures = 0;
  #restartTimer: unknown = null;
  #startFailure: StartFailureReason | null = null;
  /** The last `stopped` reason of the current core. */
  #lastStop: StopReason | null = null;
  /** True when a core of the current failure series sent a valid `ready`. */
  #seriesReady = false;
  /** True when the current core sent a valid `ready`. */
  #runReady = false;
  #stopWaiters: Array<() => void> = [];

  constructor(options: CoreSupervisorOptions) {
    if (!isAbsolute(options.nodePath) || !isAbsolute(options.hostScript)) {
      throw new Error('core: the node and host paths must be absolute');
    }
    this.#options = options;
  }

  get state(): SupervisorState {
    return this.#state;
  }

  /** Why the core could not start, when the state is "failed" for that reason; else null. */
  get failureReason(): StartFailureReason | null {
    return this.#state === 'failed' ? this.#startFailure : null;
  }

  /** Why the state is "failed" (see the header); null in any other state. */
  get failureKind(): CoreFailureKind | null {
    if (this.#state !== 'failed') return null;
    if (this.#startFailure !== null) return this.#startFailure;
    if (this.#lastStop === 'port') return 'port';
    return this.#seriesReady ? 'retries' : 'exited';
  }

  #setState(state: SupervisorState): void {
    this.#state = state;
    this.#options.onStateChange?.(state);
  }

  start(): void {
    if (this.#state !== 'idle' && this.#state !== 'waiting') return;
    this.#restartTimer = null;
    this.#startFailure = null;
    this.#lastStop = null;
    this.#runReady = false;
    const o = this.#options;
    this.#startedAt = o.timers.now();
    let child: CoreChild;
    try {
      child = o.spawn(o.nodePath, [o.hostScript], {
        env: coreSpawnEnv(o.env, o.platform),
        stdio: ['ignore', 'ignore', 'pipe', 'overlapped'],
        windowsHide: true,
        shell: false,
        detached: false,
        cwd: o.cwd,
      });
    } catch {
      o.onExit?.(null, null);
      this.#onExit();
      return;
    }
    this.#child = child;
    this.#setState('running');
    let exited = false;
    const exitOnce = (code: number | null, signal: string | null): void => {
      if (exited) return;
      exited = true;
      o.onExit?.(code, signal);
      this.#onExit(child);
    };
    child.on('error', () => exitOnce(null, null));
    child.on('exit', (code, signal) => exitOnce(code, signal));
    const stderr = child.stdio[2];
    if (isReadable(stderr)) {
      stderr.on('data', (chunk) => {
        if (o.onStderr === undefined) return;
        o.onStderr(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      });
      stderr.on('error', () => undefined);
    }
    const stream = child.stdio[3];
    if (!isPipeStream(stream)) {
      child.kill('SIGKILL');
      return;
    }
    let killed = false;
    const killOnce = (): void => {
      if (killed) return;
      killed = true;
      child.kill('SIGKILL');
    };
    this.#pipe = new PipeClient(stream, {
      onMessage: (message) => {
        if (this.#child !== child || this.#state !== 'running') return;
        if (message.type === 'stopped') {
          this.#lastStop = message.reason;
          if (isStartFailure(message.reason)) this.#startFailure = message.reason;
        }
        if (message.type === 'ready') {
          this.#runReady = true;
          this.#seriesReady = true;
        }
        o.onMessage(message);
      },
      onViolation: (violation) => {
        o.onViolation?.(violation);
        // A core that breaks the protocol is stopped; the exit handler restarts it.
        killOnce();
      },
      onClose: () => {
        // A core without its pipe can never reach the window: stop it (the exit handler decides on
        // a restart). While stopping, the shutdown grace timers handle it.
        if (this.#child === child && this.#state !== 'stopping') killOnce();
      },
    });
    o.onStart?.();
  }

  /** Sends a message to the running core; false when there is none. */
  send(message: ShellMessage): boolean {
    if (this.#state !== 'running' || this.#pipe === null) return false;
    return this.#pipe.send(message);
  }

  #onExit(child?: CoreChild): void {
    if (child !== undefined && child !== this.#child) return;
    this.#pipe?.close();
    this.#pipe = null;
    this.#child = null;
    if (this.#state === 'stopping' || this.#state === 'stopped') {
      this.#finishStop();
      return;
    }
    const o = this.#options;
    if (this.#startFailure !== null) {
      this.#setState('failed');
      return;
    }
    const ranFor = o.timers.now() - this.#startedAt;
    if (ranFor >= STABLE_RUN_MS) {
      // A new series: only what happens from here on counts for failureKind.
      this.#failures = 1;
      this.#seriesReady = this.#runReady;
    } else {
      this.#failures += 1;
    }
    if (this.#failures >= MAX_FAST_FAILURES) {
      this.#setState('failed');
      return;
    }
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.#failures - 1));
    this.#setState('waiting');
    this.#restartTimer = o.timers.setTimeout(() => this.start(), delay);
  }

  /** Starts again after "failed" (the person asked to retry). */
  retry(): void {
    if (this.#state !== 'failed') return;
    this.#failures = 0;
    this.#seriesReady = false;
    this.#setState('idle');
    this.start();
  }

  /**
   * Stops the core: `shutdown` on the pipe, SIGTERM after SHUTDOWN_GRACE_MS, SIGKILL after
   * KILL_GRACE_MS more. Resolves when the process has exited (or there was none).
   */
  stop(): Promise<void> {
    const o = this.#options;
    if (this.#restartTimer !== null) {
      o.timers.clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#child;
    if (child === null) {
      this.#setState('stopped');
      return Promise.resolve();
    }
    const done = new Promise<void>((resolve) => this.#stopWaiters.push(resolve));
    if (this.#state === 'stopping') return done;
    this.#pipe?.send({ v: 1, type: 'shutdown' });
    this.#setState('stopping');
    o.timers.setTimeout(() => {
      if (this.#child !== child) return;
      child.kill('SIGTERM');
      o.timers.setTimeout(() => {
        if (this.#child === child) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, SHUTDOWN_GRACE_MS);
    return done;
  }

  #finishStop(): void {
    this.#setState('stopped');
    const waiters = this.#stopWaiters;
    this.#stopWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
