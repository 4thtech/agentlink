// WP-D10 Updater phase 1 (plan 2026-11-12 Decision 5, Fable H3; 08 §8 "Signed updates").
//
// One pass: fetch the channel's update manifest, verify it against the one pinned update key
// (manifest.ts, format v2, UPD-1), skip a version recorded as failed (state.ts), download the installer for this
// computer into a private temp folder and check its size and SHA-256 (download.ts), mark it as
// downloaded (quarantine.ts), then ask: "Update available" → "Open the installer" or "Later".
// The person runs the installer. There is NO silent install and no bundle swap in phase 1.
//
// Electron is injected (openPath, showMessageBox), as in the rest of the shell. While root-key.json
// holds the placeholder, the updater does nothing (`not_configured`); release builds refuse to
// package the placeholder (apps/desktop/build/lib/root-key-check.mjs).
import rootKeyFile from './root-key.json' with { type: 'json' };
import { rm } from 'node:fs/promises';
import { downloadInstaller, fetchDocument, hashFile, type FetchLike } from './download.js';
import { installerKind } from './host.js';
import {
  MAX_DOCUMENT_BYTES,
  UpdateRefusal,
  acceptManifest,
  parseUpdateDocument,
  pinnedRoot,
  type AcceptedUpdate,
  type Channel,
  type PinnedRoot,
  type RefusalCode,
} from './manifest.js';
import { markDownloaded } from './quarantine.js';
import { loadFailedVersion } from './state.js';

/** UPD-3 (Fable M1): the key id in the document name is the first 16 hex of the pinned key. */
export const UPDATE_KEY_ID_LENGTH = 16;

export function updateKeyId(pinnedKey: string): string {
  return pinnedKey.slice(0, UPDATE_KEY_ID_LENGTH);
}

const DOCUMENT_BASES: Readonly<Record<Channel, string>> = Object.freeze({
  stable: 'https://github.com/4thtech/agentlink/releases/latest/download/',
  beta: 'https://github.com/4thtech/agentlink/releases/download/desktop-beta/',
});

/**
 * Where this app finds its signed document (release.yml `sign-update-manifest` publishes it). `stable`
 * follows the latest GitHub Release; `beta` a fixed prerelease tag ("latest" never points at a
 * prerelease). The name carries the id of the pinned key (Fable M1), so after a re-pin an app that
 * still trusts the old key asks for the old key's document, never for one it would refuse.
 */
export function documentUrl(channel: Channel, pinnedKey: string): string {
  return `${DOCUMENT_BASES[channel]}desktop-update-${updateKeyId(pinnedKey)}.json`;
}

/** User-facing words (11 §5): plain, no internals. */
export const UPDATE_COPY = Object.freeze({
  title: 'Update available',
  message: (version: string): string => `AgentLink ${version} is ready to install.`,
  detail:
    'It was downloaded and checked. Open the installer and follow its steps. Your IDs, contacts and messages stay as they are.',
  requiredDetail:
    'This version of AgentLink is too old to keep working well. Open the installer and follow its steps. Your IDs, contacts and messages stay as they are.',
  open: 'Open the installer',
  later: 'Later',
});

export interface MessageBoxOptions {
  readonly type: 'info';
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly string[];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly noLink: true;
}

export interface UpdaterDeps {
  readonly currentVersion: string;
  readonly channel: Channel;
  readonly platform: string;
  readonly arch: string;
  /** The app's own data folder (Electron `app.getPath('userData')`). */
  readonly stateDir: string;
  /** Electron `shell.openPath` (resolves '' on success, an error text otherwise). */
  readonly openPath: (path: string) => Promise<string>;
  /** Electron `dialog.showMessageBox`. */
  readonly showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly tempRoot?: string;
  /** Tests only: a root other than root-key.json. */
  readonly root?: unknown;
  readonly markDownloaded?: (path: string, platform: string, nowMs: number) => Promise<void>;
}

export type UpdateOutcome =
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'up_to_date' }
  | { readonly kind: 'refused'; readonly code: RefusalCode }
  | { readonly kind: 'later'; readonly version: string }
  | { readonly kind: 'opened'; readonly version: string };

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export function configuredRoot(raw: unknown = rootKeyFile): PinnedRoot | undefined {
  return pinnedRoot(raw);
}

/**
 * Fetches the channel's manifest and verifies it under the one pinned update key (UPD-1: no key
 * statements; a new key arrives only with a release that pins it). A version recorded as failed
 * (state.ts) is never offered again.
 */
export async function checkForUpdate(
  deps: UpdaterDeps,
): Promise<{ root: PinnedRoot; accepted: AcceptedUpdate | undefined }> {
  const root = configuredRoot(deps.root ?? rootKeyFile);
  if (root === undefined) throw new UpdateRefusal('root_not_pinned');
  const now = (deps.now ?? Date.now)();
  const failedVersion = await loadFailedVersion(deps.stateDir);
  const bytes = await fetchDocument(
    documentUrl(deps.channel, root.rootPublicKey),
    MAX_DOCUMENT_BYTES,
    deps.fetch ?? defaultFetch,
  );
  const accepted = acceptManifest(parseUpdateDocument(bytes), {
    root,
    currentVersion: deps.currentVersion,
    channel: deps.channel,
    platform: deps.platform,
    arch: deps.arch,
    kind: installerKind(deps.platform),
    failedVersion,
    now,
  });
  return { root, accepted };
}

/**
 * The whole phase-1 pass. Never throws: every refusal is an outcome with its code, so the caller can
 * stay quiet (an update check that fails is not the person's problem) and nothing inbound is shown.
 */
export async function runUpdateCheck(deps: UpdaterDeps): Promise<UpdateOutcome> {
  if (configuredRoot(deps.root ?? rootKeyFile) === undefined) return { kind: 'not_configured' };
  let dir: string | undefined;
  try {
    let accepted: AcceptedUpdate | undefined;
    try {
      ({ accepted } = await checkForUpdate(deps));
    } catch (error) {
      // An older or equal version is the normal "nothing new" case.
      if (error instanceof UpdateRefusal && error.code === 'not_newer')
        return { kind: 'up_to_date' };
      throw error;
    }
    if (accepted === undefined) return { kind: 'up_to_date' };
    const fetchImpl = deps.fetch ?? defaultFetch;
    const installer = await downloadInstaller(accepted.asset, fetchImpl, deps.tempRoot);
    dir = installer.dir;
    const nowMs = (deps.now ?? Date.now)();
    try {
      await (deps.markDownloaded ?? markDownloaded)(installer.path, deps.platform, nowMs);
    } catch {
      throw new UpdateRefusal('download_failed');
    }
    const { response } = await deps.showMessageBox({
      type: 'info',
      title: UPDATE_COPY.title,
      message: UPDATE_COPY.message(accepted.version),
      detail: accepted.required ? UPDATE_COPY.requiredDetail : UPDATE_COPY.detail,
      buttons: [UPDATE_COPY.open, UPDATE_COPY.later],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return { kind: 'later', version: accepted.version };
    // Check the file again right before it is opened (it sat on disk while the dialog was up).
    const again = await hashFile(installer.path);
    if (again.size !== accepted.asset.size) throw new UpdateRefusal('size_mismatch');
    if (again.sha256 !== accepted.asset.sha256) throw new UpdateRefusal('hash_mismatch');
    const opened = await deps.openPath(installer.path);
    if (opened !== '') throw new UpdateRefusal('download_failed');
    dir = undefined; // the installer is in use; the OS temp folder cleanup removes it later
    return { kind: 'opened', version: accepted.version };
  } catch (error) {
    if (error instanceof UpdateRefusal) return { kind: 'refused', code: error.code };
    return { kind: 'refused', code: 'download_failed' };
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
