// DESK051-UPD: "Check for updates" for 0.5.1, while the signed updater (index.ts, WP-D10) stays off
// until the owner's offline key ceremony. The app only READS which version is the latest published
// one and, when it is newer, offers the exact release file for this computer in the default browser
// (Settings > Updates, through the core; the window's link rules open it, security.ts). The app
// downloads, opens and installs nothing itself.
//
// - One fixed source: GitHub's "latest release" of this repository (RELEASE_API_URL). Fixed URL, no
//   input from the person, a page or the network goes into it; https only; redirects refused; no
//   credentials or cookies; a 15 s timeout; the body read with a byte cap (MAX_RELEASE_BYTES) and
//   strictly checked (parseLatestRelease). It runs in this main process only, never in a page.
// - Of the answer only two things are kept: the version from `tag_name` (exactly `v` + plain x.y.z,
//   not a draft, not a prerelease) and the asset NAMES, to know whether this Mac's file is attached
//   yet. The download link is built from the version (app-update.ts), never taken from the answer.
//   Nothing of the answer is logged or shown.
// - When: a quiet check LAUNCH_CHECK_DELAY_MS after launch and then once a day while the app runs,
//   each only when the last good check is a day old or more (update-check.json in the app's own
//   data folder: the time and the version found, nothing else). A quiet check that fails says
//   nothing. "Check for updates" always asks (one request at a time).
// - Never: while offline (`isOnline`), in a development or preview build, or when this computer's
//   policy turns it off (AGENTLINK_UPDATE_CHECK=off; updateChecksAllowed).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJson } from '@4thtech-io/crypto';
import {
  isAppVersion,
  isNewerVersion,
  macArch,
  macAssetName,
  macDownloadUrl,
  parseReleaseVersion,
  releasePageUrl,
  type AppUpdateState,
  type AppUpdateView,
} from '../../shared/app-update.js';

export const RELEASE_API_URL = 'https://api.github.com/repos/4thtech/agentlink/releases/latest';
/** A release answer is a few kB plus its notes; anything larger is not one. */
export const MAX_RELEASE_BYTES = 512 * 1024;
export const MAX_RELEASE_ASSETS = 200;
export const CHECK_TIMEOUT_MS = 15_000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const LAUNCH_CHECK_DELAY_MS = 30_000;
export const CHECK_STATE_FILE = 'update-check.json';
const MAX_STATE_BYTES = 1024;
/** The policy switch (exact value `off`). */
export const UPDATE_CHECK_ENV = 'AGENTLINK_UPDATE_CHECK';

/** The part of `fetch` used here (injected in tests). */
export type ReleaseFetch = (
  url: string,
  init: {
    readonly method: 'GET';
    readonly redirect: 'error';
    readonly credentials: 'omit';
    readonly signal: AbortSignal;
    readonly headers: Readonly<Record<string, string>>;
  },
) => Promise<Response>;

export interface LatestRelease {
  readonly version: string;
  readonly assets: ReadonlySet<string>;
}

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The latest release from the API's bytes, or undefined for anything that is not exactly one. */
export function parseLatestRelease(bytes: Uint8Array): LatestRelease | undefined {
  if (bytes.length === 0 || bytes.length > MAX_RELEASE_BYTES) return undefined;
  let value: unknown;
  try {
    // Fatal UTF-8; parseJson refuses duplicate keys and anything that is not JSON.
    value = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const tag = value['tag_name'];
  if (typeof tag !== 'string' || !tag.startsWith('v')) return undefined;
  const version = tag.slice(1);
  if (parseReleaseVersion(version) === undefined) return undefined;
  if (value['draft'] !== false || value['prerelease'] !== false) return undefined;
  const list = value['assets'];
  if (!Array.isArray(list) || list.length > MAX_RELEASE_ASSETS) return undefined;
  const assets = new Set<string>();
  for (const asset of list as unknown[]) {
    if (!isObject(asset)) return undefined;
    const name = asset['name'];
    if (typeof name !== 'string' || name.length === 0 || name.length > 255) return undefined;
    assets.add(name);
  }
  return Object.freeze({ version, assets });
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

/** One request to the fixed URL. Undefined on any failure (the caller decides what to say). */
export async function fetchLatestRelease(
  fetchImpl: ReleaseFetch,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<LatestRelease | undefined> {
  try {
    const response = await fetchImpl(RELEASE_API_URL, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'AgentLink-Desktop',
      },
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const bytes = await readCapped(response, MAX_RELEASE_BYTES);
    return bytes === undefined ? undefined : parseLatestRelease(bytes);
  } catch {
    return undefined;
  }
}

/** True when this build may check at all: a packaged release build, not turned off by policy. */
export function updateChecksAllowed(input: {
  readonly packaged: boolean;
  readonly preview: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): boolean {
  if (!input.packaged || input.preview) return false;
  return input.env[UPDATE_CHECK_ENV] !== 'off';
}

interface Throttle {
  readonly checkedAt: number;
  /** The newer version found (with this computer's file attached), or ''. */
  readonly latest: string;
}

async function loadThrottle(dir: string, now: number): Promise<Throttle | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, CHECK_STATE_FILE));
  } catch {
    return undefined;
  }
  if (bytes.length > MAX_STATE_BYTES) return undefined;
  try {
    const value = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isObject(value)) return undefined;
    const keys = Object.keys(value).sort();
    if (keys.length !== 2 || keys[0] !== 'checkedAt' || keys[1] !== 'latest') return undefined;
    const { checkedAt, latest } = value;
    if (typeof checkedAt !== 'number' || !Number.isSafeInteger(checkedAt)) return undefined;
    // A time in the future (a clock set back, or an edited file) counts as never checked.
    if (checkedAt < 0 || checkedAt > now) return undefined;
    if (latest !== '' && parseReleaseVersion(latest) === undefined) return undefined;
    return { checkedAt, latest: latest as string };
  } catch {
    return undefined;
  }
}

/** Atomic write (temp file + rename), 0600 in a 0700 folder. Failures are ignored. */
async function saveThrottle(dir: string, throttle: Throttle): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `${CHECK_STATE_FILE}.tmp`);
    await writeFile(tmp, JSON.stringify(throttle) + '\n', { mode: 0o600 });
    await rename(tmp, join(dir, CHECK_STATE_FILE));
  } catch {
    // Only the throttle is lost: the next launch checks again.
  }
}

export interface ReleaseCheckerDeps {
  readonly currentVersion: string;
  /** process.platform and process.arch; `translated`: Electron app.runningUnderARM64Translation. */
  readonly platform: string;
  readonly arch: string;
  readonly translated?: boolean;
  /** updateChecksAllowed(…). False: never a request, the state stays `off`. */
  readonly enabled: boolean;
  /** The app's own data folder (Electron app.getPath('userData')). */
  readonly stateDir: string;
  /** Electron net.isOnline(). */
  readonly isOnline: () => boolean;
  readonly fetch?: ReleaseFetch;
  readonly now?: () => number;
  readonly timers: { setTimeout(callback: () => void, ms: number): unknown };
  /** Called with every new view (the shell sends it to the core). Exceptions are ignored. */
  readonly onChange?: (view: AppUpdateView) => void;
}

const defaultFetch: ReleaseFetch = (url, init) =>
  fetch(url, { ...init, headers: { ...init.headers } });

export class ReleaseChecker {
  readonly #deps: ReleaseCheckerDeps;
  readonly #active: boolean;
  #view: AppUpdateView;
  #running: Promise<AppUpdateView> | undefined;

  constructor(deps: ReleaseCheckerDeps) {
    this.#deps = deps;
    const current = isAppVersion(deps.currentVersion) ? deps.currentVersion : '0.0.0';
    // A development build (not a plain x.y.z) is never offered anything, so it never asks.
    this.#active = deps.enabled && parseReleaseVersion(current) !== undefined;
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

  /** Launch: show what the last check found (if it is fresh), then the quiet checks. */
  async start(): Promise<void> {
    if (!this.#active) return;
    const now = this.#now();
    const last = await loadThrottle(this.#deps.stateDir, now);
    if (last !== undefined && now - last.checkedAt < DAY_MS) {
      this.#setFound(last.latest);
    }
    this.#deps.timers.setTimeout(() => this.#tick(), LAUNCH_CHECK_DELAY_MS);
  }

  /** "Check for updates": always asks (unless off or offline); concurrent calls share one request. */
  check(): Promise<AppUpdateView> {
    return this.#run(false);
  }

  #tick(): void {
    void this.#quiet().finally(() => {
      this.#deps.timers.setTimeout(() => this.#tick(), DAY_MS);
    });
  }

  async #quiet(): Promise<void> {
    const now = this.#now();
    const last = await loadThrottle(this.#deps.stateDir, now);
    if (last !== undefined && now - last.checkedAt < DAY_MS) return;
    await this.#run(true).catch(() => undefined);
  }

  #run(quiet: boolean): Promise<AppUpdateView> {
    if (!this.#active) return Promise.resolve(this.#view);
    if (this.#running !== undefined) return this.#running;
    if (!this.#deps.isOnline()) {
      if (!quiet) this.#set('offline');
      return Promise.resolve(this.#view);
    }
    const before = this.#view;
    if (!quiet) this.#set('checking');
    const running = (async (): Promise<AppUpdateView> => {
      const found = await fetchLatestRelease(this.#deps.fetch ?? defaultFetch);
      if (found === undefined) {
        // A quiet check that fails says nothing (the view stays as it was).
        if (quiet) this.#publish(before);
        else this.#set('failed');
        return this.#view;
      }
      const latest = this.#offerable(found) ? found.version : '';
      await saveThrottle(this.#deps.stateDir, { checkedAt: this.#now(), latest });
      this.#setFound(latest);
      return this.#view;
    })();
    this.#running = running;
    void running.finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    return running;
  }

  /** Newer than this app, and (on a Mac) this Mac's file is attached to the release. */
  #offerable(found: LatestRelease): boolean {
    if (!isNewerVersion(found.version, this.#view.current)) return false;
    if (this.#deps.platform !== 'darwin') return true;
    const arch = macArch(this.#deps.arch, this.#deps.translated === true);
    return arch !== undefined && found.assets.has(macAssetName(found.version, arch));
  }

  #setFound(latest: string): void {
    const download = latest === '' ? undefined : this.#downloadFor(latest);
    if (download === undefined || !isNewerVersion(latest, this.#view.current)) {
      this.#set('current');
      return;
    }
    this.#publish({ state: 'available', current: this.#view.current, latest, download });
  }

  #downloadFor(version: string): string | undefined {
    if (this.#deps.platform !== 'darwin') return releasePageUrl(version);
    const arch = macArch(this.#deps.arch, this.#deps.translated === true);
    return arch === undefined ? undefined : macDownloadUrl(version, arch);
  }

  #set(state: Exclude<AppUpdateState, 'available'>): void {
    this.#publish({ state, current: this.#view.current, latest: '', download: '' });
  }

  #publish(view: AppUpdateView): void {
    const next = Object.freeze({ ...view });
    const same =
      next.state === this.#view.state &&
      next.latest === this.#view.latest &&
      next.download === this.#view.download;
    this.#view = next;
    if (same) return;
    try {
      this.#deps.onChange?.(next);
    } catch {
      // The listener's problem; the view is kept.
    }
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }
}
