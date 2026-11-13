// DESK051-UPD: the pure rules of "Check for updates" (shared by the shell's checker and the pipe
// protocol). 0.5.1 ships with the signed updater off (no pinned update key, WP-D10), so the app only
// learns the latest published version and offers the exact release file for this computer in the
// default browser. Nothing here touches the network, the disk or Electron.
//
// - Versions: only plain `x.y.z` releases are ever "newer" (no prerelease, no build suffix, no `v`,
//   no leading zeros, at most six digits a part). The installed version may carry a short suffix (a
//   development build says `0.0.0-dev`); such a build is never offered anything.
// - Links: built here from a checked version and a fixed architecture word, never taken from the
//   network. The Mac file names are the ones the release attaches (release.yml, build-mac.mjs):
//   AgentLink-<version>-mac-<arm64|x64>.dmg. Other platforms get the release page.

/** What the Settings page can show (fixed words; the copy lives in the page). */
export const APP_UPDATE_STATES = [
  'off',
  'idle',
  'checking',
  'current',
  'available',
  'failed',
  'offline',
  // UPD-5: the in-app update on a Mac (updater/in-app.ts). "install_failed" is "Couldn't update
  // here": the download link stays.
  'downloading',
  'verifying',
  'ready',
  'restarting',
  'install_failed',
] as const;
export type AppUpdateState = (typeof APP_UPDATE_STATES)[number];

/** UPD-5: the states of a running in-app update (always installable). */
export const IN_APP_STATES = ['downloading', 'verifying', 'ready', 'restarting'] as const;

/** The states that carry a newer version and its download link. */
const WITH_RELEASE: readonly string[] = ['available', 'install_failed', ...IN_APP_STATES];

/** What the shell tells the core (and the core the page). `latest`/`download` only when available. */
export interface AppUpdateView {
  readonly state: AppUpdateState;
  readonly current: string;
  readonly latest: string;
  readonly download: string;
}

const NUM = '(0|[1-9][0-9]{0,5})';
const RELEASE_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const APP_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-[0-9A-Za-z][0-9A-Za-z.]{0,31})?$`);

/** This repository's releases (D15-11: the only GitHub path the app opens). */
const RELEASES = 'https://github.com/4thtech/agentlink/releases';

/** [major, minor, patch] of a plain release version, or undefined. */
export function parseReleaseVersion(v: unknown): readonly [number, number, number] | undefined {
  if (typeof v !== 'string') return undefined;
  const m = RELEASE_VERSION.exec(v);
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True for a version the app may report as its own (a release, or a short build suffix). */
export function isAppVersion(v: unknown): v is string {
  return typeof v === 'string' && APP_VERSION.test(v);
}

/** True only when both are plain release versions and `latest` is strictly greater. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseReleaseVersion(latest);
  const b = parseReleaseVersion(current);
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number);
  }
  return false;
}

export type MacArch = 'arm64' | 'x64';

/**
 * The Mac build for this computer from Node's `process.arch`. An Intel copy running under Rosetta on
 * Apple silicon (`translated`, Electron `app.runningUnderARM64Translation`) gets the Apple silicon one.
 */
export function macArch(arch: string, translated: boolean): MacArch | undefined {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return translated ? 'arm64' : 'x64';
  return undefined;
}

const checked = (version: string): string => {
  if (parseReleaseVersion(version) === undefined) throw new Error('app-update: not a version');
  return version;
};

export function macAssetName(version: string, arch: MacArch): string {
  return `AgentLink-${checked(version)}-mac-${arch}.dmg`;
}

/** The exact release file for this Mac. */
export function macDownloadUrl(version: string, arch: MacArch): string {
  return `${RELEASES}/download/v${checked(version)}/${macAssetName(version, arch)}`;
}

/** The release page (other platforms). */
export function releasePageUrl(version: string): string {
  return `${RELEASES}/tag/v${checked(version)}`;
}

/** True when `url` is exactly one of the links this module builds for `version`. */
export function isDownloadUrlFor(url: unknown, version: string): boolean {
  if (typeof url !== 'string' || parseReleaseVersion(version) === undefined) return false;
  return (
    url === macDownloadUrl(version, 'arm64') ||
    url === macDownloadUrl(version, 'x64') ||
    url === releasePageUrl(version)
  );
}

/**
 * UPD-5: what the shell sends the core (the pipe's `app-update`): the view plus whether "Update now"
 * can run here and the download's whole percentage. No free text: fixed words, versions, the link the
 * shell built, a flag and a number.
 */
export interface AppUpdatePipeView extends AppUpdateView {
  readonly installable: boolean;
  readonly percent: number;
}

/**
 * UPD-5: the six fields fit together. `installable` is true in the running states and false in
 * "install_failed" and every state without a release; `percent` is a whole 0..100 while downloading
 * and 0 otherwise.
 */
export function isAppUpdatePipeView(value: {
  readonly state: unknown;
  readonly current: unknown;
  readonly latest: unknown;
  readonly download: unknown;
  readonly installable: unknown;
  readonly percent: unknown;
}): value is AppUpdatePipeView {
  const { state, installable, percent } = value;
  if (!isAppUpdateView(value)) return false;
  if (typeof installable !== 'boolean') return false;
  if (typeof percent !== 'number' || !Number.isSafeInteger(percent)) return false;
  if (percent < 0 || percent > 100 || (state !== 'downloading' && percent !== 0)) return false;
  if ((IN_APP_STATES as readonly unknown[]).includes(state)) return installable;
  if (state === 'available') return true;
  return !installable;
}

/** True when the fields fit together: a version and a link only with a release. */
export function isAppUpdateView(value: {
  readonly state: unknown;
  readonly current: unknown;
  readonly latest: unknown;
  readonly download: unknown;
}): value is AppUpdateView {
  const { state, current, latest, download } = value;
  if (typeof state !== 'string' || !(APP_UPDATE_STATES as readonly string[]).includes(state)) {
    return false;
  }
  if (!isAppVersion(current)) return false;
  if (WITH_RELEASE.includes(state)) {
    return (
      typeof latest === 'string' &&
      isNewerVersion(latest, current) &&
      isDownloadUrlFor(download, latest)
    );
  }
  return latest === '' && download === '';
}
