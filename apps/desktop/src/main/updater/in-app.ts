// UPD-5: "Update now" → progress → "Restart now" in Settings › Updates (the Mac app), on top of
// UPD-4's install (install.ts installFromProcess, restartForUpdate) and the signed manifest (index.ts
// checkForUpdate, kind `zip`).
//
// - Off unless this is a packaged, non-preview Mac copy inside an AgentLink.app bundle AND
//   root-key.json pins a real key. Today it holds the placeholder, so the in-app path is off and the
//   page keeps the download link (release-check.ts), exactly as in 0.5.2.
// - What the page sees is a pipe view (app-update.ts isAppUpdatePipeView): fixed states, versions,
//   the download link built from the version, a flag and a whole percentage. Nothing from the network
//   or the install's errors is shown or logged; a refusal is "install_failed" with the download link.
// - The core can only ask: `install()` runs only for the update this shell verified itself, one at a
//   time; `restart()` only once that update is ready. OD-D option 1: the restart waits for the click.
// - In-app updates are offered only for a plain x.y.z newer than this version (the link the page
//   shows is built from it); anything else stays with the release check.
// - IR-UPD-8-1 #9: the offer may be days old. "Update now" checks the signed manifest again and
//   installs only when it still names exactly the same update (version, URL, SHA-256, size);
//   "Restart now" checks it once more, and the swap goes ahead only if it still does.
import { appBundleOf } from './swap-mac.js';
import { configuredRoot } from './index.js';
import type { InstallOutcome } from './install.js';
import type { AcceptedUpdate } from './manifest.js';
import {
  isNewerVersion,
  macDownloadUrl,
  type AppUpdatePipeView,
  type AppUpdateView,
  type MacArch,
} from '../../shared/app-update.js';

/** True when this copy may update itself in place (see the header). */
export function inAppEnabled(opts: {
  readonly platform: string;
  readonly packaged: boolean;
  readonly preview: boolean;
  readonly execPath: string;
  /** Tests only: a root other than root-key.json. */
  readonly root?: unknown;
}): boolean {
  if (opts.platform !== 'darwin' || !opts.packaged || opts.preview) return false;
  if (appBundleOf(opts.execPath) === null) return false;
  return (opts.root === undefined ? configuredRoot() : configuredRoot(opts.root)) !== undefined;
}

/** What the install reports back while it runs. */
export interface InstallHooks {
  onProgress(done: number, total: number): void;
  onVerifying(): void;
  /** Resolves when the person chooses "Restart now". */
  confirmRestart(): Promise<void>;
}

export interface InAppUpdaterDeps {
  readonly enabled: boolean;
  readonly currentVersion: string;
  readonly arch: MacArch;
  /** The signed manifest's update for this Mac (`zip`), or undefined. May reject (quiet). */
  readonly check: () => Promise<AcceptedUpdate | undefined>;
  /** installFromProcess wrapped in restartForUpdate (it quits the app on `restarting`). */
  readonly install: (accepted: AcceptedUpdate, hooks: InstallHooks) => Promise<InstallOutcome>;
  /** The view changed (main.ts sends it to the core). */
  readonly onChange: () => void;
}

type Phase = 'idle' | 'downloading' | 'verifying' | 'ready' | 'restarting' | 'failed';

/** The same signed update: version and the exact installer (URL, SHA-256, size, form). */
export function sameUpdate(a: AcceptedUpdate | undefined, b: AcceptedUpdate): boolean {
  return (
    a !== undefined &&
    a.version === b.version &&
    a.asset.url === b.asset.url &&
    a.asset.sha256 === b.asset.sha256 &&
    a.asset.size === b.asset.size &&
    a.asset.kind === b.asset.kind &&
    a.asset.platform === b.asset.platform &&
    a.asset.arch === b.asset.arch
  );
}

export class InAppUpdater {
  readonly #deps: InAppUpdaterDeps;
  #offered: AcceptedUpdate | undefined;
  #phase: Phase = 'idle';
  #percent = 0;
  #confirm: (() => void) | undefined;

  constructor(deps: InAppUpdaterDeps) {
    this.#deps = deps;
  }

  /** Asks the signed manifest (enabled only, and not while an install runs). Never throws. */
  async check(): Promise<void> {
    if (!this.#deps.enabled || (this.#phase !== 'idle' && this.#phase !== 'failed')) return;
    let accepted: AcceptedUpdate | undefined;
    try {
      accepted = await this.#deps.check();
    } catch {
      accepted = undefined;
    }
    if (this.#phase !== 'idle' && this.#phase !== 'failed') return;
    const plain =
      accepted !== undefined && isNewerVersion(accepted.version, this.#deps.currentVersion);
    this.#offered = plain ? accepted : undefined;
    this.#phase = 'idle';
    this.#deps.onChange();
  }

  /** The page's view on top of the release check's `base`. */
  view(base: AppUpdateView): AppUpdatePipeView {
    const plainBase: AppUpdatePipeView = Object.freeze({ ...base, installable: false, percent: 0 });
    const offered = this.#offered;
    if (!this.#deps.enabled || offered === undefined) return plainBase;
    const release = {
      current: this.#deps.currentVersion,
      latest: offered.version,
      download: macDownloadUrl(offered.version, this.#deps.arch),
    };
    switch (this.#phase) {
      case 'idle':
        if (base.state === 'checking') return plainBase;
        return Object.freeze({ state: 'available', ...release, installable: true, percent: 0 });
      case 'failed':
        return Object.freeze({
          state: 'install_failed',
          ...release,
          installable: false,
          percent: 0,
        });
      case 'downloading':
        return Object.freeze({
          state: 'downloading',
          ...release,
          installable: true,
          percent: this.#percent,
        });
      default:
        return Object.freeze({ state: this.#phase, ...release, installable: true, percent: 0 });
    }
  }

  /** "Update now": starts the install of the verified update. False when there is none to start. */
  install(): boolean {
    const offered = this.#offered;
    if (!this.#deps.enabled || offered === undefined || this.#phase !== 'idle') return false;
    this.#set('downloading', 0);
    const hooks: InstallHooks = {
      onProgress: (done, total) => {
        if (this.#phase !== 'downloading') return;
        const pct =
          Number.isFinite(done) && Number.isFinite(total) && total > 0
            ? Math.min(100, Math.max(0, Math.floor((done * 100) / total)))
            : 0;
        if (pct !== this.#percent) this.#set('downloading', pct);
      },
      onVerifying: () => this.#set('verifying', 0),
      confirmRestart: () =>
        new Promise<void>((resolve) => {
          this.#confirm = resolve;
          this.#set('ready', 0);
        }).then(async () => {
          // Right before the swap: the signed manifest must still name this update.
          if (!(await this.#stillOffered(offered))) throw new Error('update no longer offered');
        }),
    };
    void this.#stillOffered(offered)
      .then((same) =>
        same
          ? this.#deps.install(offered, hooks)
          : ({ kind: 'fallback', code: 'swap_failed' } as InstallOutcome),
      )
      .catch((): InstallOutcome => ({ kind: 'fallback', code: 'swap_failed' }))
      .then((outcome) => {
        this.#confirm = undefined;
        // `restarting`: the app quits now (restartForUpdate); the page keeps "Restarting".
        if (outcome.kind === 'fallback') this.#set('failed', 0);
      });
    return true;
  }

  /** "Restart now": only once the update is ready. */
  restart(): boolean {
    const confirm = this.#confirm;
    if (this.#phase !== 'ready' || confirm === undefined) return false;
    this.#confirm = undefined;
    this.#set('restarting', 0);
    confirm();
    return true;
  }

  /** The signed manifest checked again now; false when it is gone, refused or names another update. */
  async #stillOffered(offered: AcceptedUpdate): Promise<boolean> {
    try {
      return sameUpdate(await this.#deps.check(), offered);
    } catch {
      return false;
    }
  }

  #set(phase: Phase, percent: number): void {
    this.#phase = phase;
    this.#percent = percent;
    this.#deps.onChange();
  }
}
