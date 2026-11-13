// UPD-4: "Update" on a Mac, after the signed manifest was accepted (manifest.ts, UPD-1).
//
//   preflight (location writable, same volume) → download the `zip` asset with fetch into
//   <app data>/updates/<random>/ (0700; file 0600; size cap = the signed size; progress as counts) →
//   re-check size + SHA-256 → ditto -x -k → tree and app checks (stage.ts) → start the watchdog
//   (swap-mac.ts) → the caller quits the app.
//
// No browser, and no `com.apple.quarantine` is added (the manifest signature and the zip hash stand
// in for Gatekeeper while builds are unsigned; stage.ts refuses a bundle that carries the mark).
// Every refusal is an outcome with a fixed code (install-refusal.ts); the person sees one fixed
// sentence and the existing download link. Never logged: the download URL (AGENTS.md), paths, tool
// output.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { streamToFile, type DownloadProgress, type FetchLike } from './download.js';
import { InstallRefusal, installCode, type InstallRefusalCode } from './install-refusal.js';
import type { AcceptedUpdate, UpdateAsset } from './manifest.js';
import { recheckZip, unpackZip, verifyStagedApp, type RunProgram } from './stage.js';
import {
  HEALTH_TIMEOUT_MS,
  OPEN,
  PREVIOUS_DIR,
  UNPACKED_DIR,
  bundledNode,
  preflightSwap,
  startWatchdog,
  type SpawnDetached,
} from './swap-mac.js';

export const UPDATES_DIR = 'updates';
export const ZIP_FILE = 'AgentLink.zip';

export interface DownloadedZip {
  /** `<updatesDir>/<random>` (0700). */
  readonly dir: string;
  readonly zipPath: string;
}

/** Downloads the zip asset into a new private folder under `updatesDir`; removes it on a refusal. */
export async function downloadZip(
  asset: UpdateAsset,
  opts: { fetch: FetchLike; updatesDir: string; onProgress?: DownloadProgress },
): Promise<DownloadedZip> {
  if (asset.kind !== 'zip' || asset.platform !== 'darwin') throw new InstallRefusal('not_zip');
  await mkdir(opts.updatesDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(opts.updatesDir, 'u-'));
  const zipPath = join(dir, ZIP_FILE);
  try {
    await streamToFile(asset, opts.fetch, zipPath, opts.onProgress);
    return Object.freeze({ dir, zipPath });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw new InstallRefusal(installCode(error));
  }
}

export interface InstallDeps {
  readonly accepted: AcceptedUpdate;
  /** The app's own data folder (Electron `userData`). */
  readonly stateDir: string;
  /** The installed bundle (`/Applications/AgentLink.app`), from swap-mac.ts appBundleOf. */
  readonly currentApp: string;
  /** This app's process id (the watchdog waits for it to exit). */
  readonly pid: number;
  readonly fetch: FetchLike;
  readonly run: RunProgram;
  /** `bundle-hashes.json` inside `<resources>/app.asar`, or null. */
  readonly readRecord: (resourcesPath: string) => Promise<string | null>;
  readonly spawnDetached: SpawnDetached;
  readonly onProgress?: DownloadProgress;
  /** Tests only: replaces preflightSwap. */
  readonly preflight?: (currentApp: string, updatesDir: string) => Promise<void>;
}

export type InstallOutcome =
  /** The watchdog runs; the caller quits the app now. */
  | { readonly kind: 'restarting'; readonly version: string }
  /** Nothing changed; show the download link (release-check.ts). */
  | { readonly kind: 'fallback'; readonly code: InstallRefusalCode };

/** The whole in-app install up to the restart. Never throws. */
export async function installUpdate(deps: InstallDeps): Promise<InstallOutcome> {
  const { accepted } = deps;
  let dir: string | undefined;
  try {
    if (accepted.asset.kind !== 'zip') throw new InstallRefusal('not_zip');
    const updatesDir = join(deps.stateDir, UPDATES_DIR);
    await mkdir(updatesDir, { recursive: true, mode: 0o700 });
    await (deps.preflight ?? preflightSwap)(deps.currentApp, updatesDir);
    const zip = await downloadZip(accepted.asset, {
      fetch: deps.fetch,
      updatesDir,
      ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
    });
    dir = zip.dir;
    await recheckZip(zip.zipPath, accepted.asset);
    const app = await unpackZip(zip.zipPath, join(dir, UNPACKED_DIR), deps.run);
    await verifyStagedApp(app, {
      version: accepted.version,
      run: deps.run,
      installedNode: bundledNode(deps.currentApp),
      readRecord: deps.readRecord,
    });
    await rm(zip.zipPath, { force: true });
    await mkdir(join(dir, PREVIOUS_DIR), { mode: 0o700 });
    startWatchdog(
      {
        pid: deps.pid,
        currentApp: deps.currentApp,
        stagingDir: dir,
        stateDir: deps.stateDir,
        version: accepted.version,
        launcher: OPEN,
        timeoutMs: HEALTH_TIMEOUT_MS,
      },
      deps.spawnDetached,
    );
    dir = undefined; // the watchdog owns the staging folder now
    return { kind: 'restarting', version: accepted.version };
  } catch (error) {
    return { kind: 'fallback', code: installCode(error, 'swap_failed') };
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
