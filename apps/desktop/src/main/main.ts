// The desktop shell's Electron main process (plan 2026-11-12 Decisions 2 and 3, WP-D2).
//
// Order matters:
// 1. The launch lockdown (switches.ts) runs first: a forbidden switch, Node option or environment
//    variable → exit LAUNCH_REFUSED_EXIT before the single-instance lock, any window or the core.
// 2. The sandbox is enabled for every renderer; one instance only. A second launch forwards only its
//    already-checked deep link and its build identity (single-instance additionalData), never its raw
//    argv. A different build is never swallowed silently (instance.ts, D15-01).
// 3. When ready: a packaged app refuses a translocated / read-only / temporary location (move.ts);
//    the in-memory window session is hardened (security.ts); every webContents ever created is
//    locked; the core desktop host starts under the supervisor (core-process.ts) with a clean env.
// 4. The window opens AT ONCE with the fixed local status page ("Starting AgentLink…",
//    status-page.ts) and loads only a session link the core sent over fd 3 (`ready`), on the locked
//    origin. When the core cannot start, the window shows a fixed page for the reason with Try again
//    and Open log folder. The core's stderr is kept, redacted, in a capped ring and a 0600 log file
//    (core-log.ts). The tray always exists (built-in image when the icon file is missing).
// 5. Quit sends `shutdown`, waits for the core (kill after the grace period), then exits.
//
// Preview mode (owner-feedback loop, dev builds only): `__AGENTLINK_DESKTOP_PREVIEW__` is a
// BUILD-TIME constant. The release build defines it as `false`, so the bundler removes the branch
// that reads the preview environment variables; CI greps the built ASAR for their names (WP-D4/D5).
// In tests and in an unbundled run the constant is undefined, which also means "no preview".
//
// The shell holds no key, no store and signs nothing (phases 1–2). Nothing here logs. The Electron
// entry point is entry.ts (it imports the `electron` module; this file takes it by injection).
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLE_HASHES_FILE, bundleFilePaths, verifyBundle } from './bundle-check.js';
import { CoreLog, logDir } from './core-log.js';
import { CoreSupervisor, aiAppMarkerSet, type SpawnFn, type Timers } from './core-process.js';
import { INVITE_RESULT_TITLE, inviteResultCopy, toInviteLink } from './deep-link.js';
import type { App, ElectronModule } from './electron-api.js';
import {
  INSTANCE_FILE,
  forwardedBuild,
  instanceRecord,
  lockData,
  parseInstanceRecord,
  relaunchTarget,
  runningDialog,
  sameBuild,
  secondLaunch,
  type BuildIdentity,
  type InstanceOps,
} from './instance.js';
import { ensureGoodLocation, locationProblem } from './move.js';
import RESOURCE_LAYOUT from '../shared/resource-layout.json' with { type: 'json' };
import { OriginLock, WINDOW_PARTITION, hardenSession, lockWebContents } from './security.js';
import {
  DEEP_LINK_SCHEME,
  MAX_DEEP_LINK_CHARS,
  checkLaunch,
  commandLineIsClean,
  forwardedDeepLink,
} from './switches.js';
import type { StatusAction } from './status-page.js';
import { AppTray, trayImage } from './tray.js';
import { ReleaseChecker, updateChecksAllowed } from './updater/release-check.js';
import { scheduleUpdateChecks } from './updater/schedule.js';
import { MainWindow } from './window.js';
import type { AppUpdateView } from '../shared/app-update.js';
import type { InviteOutcome } from '../shared/protocol.js';

declare const __AGENTLINK_DESKTOP_PREVIEW__: boolean | undefined;

/** Exit code for a refused launch (any non-zero code; fixed so tests and CI can assert it). */
export const LAUNCH_REFUSED_EXIT = 64;

/**
 * WIN-DESK-1: exit code when Electron cannot resolve the app's data folder (on Windows: the
 * profile's Roaming folder is missing or broken). Without it the single-instance lock fails, and
 * the start must not be reported as "another AgentLink is running".
 */
export const PROFILE_UNAVAILABLE_EXIT = 66;

/** The preview settings of a development build (owner-feedback loop). */
export interface PreviewSettings {
  /** An absolute node binary to run the core with (a development checkout). */
  readonly node: string | undefined;
  /** An absolute core host script (a development checkout). */
  readonly hostScript: string | undefined;
}

/**
 * The preview settings, or null. In a release build `__AGENTLINK_DESKTOP_PREVIEW__` is defined as
 * `false`, the condition folds to `true` and the bundler drops the rest of this function, so the
 * release bundle contains none of the variable names below (CI checks the built ASAR).
 */
export function readPreview(
  env: Readonly<Record<string, string | undefined>>,
): PreviewSettings | null {
  if (!(
    typeof __AGENTLINK_DESKTOP_PREVIEW__ !== 'undefined' && __AGENTLINK_DESKTOP_PREVIEW__ === true
  )) {
    return null;
  }
  if (env['AGENTLINK_DESKTOP_PREVIEW'] !== '1') return null;
  return {
    node: env['AGENTLINK_DESKTOP_PREVIEW_NODE'],
    hostScript: env['AGENTLINK_DESKTOP_PREVIEW_HOST'],
  };
}

/** Where the bundled pieces live inside the installed app (WP-D4 lays them out there). */
export interface ResourcePaths {
  readonly node: string;
  readonly hostScript: string;
  readonly trayIcon: string;
}

/**
 * The fixed layout under `process.resourcesPath` (macOS `AgentLink.app/Contents/Resources`, Windows
 * `…\AgentLink\resources`), from src/shared/resource-layout.json, which WP-D4's packaging reads too.
 */
export function resourcePaths(resourcesPath: string, platform: string): ResourcePaths {
  const node = join(
    resourcesPath,
    ...(platform === 'win32' ? RESOURCE_LAYOUT.node.win32 : RESOURCE_LAYOUT.node.posix),
  );
  return {
    node,
    hostScript: join(resourcesPath, ...RESOURCE_LAYOUT.hostScript),
    trayIcon: join(
      resourcesPath,
      ...RESOURCE_LAYOUT.assetsDir,
      platform === 'darwin' ? 'trayTemplate.png' : platform === 'win32' ? 'tray.ico' : 'tray.png',
    ),
  };
}

/** What runShell needs from the process and the OS (injected so tests run without Electron). */
export interface ShellProcess {
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly execPath: string;
  readonly resourcesPath: string;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly writable: (path: string) => boolean;
  readonly exists: (path: string) => boolean;
  readonly spawn: SpawnFn;
  readonly timers: Timers;
  /** Preview settings (readPreview); always null in a release build. */
  readonly preview: PreviewSettings | null;
  /**
   * WP-D9's deep-link handler (deep-link.ts toInviteLink, wired by realProcess): an `agentlink://`
   * argument → the canonical invite link, or null to ignore it. Absent → nothing is accepted.
   */
  readonly toInviteLink?: (deepLink: string) => string | null;
  /** The per-user folder for core.log (core-log.ts logDir). */
  readonly logDir: string;
  /** WP-D10: starts the phase-1 update checks (packaged release builds only). Absent: none. */
  readonly startUpdates?: (electron: ElectronModule) => void;
  /**
   * DESK051-UPD: "Check for updates" (updater/release-check.ts), told about every change. Absent:
   * Settings > Updates gets no state (tests).
   */
  readonly releaseChecker?: (
    electron: ElectronModule,
    onChange: (view: AppUpdateView) => void,
  ) => ReleaseChecker;
  /** D15-01: this build's identity and the running-copy record (instance.ts). Absent: legacy lock. */
  readonly instance?: (app: App) => InstanceOps;
  /** D15-07: the startup tripwire for the bundled files (bundle-check.ts). Absent: not checked. */
  readonly verifyBundle?: () => Promise<'ok' | 'changed' | 'unchecked'>;
}

export type ShellOutcome = 'refused' | 'profile' | 'second-instance' | 'location' | 'running';

/** Starts the shell. Resolves once started (or refused); the app then runs on events. */
export async function runShell(
  electron: ElectronModule,
  proc: ShellProcess,
): Promise<ShellOutcome> {
  const { app } = electron;
  const preview = proc.preview;

  // 1. Launch lockdown.
  const launch = checkLaunch({
    argv: proc.argv,
    execArgv: proc.execArgv,
    env: proc.env,
    platform: proc.platform,
    packaged: app.isPackaged,
    preview: preview !== null,
  });
  if (!launch.ok) {
    app.exit(LAUNCH_REFUSED_EXIT);
    return 'refused';
  }
  const hasSwitch = (name: string): boolean => app.commandLine.hasSwitch(name);
  if (!commandLineIsClean(hasSwitch, launch.userDataDir !== null)) {
    app.exit(LAUNCH_REFUSED_EXIT);
    return 'refused';
  }

  // The log keeps one fixed line when the shell quits on its own at start (no window yet), so a
  // start that "does nothing" can be told apart afterwards: another copy running, or the folder.
  const coreLog = new CoreLog({ dir: proc.logDir });

  // 2. Sandbox for every renderer; one instance.
  app.enableSandbox();
  // WIN-DESK-1: the lock lives in the data folder. When Electron cannot resolve it, getPath
  // throws and the lock would fail for that reason alone: say so (fixed line), never "another
  // AgentLink is running". Nothing from the error is kept.
  let profileOk = true;
  try {
    if (app.getPath !== undefined) app.getPath('userData');
  } catch {
    profileOk = false;
  }
  if (!profileOk) {
    coreLog.note('app quit at start: the AgentLink data folder is not available');
    app.exit(PROFILE_UNAVAILABLE_EXIT);
    return 'profile';
  }
  let instance: InstanceOps | null = null;
  try {
    instance = proc.instance?.(app) ?? null;
  } catch {
    instance = null;
  }
  const lockPayload =
    instance === null ? { deepLink: launch.deepLink } : lockData(launch.deepLink, instance.build);
  if (!app.requestSingleInstanceLock(lockPayload)) {
    // D15-01: never a silent exit when the running copy cannot answer for itself.
    if (instance !== null) {
      await secondLaunch(app, electron.dialog, instance, proc.platform).catch(() => undefined);
    }
    coreLog.note('app quit at start: another AgentLink is running');
    app.exit(0);
    return 'second-instance';
  }
  const ownRecord = instance === null ? null : instanceRecord(instance.pid, instance.build);
  const writeRecord = (): void => {
    try {
      if (instance !== null && ownRecord !== null) instance.write(ownRecord);
    } catch {
      // Without the record a later build tells the person "older copy" instead; nothing breaks.
    }
  };
  const removeRecord = (): void => {
    try {
      if (instance !== null && parseInstanceRecord(instance.read())?.pid === instance.pid) {
        instance.remove();
      }
    } catch {
      // Best effort.
    }
  };
  writeRecord();

  const lock = new OriginLock();
  let quitting = false;
  let supervisor: CoreSupervisor | null = null;
  let window: MainWindow | null = null;
  let tray: AppTray | null = null;
  let pendingInvite: string | null = null;
  const toInviteLink = proc.toInviteLink ?? ((): null => null);
  // DESK051-UPD: the update state goes to the core (Settings > Updates) after every `ready` and on
  // every change; the core can only ask for a check.
  const sendAppUpdate = (view: AppUpdateView): void => {
    try {
      supervisor?.send({ v: 1, type: 'app-update', ...view });
    } catch {
      // An invalid view is never sent (the encoder checks it again).
    }
  };
  const releaseChecker = proc.releaseChecker?.(electron, sendAppUpdate) ?? null;

  const sendInvite = (link: string): void => {
    try {
      if (supervisor?.send({ v: 1, type: 'invite', link }) !== true) pendingInvite = link;
    } catch {
      // An invalid link is dropped silently (never logged).
    }
  };
  const handleDeepLink = (deepLink: string): void => {
    const link = toInviteLink(deepLink);
    if (link !== null) sendInvite(link);
  };
  // WP-D9: the fixed copy for an invite the core did not open (one dialog at a time, so a website
  // that triggers the scheme repeatedly cannot stack them). Nothing from the invite is shown.
  let inviteDialogOpen = false;
  const showInviteResult = (outcome: InviteOutcome): void => {
    const message = inviteResultCopy(outcome);
    if (message === null || inviteDialogOpen) return;
    inviteDialogOpen = true;
    void electron.dialog
      .showMessageBox({
        type: 'info',
        title: INVITE_RESULT_TITLE,
        message,
        buttons: ['OK'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .catch(() => undefined)
      .finally(() => {
        inviteDialogOpen = false;
      });
  };
  const showWindow = (): void => {
    const shown = window?.show() === true;
    if (shown && window?.loaded === true) return;
    supervisor?.send({ v: 1, type: 'show', route: 'home' });
  };
  // D15-01: another build was opened while this one runs. Fixed dialog (one at a time); "Quit and
  // switch" relaunches that copy (an AgentLink app executable only) with the forwarded deep link.
  let switchDialogOpen = false;
  const offerSwitch = (mine: BuildIdentity, theirs: BuildIdentity, link: string | null): void => {
    if (switchDialogOpen) return;
    switchDialogOpen = true;
    void electron.dialog
      .showMessageBox(runningDialog(mine, theirs, proc.platform))
      .then(({ response }) => {
        const target = relaunchTarget(theirs.execPath, proc.platform);
        if (response === 0 && target !== null && proc.exists(target) && app.relaunch) {
          app.relaunch({ execPath: target, args: link === null ? [] : ['--', link] });
          app.quit();
          return;
        }
        if (link !== null) handleDeepLink(link);
      })
      .catch(() => undefined)
      .finally(() => {
        switchDialogOpen = false;
      });
  };

  app.on('web-contents-created', (_event, contents) =>
    lockWebContents(contents, lock, electron.shell),
  );
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    const link = forwardedDeepLink(additionalData);
    const theirs = instance === null ? null : forwardedBuild(additionalData);
    if (instance !== null && theirs !== null && !sameBuild(theirs, instance.build)) {
      showWindow();
      offerSwitch(instance.build, theirs, link);
      return;
    }
    if (link !== null) handleDeepLink(link);
    showWindow();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (
      typeof url === 'string' &&
      url.startsWith(DEEP_LINK_SCHEME) &&
      url.length <= MAX_DEEP_LINK_CHARS
    ) {
      handleDeepLink(url);
    }
  });
  // The app lives in the tray: closing the window does not quit.
  app.on('window-all-closed', () => undefined);
  app.on('activate', () => showWindow());
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    const stop = supervisor?.stop() ?? Promise.resolve();
    void stop.then(() => {
      removeRecord();
      tray?.destroy();
      window?.destroy();
      app.quit();
    });
  });

  await app.whenReady();

  // 3. Location (packaged builds; a development run starts from the repository).
  if (app.isPackaged) {
    const where = {
      platform: proc.platform,
      execPath: proc.execPath,
      tmpDir: proc.tmpDir,
      writable: proc.writable,
    };
    const outcome = await ensureGoodLocation(where, app, electron.dialog);
    if (outcome !== 'ok') {
      // The kind only (translocated, read_only, temporary), never the path.
      coreLog.note(
        `app quit at start: it cannot run from this folder (${String(locationProblem(where))})`,
      );
      quitting = true;
      removeRecord();
      app.exit(0);
      return 'location';
    }
  }

  const windowSession = electron.session.fromPartition(WINDOW_PARTITION, { cache: false });
  // DESK-TOUCHID-FIX: before a request that starts the presence helper reaches the core, focus
  // leaves the page (secure input off), so the Touch ID sheet can become key.
  await hardenSession(windowSession, lock, proc.platform, () => {
    window?.blurPage();
  });

  // Set below, once the supervisor and the checks exist.
  let onStatusAction: (action: StatusAction) => void = () => undefined;
  window = new MainWindow({
    BrowserWindow: electron.BrowserWindow,
    shell: electron.shell,
    lock,
    platform: proc.platform,
    quitting: () => quitting,
    onStatusAction: (action) => onStatusAction(action),
  });
  // The window comes up at once: the person sees AgentLink starting, never nothing.
  window.showStatus('starting');

  const paths = resourcePaths(proc.resourcesPath, proc.platform);
  let nodePath = paths.node;
  let hostScript = paths.hostScript;
  if (preview !== null) {
    // Preview only: run the core from a development checkout.
    nodePath = preview.node ?? nodePath;
    hostScript = preview.hostScript ?? hostScript;
  }

  // Always a tray (the only way back after the window is closed): built-in image as a fallback.
  const icon = proc.exists(paths.trayIcon) ? paths.trayIcon : '';
  tray = new AppTray(electron, trayImage(electron.nativeImage, icon, proc.platform), {
    open: showWindow,
    retry: () => tryAgain(),
    quit: () => app.quit(),
  });

  let approvals = 0;
  supervisor = new CoreSupervisor({
    nodePath,
    hostScript,
    cwd: proc.homeDir,
    env: proc.env,
    platform: proc.platform,
    spawn: proc.spawn,
    timers: proc.timers,
    onStart: () => {
      coreLog.note('core started');
      window?.resetForNewCore();
      // The old page's server is gone: show the starting page until the new core is ready.
      if (window?.page === 'session') window.showStatus('starting');
    },
    onStderr: (chunk) => coreLog.write(chunk),
    onExit: (code, signal) => {
      coreLog.flush();
      const how =
        signal !== null ? `signal ${signal.replace(/[^A-Z0-9]/g, '')}` : `code ${String(code)}`;
      coreLog.note(`core exited (${how})`);
      // D15-12: the session page's server is gone; never leave that page up while nothing (or
      // something else) answers on its port until the next start.
      if (!quitting && window?.page === 'session') window.showStatus('starting');
    },
    onMessage: (message) => {
      switch (message.type) {
        case 'ready':
          // WIN-DESK-1: proof the pipe works both ways (fixed text, never the link).
          coreLog.note('core ready');
          if (releaseChecker !== null) sendAppUpdate(releaseChecker.view());
          if (window?.loadSessionUrl(message.sessionUrl) === true) {
            window.show();
            if (pendingInvite !== null) {
              const link = pendingInvite;
              pendingInvite = null;
              sendInvite(link);
            }
          }
          return;
        case 'status':
          approvals = message.counts.waitingApprovals;
          tray?.update(message.state, approvals);
          return;
        case 'approval-waiting':
          // WP-D8 adds the text-free notification; the tray shows the number.
          approvals = message.count;
          return;
        case 'invite-result':
          showInviteResult(message.outcome);
          return;
        case 'stopped':
          // The exit follows; the supervisor's exit handler decides on a restart.
          return;
        case 'app-update-check':
          // Always answered, even when nothing changed (the page waits for the end of "checking").
          if (releaseChecker !== null) {
            void releaseChecker.check().then(sendAppUpdate, () => undefined);
          }
          return;
      }
    },
    onStateChange: (state) => {
      if (state !== 'failed') return;
      tray?.update('failed', approvals);
      if (quitting) return;
      window?.showStatus(supervisor?.failureKind ?? 'exited');
    },
  });

  /** The checks the shell can make itself before starting the core (fixed pages, no core). */
  const precheck = (): 'ai_app' | 'missing_files' | null => {
    // A UX check only: the core keeps its own guard (G-1) and refuses on its own.
    if (aiAppMarkerSet(proc.env, proc.platform)) return 'ai_app';
    if (!proc.exists(nodePath) || !proc.exists(hostScript)) return 'missing_files';
    return null;
  };
  const blocked = (kind: 'ai_app' | 'missing_files' | 'changed_files'): void => {
    tray?.update('failed', approvals);
    window?.showStatus(kind);
  };
  const launchCore = (): void => {
    if (supervisor?.state === 'failed') supervisor.retry();
    else supervisor?.start();
  };
  // D15-07: the tripwire runs before every core start (packaged release builds; a preview runs a
  // development core). While it runs the window shows the starting page.
  let verifying = false;
  const startCore = (): Promise<void> | undefined => {
    const problem = precheck();
    if (problem !== null) {
      blocked(problem);
      return undefined;
    }
    window?.showStatus('starting');
    const verify = preview === null ? proc.verifyBundle : undefined;
    if (verify === undefined) {
      launchCore();
      return undefined;
    }
    verifying = true;
    return verify()
      .catch((): 'changed' => 'changed')
      .then((result) => {
        verifying = false;
        if (quitting) return;
        if (result === 'changed') blocked('changed_files');
        else launchCore();
      });
  };
  const tryAgain = (): void => {
    if (quitting || verifying) return;
    const state = supervisor?.state;
    // Only when nothing is running (failed, or never started because of a check).
    if (state === 'failed' || state === 'idle') void startCore();
  };
  onStatusAction = (action) => {
    if (action === 'try-again') {
      tryAgain();
      return;
    }
    // Open log folder: create it first, so the file manager opens something.
    coreLog.ensureDir();
    void electron.shell.openPath(proc.logDir).catch(() => undefined);
  };
  await startCore();
  if (launch.deepLink !== null) handleDeepLink(launch.deepLink);
  if (app.isPackaged && preview === null) proc.startUpdates?.(electron);
  void releaseChecker?.start().catch(() => undefined);
  return 'running';
}

/** The real process, OS and timers. */
export function realProcess(): ShellProcess {
  const proc = process as NodeJS.Process & { resourcesPath?: string };
  return {
    argv: proc.argv,
    execArgv: proc.execArgv,
    env: proc.env,
    platform: proc.platform,
    execPath: proc.execPath,
    resourcesPath: proc.resourcesPath ?? '',
    homeDir: homedir(),
    tmpDir: tmpdir(),
    writable: (path) => {
      try {
        accessSync(path, fsConstants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    exists: (path) => existsSync(path),
    spawn: (command, args, options) =>
      nodeSpawn(command, [...args], { ...options, stdio: [...options.stdio] }),
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    },
    preview: readPreview(proc.env),
    toInviteLink,
    logDir: logDir(proc.platform, homedir(), proc.env),
    startUpdates: (electron) => startUpdates(electron, proc.platform, proc.arch),
    releaseChecker: (electron, onChange) =>
      releaseCheckerFor(
        electron,
        proc.platform,
        proc.arch,
        proc.env,
        readPreview(proc.env),
        onChange,
      ),
    instance: (app) => realInstanceOps(app, proc.platform, proc.execPath, proc.resourcesPath ?? ''),
    verifyBundle: () => {
      const resources = proc.resourcesPath ?? '';
      let record: string | null;
      try {
        // Inside app.asar (Electron reads ASAR paths; ASAR integrity covers the record).
        record = readFileSync(join(resources, 'app.asar', BUNDLE_HASHES_FILE), 'utf8');
      } catch {
        record = null;
      }
      return verifyBundle(record, bundleFilePaths(resources, proc.platform));
    },
  };
}

/** `<size>-<mtimeMs>-<ino>` of a file, or '' (D15-01 build stamp). */
function fileStamp(path: string): string {
  try {
    const s = statSync(path);
    return `${String(s.size)}-${String(Math.trunc(s.mtimeMs))}-${String(s.ino)}`;
  } catch {
    return '';
  }
}

/**
 * D15-01: the real instance record (user-data folder), lock owner (Chromium's SingletonLock link,
 * `<host>-<pid>`, macOS and Linux) and quit request. The stamp is the bundle's Info.plist on macOS
 * (outside app.asar; a replaced app has a new one) and the executable on Windows.
 */
function realInstanceOps(
  app: App,
  platform: string,
  execPath: string,
  resourcesPath: string,
): InstanceOps {
  const userData = app.getPath?.('userData') ?? '';
  const file = join(userData, INSTANCE_FILE);
  const stampOf = platform === 'darwin' ? join(resourcesPath, '..', 'Info.plist') : execPath;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  return {
    build: { version: app.getVersion?.() ?? '', execPath, stamp: fileStamp(stampOf) },
    pid: process.pid,
    read: () => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    write: (text) => writeFileSync(file, text, { mode: 0o600 }),
    remove: () => rmSync(file, { force: true }),
    lockOwner: () => {
      if (platform === 'win32' || userData === '') return null;
      try {
        const m = /-(\d{1,10})$/.exec(readlinkSync(join(userData, 'SingletonLock')));
        return m === null ? null : Number(m[1]);
      } catch {
        return null;
      }
    },
    alive,
    askToQuit: (pid) => {
      if (platform !== 'darwin') return false;
      // Only an AgentLink app executable (any copy), never another program that reused the pid.
      const ps = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      const comm = typeof ps.stdout === 'string' ? ps.stdout.trim() : '';
      if (ps.status !== 0 || relaunchTarget(comm, platform) === null) return false;
      try {
        // Electron quits normally on SIGTERM (its before-quit stops the core first).
        process.kill(pid, 'SIGTERM');
        return true;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** DESK051-UPD: "Check for updates" on the real Electron app (main process only). */
function releaseCheckerFor(
  electron: ElectronModule,
  platform: string,
  arch: string,
  env: Readonly<Record<string, string | undefined>>,
  preview: PreviewSettings | null,
  onChange: (view: AppUpdateView) => void,
): ReleaseChecker {
  const { app, net } = electron;
  const version = app.getVersion?.() ?? '0.0.0-dev';
  const stateDir = app.getPath?.('userData');
  return new ReleaseChecker({
    currentVersion: version,
    platform,
    arch,
    translated: app.runningUnderARM64Translation === true,
    enabled:
      stateDir !== undefined &&
      updateChecksAllowed({ packaged: app.isPackaged, preview: preview !== null, env }),
    stateDir: stateDir ?? '',
    // No way to tell: assume online; a failed request is then a quiet failure.
    isOnline: () => net?.isOnline() ?? true,
    timers: { setTimeout: (callback, ms) => setTimeout(callback, ms).unref() },
    onChange,
  });
}

/** WP-D10: the phase-1 updater on the real Electron app (index.ts does nothing without a pinned root). */
function startUpdates(electron: ElectronModule, platform: string, arch: string): void {
  const { app, dialog, shell } = electron;
  if (app.getVersion === undefined || app.getPath === undefined) {
    return;
  }
  const openPath = shell.openPath.bind(shell);
  scheduleUpdateChecks(
    {
      currentVersion: app.getVersion(),
      channel: 'stable',
      platform,
      arch,
      stateDir: app.getPath('userData'),
      openPath,
      showMessageBox: (options) =>
        dialog.showMessageBox({ ...options, buttons: [...options.buttons] }),
    },
    { setTimeout: (callback, ms) => setTimeout(callback, ms).unref() },
  );
}
