// REL051-UPD2: "Check for updates" for the browser app (the local app server that `agentlink`, the
// installers' launcher or npx start). Settings > Updates is one page for the desktop app and the
// browser app; the desktop app keeps its GitHub release check (apps/desktop updater/release-check.ts),
// this is the browser app's side. It only READS which version is the latest published one; it runs
// nothing and installs nothing (running npm from the app server is a later, separately audited step).
//
// - One fixed source: the npm registry's dist-tags of this package (NPM_DIST_TAGS_URL, a few bytes:
//   `{"latest":"x.y.z"}`). Fixed URL, nothing from the person, a page or the network goes into it;
//   https only; redirects refused; no credentials or cookies; no header beyond `accept` (no version,
//   ID or name is sent); a 15 s timeout; the body read with a byte cap and strictly checked
//   (parseDistTags: plain x.y.z only). Nothing of the answer is logged; only the checked version
//   is kept. It runs in this server process only, never in a page.
// - When: a quiet check LAUNCH_CHECK_DELAY_MS after the app server starts and then once a day while
//   it runs (in memory only: nothing is written to disk), each only when the last good check is a
//   day old or more. A quiet check that fails says nothing. "Check for updates" asks at once, but at
//   most one request a minute (MANUAL_MIN_GAP_MS; within it the last result), and one at a time.
// - Never: in a development build (a version that is not plain x.y.z) or when this computer's policy
//   turns it off (AGENTLINK_UPDATE_CHECK=off, the same switch as the desktop app).
// - The action the page shows depends on how this copy was installed (browserInstall): the
//   installers' launcher runs `npx … @4thtech-io/agentlink@latest` at every start, and npx looks up
//   the newest version at every start too, so for both a restart IS the update; a global npm install
//   is pinned, so the page shows the one update command.
import { parseJson } from '@4thtech-io/crypto';
import type {
  AppUpdateInstall,
  AppUpdateState,
  AppUpdateView,
  LocalUiAppUpdateDesk,
} from '@4thtech-io/node';
import { LAUNCHER_MARKER, isGlobalLaunch } from './cli-prefix.js';

/** The `latest` dist-tag of @4thtech-io/agentlink (the scoped name's slash escaped, as npm does). */
export const NPM_DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/@4thtech-io%2fagentlink/dist-tags';
/** The answer is a few dozen bytes; anything larger is not one. */
export const MAX_DIST_TAGS_BYTES = 8 * 1024;
export const CHECK_TIMEOUT_MS = 15_000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const LAUNCH_CHECK_DELAY_MS = 30_000;
/** At most one request per this window; a click within it gets the last result (as UPD-N1). */
export const MANUAL_MIN_GAP_MS = 60_000;
/** The policy switch (exact value `off`), shared with the desktop app. */
export const UPDATE_CHECK_ENV = 'AGENTLINK_UPDATE_CHECK';

export type BrowserInstall = Exclude<AppUpdateInstall, 'desktop'>;

/** The part of `fetch` used here (injected in tests). */
export type RegistryFetch = (
  url: string,
  init: {
    readonly method: 'GET';
    readonly redirect: 'error';
    readonly credentials: 'omit';
    readonly signal: AbortSignal;
    readonly headers: Readonly<Record<string, string>>;
  },
) => Promise<Response>;

const NUM = '(0|[1-9][0-9]{0,5})';
const RELEASE_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const APP_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-[0-9A-Za-z][0-9A-Za-z.]{0,31})?$`);

const isRelease = (v: unknown): v is string => typeof v === 'string' && RELEASE_VERSION.test(v);

/** True only when both are plain release versions and `latest` is strictly greater. */
function isNewer(latest: string, current: string): boolean {
  const a = RELEASE_VERSION.exec(latest);
  const b = RELEASE_VERSION.exec(current);
  if (a === null || b === null) return false;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  }
  return false;
}

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `latest` version from the registry's bytes, or undefined for anything else. */
export function parseDistTags(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0 || bytes.length > MAX_DIST_TAGS_BYTES) return undefined;
  let value: unknown;
  try {
    // Fatal UTF-8; parseJson refuses duplicate keys and anything that is not JSON.
    value = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const latest = value['latest'];
  return isRelease(latest) ? latest : undefined;
}

/** Reads the body up to `max` bytes; undefined once it is longer (the rest is not read). */
async function readCapped(response: Response, max: number): Promise<Uint8Array | undefined> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) return undefined;
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export type FetchOutcome =
  | { readonly kind: 'ok'; readonly version: string }
  | { readonly kind: 'offline' }
  | { readonly kind: 'failed' };

/** No network at all (no name lookup, no route): said as "offline", not as a failure. */
const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN']);

function offlineError(error: unknown): boolean {
  const cause =
    isObject(error) || error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const code = isObject(cause) ? cause['code'] : undefined;
  return typeof code === 'string' && OFFLINE_CODES.has(code);
}

/** One request to the fixed URL. Never throws; nothing of a failure is kept or logged. */
export async function fetchLatestVersion(
  fetchImpl: RegistryFetch,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<FetchOutcome> {
  try {
    const response = await fetchImpl(NPM_DIST_TAGS_URL, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'failed' };
    }
    const bytes = await readCapped(response, MAX_DIST_TAGS_BYTES);
    const version = bytes === undefined ? undefined : parseDistTags(bytes);
    return version === undefined ? { kind: 'failed' } : { kind: 'ok', version };
  } catch (error) {
    return offlineError(error) ? { kind: 'offline' } : { kind: 'failed' };
  }
}

/**
 * How this copy was started, for the action the page shows:
 * - `installer`: the installers' launcher (it runs npx with `@latest` at every start);
 * - `global`: the bare `agentlink` on PATH is this very program (a pinned `npm i -g`);
 * - `npx`: npx, `npm exec`, dlx, or anything else (the npx form with `@latest` is right for all).
 */
export function browserInstall(
  env: Readonly<Record<string, string | undefined>>,
  script: string | undefined,
  onPath?: (script: string) => boolean,
): BrowserInstall {
  if (env[LAUNCHER_MARKER] === 'installer') return 'installer';
  if (script === undefined || script === '') return 'npx';
  if (env['npm_command'] === 'exec' || /[\\/](_npx|dlx)[\\/]/.test(script)) return 'npx';
  return (onPath ?? isGlobalLaunch)(script) ? 'global' : 'npx';
}

/** True when this build may check at all: a plain release version, not turned off by policy. */
export function updateChecksAllowed(
  env: Readonly<Record<string, string | undefined>>,
  version: string,
): boolean {
  return isRelease(version) && env[UPDATE_CHECK_ENV] !== 'off';
}

export interface NpmUpdateCheckerDeps {
  readonly currentVersion: string;
  /** updateChecksAllowed(…). False: never a request, the state stays `off`. */
  readonly enabled: boolean;
  readonly fetch?: RegistryFetch;
  readonly now?: () => number;
  /** Default: Node timers, unref'd (a pending check never keeps the process running). */
  readonly timers?: { setTimeout(callback: () => void, ms: number): unknown };
}

const defaultFetch: RegistryFetch = (url, init) =>
  fetch(url, { ...init, headers: { ...init.headers } });

const nodeTimers = {
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms).unref(),
};

export class NpmUpdateChecker {
  readonly #deps: NpmUpdateCheckerDeps;
  readonly #active: boolean;
  #view: AppUpdateView;
  #running: Promise<AppUpdateView> | undefined;
  #lastFetchAt: number | undefined;
  #lastGoodAt: number | undefined;
  #started = false;

  constructor(deps: NpmUpdateCheckerDeps) {
    this.#deps = deps;
    const current =
      typeof deps.currentVersion === 'string' && APP_VERSION.test(deps.currentVersion)
        ? deps.currentVersion
        : '0.0.0';
    // A development build (not a plain x.y.z) is never offered anything, so it never asks.
    this.#active = deps.enabled && isRelease(current);
    this.#view = Object.freeze({
      state: this.#active ? 'idle' : 'off',
      current,
      latest: '',
      download: '',
    });
  }

  view(): AppUpdateView {
    return this.#view;
  }

  /** The quiet checks: one shortly after the server starts, then once a day. Once per checker. */
  start(): void {
    if (!this.#active || this.#started) return;
    this.#started = true;
    this.#timers().setTimeout(() => this.#tick(), LAUNCH_CHECK_DELAY_MS);
  }

  /** "Check for updates" (see the header for the limits). */
  check(): Promise<AppUpdateView> {
    return this.#run(false);
  }

  #tick(): void {
    void this.#quiet().finally(() => {
      this.#timers().setTimeout(() => this.#tick(), DAY_MS);
    });
  }

  async #quiet(): Promise<void> {
    const last = this.#lastGoodAt;
    const now = this.#now();
    if (last !== undefined && now >= last && now - last < DAY_MS) return;
    await this.#run(true).catch(() => undefined);
  }

  #run(quiet: boolean): Promise<AppUpdateView> {
    if (!this.#active) return Promise.resolve(this.#view);
    if (this.#running !== undefined) return this.#running;
    const started = this.#now();
    const last = this.#lastFetchAt;
    if (!quiet && last !== undefined && started >= last && started - last < MANUAL_MIN_GAP_MS) {
      return Promise.resolve(this.#view);
    }
    const before = this.#view;
    if (!quiet) this.#set('checking');
    this.#lastFetchAt = started;
    const running = (async (): Promise<AppUpdateView> => {
      const found = await fetchLatestVersion(this.#deps.fetch ?? defaultFetch);
      if (found.kind !== 'ok') {
        // A quiet check that fails says nothing (the view stays as it was).
        if (quiet) this.#view = before;
        else this.#set(found.kind);
        return this.#view;
      }
      this.#lastGoodAt = this.#now();
      if (isNewer(found.version, this.#view.current)) {
        this.#view = Object.freeze({
          state: 'available',
          current: this.#view.current,
          latest: found.version,
          download: '',
        });
      } else {
        this.#set('current');
      }
      return this.#view;
    })();
    this.#running = running;
    void running.finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    return running;
  }

  #set(state: Exclude<AppUpdateState, 'available'>): void {
    this.#view = Object.freeze({ state, current: this.#view.current, latest: '', download: '' });
  }

  #timers(): { setTimeout(callback: () => void, ms: number): unknown } {
    return this.#deps.timers ?? nodeTimers;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }
}

/** The desk Settings > Updates reads (packages/node local-ui/api/app-update.ts). */
export function browserUpdateDesk(
  checker: NpmUpdateChecker,
  install: BrowserInstall,
): LocalUiAppUpdateDesk {
  return Object.freeze<LocalUiAppUpdateDesk>({
    install,
    view: () => checker.view(),
    check: () => {
      void checker.check().catch(() => undefined);
      return checker.view();
    },
  });
}

/**
 * Wraps a server starter so every server it starts (Welcome and an open ID alike) gets the same desk,
 * made once, when the first server starts (so a command that starts no server never checks).
 */
export function withUpdates<O extends { readonly appUpdate?: unknown }, R>(
  start: (options: O) => R,
  make: () => LocalUiAppUpdateDesk,
): (options: O) => R {
  let desk: LocalUiAppUpdateDesk | undefined;
  return (options) => {
    desk ??= make();
    return start({ ...options, appUpdate: options.appUpdate ?? desk });
  };
}

/**
 * The production desk: this process's version, environment and launch. Starts the quiet checks.
 * BROWSER-UPDATE: with `withUpdater` (only the terminal `agentlink ui` host passes it), the desk
 * also has Update now and Restart now (browser-update.ts); without it, the restart or the one
 * command as before.
 */
export function nodeBrowserUpdateDesk(
  version: string,
  withUpdater?: (install: BrowserInstall, checker: NpmUpdateChecker) => LocalUiAppUpdateDesk,
): LocalUiAppUpdateDesk {
  const env = process.env;
  const checker = new NpmUpdateChecker({
    currentVersion: version,
    enabled: updateChecksAllowed(env, version),
  });
  checker.start();
  const install = browserInstall(env, process.argv[1]);
  return withUpdater === undefined
    ? browserUpdateDesk(checker, install)
    : withUpdater(install, checker);
}
