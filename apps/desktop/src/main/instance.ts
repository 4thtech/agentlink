// One AgentLink per profile, never a silent exit (D15-01, DESK051-C5).
//
// The single-instance lock is per profile (Electron's user-data folder), not per build. Before this
// check a second launch exited at once and the running copy only showed its window, so an old or
// stuck copy (closing the window does not quit: tray) silently captured every launch of a new build.
//
// Now:
// - The launching copy puts its build identity next to its checked deep link in the lock's
//   additionalData: { deepLink, build: { version, execPath, stamp } }. `stamp` describes app.asar on
//   disk (size, mtime, inode), so an app replaced in place under the same path and version differs.
// - The running copy compares it with its own. Same build: show the window (as before). Another
//   build: show the window and a fixed dialog that names both versions and offers "Quit and switch",
//   which relaunches the other copy's executable (only an AgentLink app executable, see
//   relaunchTarget) with the forwarded deep link, then quits.
// - The running copy keeps a small record (pid + build) in its user-data folder. A launching copy
//   whose lock failed and that finds no live record knows the running copy predates this check (it
//   ignores the build field) and tells the person itself: "An older AgentLink is still open". On
//   macOS it can find that copy's pid from Chromium's profile lock (SingletonLock) and, when the
//   person agrees and that pid is an AgentLink app executable, ask it to quit (SIGTERM: Electron
//   quits normally on it) and relaunch itself. Elsewhere it says how to quit it.
//
// Not a security boundary: a same-user process can already start or stop any app (04 §2.5). The
// relaunch path is still checked, so a forged lock message cannot make AgentLink start another
// program. Nothing here is logged; the dialogs show versions and folders only.
import { compareVersions } from './updater/manifest.js';
import type { App, MessageBoxOptions } from './electron-api.js';

/** The identity a launch carries in the lock's additionalData. */
export interface BuildIdentity {
  readonly version: string;
  readonly execPath: string;
  /** app.asar on disk at start: `<size>-<mtimeMs>-<ino>` (or '' when unknown). */
  readonly stamp: string;
}

/** What the shell needs from the OS for this (injected; realInstanceOps below). */
export interface InstanceOps {
  readonly build: BuildIdentity;
  readonly pid: number;
  /** The running copy's record (instanceRecord), or null. */
  read(): string | null;
  write(text: string): void;
  remove(): void;
  /** macOS: the pid holding the profile lock (SingletonLock), or null when unknown. */
  lockOwner(): number | null;
  alive(pid: number): boolean;
  /** Asks `pid` to quit, only when it is an AgentLink app executable; false otherwise. */
  askToQuit(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

/** The record file in the user-data folder. */
export const INSTANCE_FILE = 'agentlink-instance.json';

const MAX_FIELD = 4096;
const BUILD_KEYS = ['execPath', 'stamp', 'version'];

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

function asBuild(value: unknown): BuildIdentity | null {
  if (!isPlain(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== BUILD_KEYS.length || keys.some((k, i) => k !== BUILD_KEYS[i])) return null;
  for (const key of BUILD_KEYS) {
    const field = value[key];
    if (typeof field !== 'string' || field.length > MAX_FIELD) return null;
  }
  return {
    version: value['version'] as string,
    execPath: value['execPath'] as string,
    stamp: value['stamp'] as string,
  };
}

/** The lock's additionalData for this launch. */
export function lockData(deepLink: string | null, build: BuildIdentity): Record<string, unknown> {
  return {
    deepLink,
    build: { version: build.version, execPath: build.execPath, stamp: build.stamp },
  };
}

/**
 * The build a second launch forwarded, or null. Only `{ deepLink, build }` (switches.ts
 * forwardedDeepLink reads the same shape), with `build` exactly `{ version, execPath, stamp }`.
 */
export function forwardedBuild(additionalData: unknown): BuildIdentity | null {
  if (!isPlain(additionalData)) return null;
  const keys = Object.keys(additionalData).sort();
  if (keys.length !== 2 || keys[0] !== 'build' || keys[1] !== 'deepLink') return null;
  return asBuild(additionalData['build']);
}

export function sameBuild(a: BuildIdentity, b: BuildIdentity): boolean {
  return a.version === b.version && a.execPath === b.execPath && a.stamp === b.stamp;
}

/** The record the running copy keeps. */
export function instanceRecord(pid: number, build: BuildIdentity): string {
  return JSON.stringify({ v: 1, pid, build });
}

export function parseInstanceRecord(
  text: string | null,
): { readonly pid: number; readonly build: BuildIdentity } | null {
  if (text === null || text.length > 4 * MAX_FIELD) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlain(value) || value['v'] !== 1) return null;
  const pid = value['pid'];
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const build = asBuild(value['build']);
  return build === null ? null : { pid, build };
}

/**
 * The executable to relaunch for "Quit and switch": only an AgentLink app executable at an absolute
 * path without `..` (macOS `…/AgentLink.app/Contents/MacOS/AgentLink`, Windows `…\AgentLink.exe`).
 */
export function relaunchTarget(execPath: string, platform: string): string | null {
  if (execPath.length === 0 || execPath.length > MAX_FIELD || execPath.includes('\0')) return null;
  if (platform === 'win32') {
    if (!/^[A-Za-z]:\\/.test(execPath)) return null;
    if (execPath.split(/[\\/]/).includes('..')) return null;
    return /\\AgentLink\.exe$/i.test(execPath) ? execPath : null;
  }
  if (!execPath.startsWith('/')) return null;
  if (execPath.split('/').includes('..')) return null;
  return /\/[^/]+\.app\/Contents\/MacOS\/AgentLink$/.test(execPath) ? execPath : null;
}

/** Fixed copy (11 §5 vocabulary). */
export const INSTANCE_COPY = {
  title: 'AgentLink',
  olderOpen: 'An older AgentLink is still open',
  anotherOpen: 'Another AgentLink is still open',
  runningDetail: 'Quit it to use the one you just opened.',
  switch: 'Quit and switch',
  keep: 'Keep this one',
  olderDetail: 'Quit it to use this one.',
  quitOther: 'Quit it and open this one',
  cancel: 'Cancel',
  ok: 'OK',
  couldNotQuit: 'AgentLink couldn’t close the older copy',
  manualMac:
    'Click the AgentLink icon in the menu bar and choose Quit AgentLink. Then open AgentLink again.',
  manualWin:
    'Click the AgentLink icon in the notification area (next to the clock) and choose Quit AgentLink. Then open AgentLink again.',
} as const;

const manual = (platform: string): string =>
  platform === 'win32' ? INSTANCE_COPY.manualWin : INSTANCE_COPY.manualMac;

/** The folder an executable is in, for the dialog (the .app on macOS). */
function where(execPath: string, platform: string): string {
  if (platform === 'darwin') {
    const at = execPath.indexOf('.app/Contents/MacOS/');
    if (at >= 0) return execPath.slice(0, at + '.app'.length);
  }
  const sep = Math.max(execPath.lastIndexOf('/'), execPath.lastIndexOf('\\'));
  return sep > 0 ? execPath.slice(0, sep) : execPath;
}

function newer(theirs: string, mine: string): boolean {
  try {
    return compareVersions(theirs, mine) > 0;
  } catch {
    return false;
  }
}

/** Shown by the RUNNING copy when another build was opened. */
export function runningDialog(
  mine: BuildIdentity,
  theirs: BuildIdentity,
  platform: string,
): MessageBoxOptions {
  const line = (label: string, b: BuildIdentity): string =>
    `${label}: AgentLink ${b.version.slice(0, 40)} in ${where(b.execPath, platform).slice(0, 300)}`;
  return {
    type: 'warning',
    title: INSTANCE_COPY.title,
    message: newer(theirs.version, mine.version)
      ? INSTANCE_COPY.olderOpen
      : INSTANCE_COPY.anotherOpen,
    detail: `${INSTANCE_COPY.runningDetail}\n\n${line('Open now', mine)}\n${line('Just opened', theirs)}`,
    buttons: [INSTANCE_COPY.switch, INSTANCE_COPY.keep],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

/** Shown by the LAUNCHING copy when the running one predates this check. */
export function olderStillOpenDialog(platform: string, canQuit: boolean): MessageBoxOptions {
  return canQuit
    ? {
        type: 'warning',
        title: INSTANCE_COPY.title,
        message: INSTANCE_COPY.olderOpen,
        detail: INSTANCE_COPY.olderDetail,
        buttons: [INSTANCE_COPY.quitOther, INSTANCE_COPY.cancel],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }
    : {
        type: 'warning',
        title: INSTANCE_COPY.title,
        message: INSTANCE_COPY.olderOpen,
        detail: `${INSTANCE_COPY.olderDetail} ${manual(platform)}`,
        buttons: [INSTANCE_COPY.ok],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
}

export function couldNotQuitDialog(platform: string): MessageBoxOptions {
  return {
    type: 'error',
    title: INSTANCE_COPY.title,
    message: INSTANCE_COPY.couldNotQuit,
    detail: manual(platform),
    buttons: [INSTANCE_COPY.ok],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/** How long the launching copy waits for the older copy to quit (it stops its core first). */
export const QUIT_WAIT_MS = 15_000;
const QUIT_POLL_MS = 250;

/**
 * The launching copy, after its lock failed. Resolves when this process should exit (code 0). A live
 * record means the running copy has this check and answers itself (window or runningDialog).
 */
export async function secondLaunch(
  app: Pick<App, 'whenReady' | 'relaunch'>,
  dialog: { showMessageBox(options: MessageBoxOptions): Promise<{ response: number }> },
  ops: InstanceOps,
  platform: string,
): Promise<void> {
  const record = parseInstanceRecord(ops.read());
  const owner = ops.lockOwner();
  if (record !== null && ops.alive(record.pid) && (owner === null || owner === record.pid)) return;
  await app.whenReady();
  const canQuit = owner !== null && owner !== ops.pid && ops.alive(owner);
  const { response } = await dialog.showMessageBox(olderStillOpenDialog(platform, canQuit));
  if (!canQuit || response !== 0) return;
  if (ops.askToQuit(owner)) {
    for (let waited = 0; waited < QUIT_WAIT_MS && ops.alive(owner); waited += QUIT_POLL_MS) {
      await ops.sleep(QUIT_POLL_MS);
    }
    if (!ops.alive(owner)) {
      // Relaunches this same executable with the same (already checked) arguments once we exit.
      app.relaunch?.();
      return;
    }
  }
  await dialog.showMessageBox(couldNotQuitDialog(platform));
}
