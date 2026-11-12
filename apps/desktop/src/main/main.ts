// The desktop shell's Electron main process (plan 2026-11-12 Decisions 2 and 3, WP-D2).
//
// Order matters:
// 1. The launch lockdown (switches.ts) runs first: a forbidden switch, Node option or environment
//    variable → exit LAUNCH_REFUSED_EXIT before the single-instance lock, any window or the core.
// 2. The sandbox is enabled for every renderer; one instance only. A second launch forwards only its
//    already-checked deep link (single-instance additionalData), never its raw argv.
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
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreLog, logDir } from './core-log.js';
import { CoreSupervisor, aiAppMarkerSet, type SpawnFn, type Timers } from './core-process.js';
import { INVITE_RESULT_TITLE, inviteResultCopy, toInviteLink } from './deep-link.js';
import type { ElectronModule } from './electron-api.js';
import { ensureGoodLocation } from './move.js';
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
import { scheduleUpdateChecks } from './updater/schedule.js';
import { MainWindow } from './window.js';
import type { InviteOutcome } from '../shared/protocol.js';

declare const __AGENTLINK_DESKTOP_PREVIEW__: boolean | undefined;

/** Exit code for a refused launch (any non-zero code; fixed so tests and CI can assert it). */
export const LAUNCH_REFUSED_EXIT = 64;

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
}

export type ShellOutcome = 'refused' | 'second-instance' | 'location' | 'running';

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

  // 2. Sandbox for every renderer; one instance.
  app.enableSandbox();
  if (!app.requestSingleInstanceLock({ deepLink: launch.deepLink })) {
    app.exit(0);
    return 'second-instance';
  }

  const lock = new OriginLock();
  let quitting = false;
  let supervisor: CoreSupervisor | null = null;
  let window: MainWindow | null = null;
  let tray: AppTray | null = null;
  let pendingInvite: string | null = null;
  const toInviteLink = proc.toInviteLink ?? ((): null => null);

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

  app.on('web-contents-created', (_event, contents) =>
    lockWebContents(contents, lock, electron.shell),
  );
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    const link = forwardedDeepLink(additionalData);
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
      tray?.destroy();
      window?.destroy();
      app.quit();
    });
  });

  await app.whenReady();

  // 3. Location (packaged builds; a development run starts from the repository).
  if (app.isPackaged) {
    const outcome = await ensureGoodLocation(
      {
        platform: proc.platform,
        execPath: proc.execPath,
        tmpDir: proc.tmpDir,
        writable: proc.writable,
      },
      app,
      electron.dialog,
    );
    if (outcome !== 'ok') {
      quitting = true;
      app.exit(0);
      return 'location';
    }
  }

  const windowSession = electron.session.fromPartition(WINDOW_PARTITION, { cache: false });
  await hardenSession(windowSession, lock, proc.platform);

  const coreLog = new CoreLog({ dir: proc.logDir });
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
    },
    onMessage: (message) => {
      switch (message.type) {
        case 'ready':
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
  const startCore = (): void => {
    const blocked = precheck();
    if (blocked !== null) {
      tray?.update('failed', approvals);
      window?.showStatus(blocked);
      return;
    }
    window?.showStatus('starting');
    if (supervisor?.state === 'failed') supervisor.retry();
    else supervisor?.start();
  };
  const tryAgain = (): void => {
    if (quitting) return;
    const state = supervisor?.state;
    // Only when nothing is running (failed, or never started because of a check).
    if (state === 'failed' || state === 'idle') startCore();
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
  startCore();
  if (launch.deepLink !== null) handleDeepLink(launch.deepLink);
  if (app.isPackaged && preview === null) proc.startUpdates?.(electron);
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
  };
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
