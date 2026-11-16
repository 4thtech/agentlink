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
//    (core-log.ts). The tray exists unless the person turned the icon off (D-155 (7), read early
//    from ui-settings.json); built-in image when the icon file is missing. TRAY-SHELL: its left
//    click toggles the popover (popover.ts; macOS and Windows), its right click pops Open / Quit;
//    tray-state, tray-pulse and shell-prefs from the pipe drive the icon.
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
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  fstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFile, spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLE_HASHES_FILE, bundleFilePaths, verifyBundle } from './bundle-check.js';
import { CoreLog, logDir } from './core-log.js';
import { checkDataFolderAcl, dataFolderFor, type AclScratch, type AclVerdict } from './data-acl.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { CoreSupervisor, aiAppMarkerSet, type SpawnFn, type Timers } from './core-process.js';
import { INVITE_RESULT_TITLE, inviteResultCopy, toInviteLink } from './deep-link.js';
import type { App, ElectronEvent, ElectronModule, WebContents } from './electron-api.js';
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
import {
  OriginLock,
  WINDOW_PARTITION,
  hardenSession,
  lockWebContents,
  popoverUrl,
  type PopoverWindowOptions,
} from './security.js';
import {
  DEEP_LINK_SCHEME,
  MAX_DEEP_LINK_CHARS,
  checkLaunch,
  commandLineIsClean,
  forwardedDeepLink,
} from './switches.js';
import type { StatusAction } from './status-page.js';
import { AppTray, BUILTIN_TRAY_PNG, trayImage } from './tray.js';
import type { TrayIndicator, TrayPulse, TrayState } from './tray-engine.js';
import { loadTrayFrames, trayFramesDir, type TrayFrames } from './tray-frames.js';
import { Popover, type PopoverWindow, type PopoverWindowConstructor } from './popover.js';
import { registerWidgetIpc, widgetPreloadPath } from './widget-ipc.js';
import { APP_USER_MODEL_ID, NativeNotifier } from './notify.js';
import { writeHealthIfPending, writeStarting } from './updater/health.js';
import { InAppUpdater, inAppEnabled } from './updater/in-app.js';
import { checkForUpdate } from './updater/index.js';
import {
  UPDATES_DIR,
  installFromProcess,
  restartForUpdate,
  sweepStaging,
} from './updater/install.js';
import {
  afterHealthyStartWin,
  installWinFromProcess,
  winInstallDirOf,
  winTools,
} from './updater/install-win.js';
import { loadFailedVersion } from './updater/state.js';
import { procTranslated, updateChannel, updaterArch } from './updater/host.js';
import { ReleaseChecker, updateChecksAllowed } from './updater/release-check.js';
import { scheduleUpdateChecks } from './updater/schedule.js';
import { MainWindow } from './window.js';
import { preloadPath, registerFolderPicker } from './folder-picker.js';
import { macArch, type AppUpdatePipeView, type AppUpdateView } from '../shared/app-update.js';
import {
  createTrayFeed,
  type HostState,
  type InviteOutcome,
  type TrayPulseKind,
  type TrayStateView,
} from '../shared/protocol.js';
import {
  keychainNoticeDialog,
  markKeychainNoticeShown,
  needsKeychainNotice,
} from './keychain-notice.js';

declare const __AGENTLINK_DESKTOP_PREVIEW__: boolean | undefined;

/** Exit code for a refused launch (any non-zero code; fixed so tests and CI can assert it). */
export const LAUNCH_REFUSED_EXIT = 64;

/**
 * WIN-DESK-1: exit code when Electron cannot resolve the app's data folder (on Windows: the
 * profile's Roaming folder is missing or broken). Without it the single-instance lock fails, and
 * the start must not be reported as "another AgentLink is running".
 */
export const PROFILE_UNAVAILABLE_EXIT = 66;

/** TRAY-SHELL: the pipe's pulse words → the engine's. */
const PULSES: Readonly<Record<TrayPulseKind, TrayPulse>> = Object.freeze({
  message_in: 'msg-in',
  ai_sent: 'msg-out',
  approval: 'approval',
});

/** TRAY-SHELL: the update states that show the icon's `update` variant (a newer version is known). */
const UPDATE_ICON_STATES: readonly string[] = Object.freeze([
  'available',
  'downloading',
  'verifying',
  'ready',
  'install_failed',
]);

/** TRAY-SHELL: the largest ui-settings.json the shell reads at launch. */
const MAX_UI_SETTINGS_FILE_BYTES = 16 * 1024;

/**
 * TRAY-SHELL (plan risk 7): the icon switch from the text of `~/.agentlink/ui-settings.json`
 * (`{"v":1,"settings":{…}}`): false when `menuBarIcon` is false, true when it is true or absent
 * (D-155 (7): on by default), undefined for anything malformed. Only this one boolean is read.
 */
export function menuBarIconFromSettings(text: string): boolean | undefined {
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined;
  const { v, settings } = record as { v?: unknown; settings?: unknown };
  if (v !== 1 || typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return undefined;
  }
  if (!Object.hasOwn(settings, 'menuBarIcon')) return true;
  const value = (settings as { menuBarIcon?: unknown }).menuBarIcon;
  return typeof value === 'boolean' ? value : undefined;
}

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
export function resourcePaths(
  resourcesPath: string,
  platform: string,
  options: { readonly darkTaskbar?: boolean | undefined } = {},
): ResourcePaths {
  const node = join(
    resourcesPath,
    ...(platform === 'win32' ? RESOURCE_LAYOUT.node.win32 : RESOURCE_LAYOUT.node.posix),
  );
  // WIN-DESK-2: Windows has one tray icon per taskbar colour (build-win.mjs, build/lib/ico.mjs); the
  // dark taskbar (the Windows 10 default) when the colour is unknown.
  const winTray =
    options.darkTaskbar === false ? 'tray-light-taskbar.ico' : 'tray-dark-taskbar.ico';
  return {
    node,
    hostScript: join(resourcesPath, ...RESOURCE_LAYOUT.hostScript),
    trayIcon: join(
      resourcesPath,
      ...RESOURCE_LAYOUT.assetsDir,
      platform === 'darwin' ? 'trayTemplate.png' : platform === 'win32' ? winTray : 'tray.png',
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
  /**
   * UPD-4: the in-app update's two signals for its watchdog (updater/health.ts): this shell started,
   * and its core is ready. Packaged release builds only. Absent: none.
   */
  readonly updateHealth?: (app: App) => {
    readonly starting: () => void;
    readonly ready: () => void;
  };
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
  /**
   * UPD-5: "Update now" / "Restart now" (updater/in-app.ts), told about every change. Absent: no
   * in-app update (the page keeps the download link).
   */
  readonly inAppUpdater?: (electron: ElectronModule, onChange: () => void) => InAppUpdaterPort;
  /** D15-01: this build's identity and the running-copy record (instance.ts). Absent: legacy lock. */
  readonly instance?: (app: App) => InstanceOps;
  /** D15-07: the startup tripwire for the bundled files (bundle-check.ts). Absent: not checked. */
  readonly verifyBundle?: () => Promise<'ok' | 'changed' | 'unchecked'>;
  /**
   * APP-CONTINUITY: before the core's first start, the one-time macOS keychain notice
   * (keychain-notice.ts) when AgentLink was set up in the browser first. Absent: none (tests).
   */
  readonly keychainNotice?: (electron: ElectronModule) => Promise<void>;
  /**
   * OD-M (WIN-DESK-2, data-acl.ts): whether the data folder's ACL lets other people on this
   * computer open it (Windows; 'ok' elsewhere). Absent: not checked.
   */
  readonly checkDataFolder?: () => Promise<AclVerdict>;
  /**
   * TRAY-SHELL (TRAY-ENGINE): the brand-mark frames (tray-frames.ts loadTrayFrames). Absent or null:
   * the single tray image.
   */
  readonly trayFrames?: (electron: ElectronModule) => TrayFrames | null;
  /**
   * TRAY-SHELL (plan risk 7): the icon switch as last saved (ui-settings.json), read once at launch
   * so a hidden icon does not flash before the core's first `shell-prefs`. Absent or undefined: on.
   */
  readonly menuBarIconPref?: () => boolean | undefined;
}

/** UPD-5: what the shell uses of updater/in-app.ts InAppUpdater. */
export interface InAppUpdaterPort {
  view(base: AppUpdateView): AppUpdatePipeView;
  check(): Promise<void>;
  install(): boolean;
  restart(): boolean;
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

  // WIN-DESK-1: the lock lives in the data folder. When Electron cannot resolve it, getPath
  // throws and the lock would fail for that reason alone: say so (fixed line), never "another
  // AgentLink is running". Nothing from the error is kept. WIN-DESK-2: this is the first thing that
  // asks for an app path (the update watchdog below asks for it too), so it runs before them.
  // When the profile is so broken that Electron exits during its own native start (no shell code
  // runs at all; the Windows smoke shows this for a profile without AppData\Roaming), this line
  // cannot be written: the start ends with Electron's own exit code and no log line.
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

  // UPD-4 (IR-UPD-4-1 #2): the update watchdog's start signal comes first, before the lock, whenReady
  // and any dialog, so a new copy that hangs later can still be found and stopped.
  const updateHealth = app.isPackaged && preview === null ? proc.updateHealth?.(app) : undefined;
  updateHealth?.starting();

  // 2. Sandbox for every renderer; one instance.
  app.enableSandbox();
  // N7 (R-WIN): Windows attributes toasts to this ID (the installer's Start menu shortcut).
  if (proc.platform === 'win32') {
    try {
      app.setAppUserModelId?.(APP_USER_MODEL_ID);
    } catch {
      // Without it Windows shows no toast; nothing else depends on it.
    }
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
  let notifier: NativeNotifier | null = null;
  let pendingInvite: string | null = null;
  // TRAY-SHELL (D-155): the menu bar icon, the popover and the icon switch. The core's tray-state,
  // tray-pulse and shell-prefs (fixed words, counts, booleans) drive them; the update variant is the
  // shell's own release check. Nothing here holds text, a name or an ID.
  let popover: Popover | null = null;
  let lastTray: TrayStateView | null = null;
  let hostState: HostState | 'failed' = 'starting';
  let approvals = 0;
  let updateReady = false;
  let coreBlocked = false;
  // C1 (owner): opening the popover clears the ring until more messages come in (the per-contact
  // counts stay until that chat is opened).
  let ringCleared = false;
  let unreadAtClear = 0;
  let appMotion = true;
  let menuBarIcon = true;
  try {
    menuBarIcon = proc.menuBarIconPref?.() !== false;
  } catch {
    menuBarIcon = true;
  }
  let reapplyTimer: unknown = null;
  const unreadShown = (): boolean => {
    const unread = lastTray?.unread ?? 0;
    if (unread === 0) {
      ringCleared = false;
      return false;
    }
    if (ringCleared && unread <= unreadAtClear) return false;
    ringCleared = false;
    return true;
  };
  const coreDown = (): boolean => coreBlocked || supervisor?.state === 'failed';
  const indicator = (): TrayIndicator => {
    const down = coreDown();
    const link = down ? 'offline' : (lastTray?.link ?? 'connecting');
    const state: TrayState =
      link === 'offline' || link === 'paused' ? link : updateReady ? 'update' : link;
    return {
      state,
      unread: !down && unreadShown(),
      approvals: !down && (lastTray?.approvals ?? 0) > 0,
    };
  };
  /** The full state again (after a pulse, a new tray, a new core or an update change). */
  const applyIndicator = (): void => {
    tray?.setIndicator(indicator());
  };
  const setTooltip = (state: HostState | 'failed'): void => {
    hostState = state;
    tray?.update(state, approvals);
  };
  const toInviteLink = proc.toInviteLink ?? ((): null => null);
  // DESK051-UPD: the update state goes to the core (Settings > Updates) after every `ready` and on
  // every change; the core can only ask for a check.
  // UPD-5: the in-app update's view goes on top of the release check's (installable, percent).
  let inApp: InAppUpdaterPort | null = null;
  let releaseChecker: ReleaseChecker | null = null;
  const sendAppUpdate = (view: AppUpdateView): void => {
    const full: AppUpdatePipeView =
      inApp === null ? { ...view, installable: false, percent: 0 } : inApp.view(view);
    const ready = UPDATE_ICON_STATES.includes(full.state);
    if (ready !== updateReady) {
      updateReady = ready;
      applyIndicator();
    }
    try {
      supervisor?.send({ v: 1, type: 'app-update', ...full });
    } catch {
      // An invalid view is never sent (the encoder checks it again).
    }
  };
  releaseChecker = proc.releaseChecker?.(electron, sendAppUpdate) ?? null;
  inApp =
    proc.inAppUpdater?.(electron, () => {
      if (releaseChecker !== null) sendAppUpdate(releaseChecker.view());
    }) ?? null;

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
    popover?.hide();
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
    if (reapplyTimer !== null) proc.timers.clearTimeout(reapplyTimer);
    reapplyTimer = null;
    const stop = supervisor?.stop() ?? Promise.resolve();
    void stop.then(() => {
      notifier?.dispose();
      removeRecord();
      popover?.destroy();
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

  // TRAY-SHELL: the popover (macOS and Windows; Linux keeps the native tray menu). Its window is
  // created on the first click; its web contents are named to the session's backstop below.
  const screen = electron.screen;
  if ((proc.platform === 'darwin' || proc.platform === 'win32') && screen !== undefined) {
    // A plain function (called with `new`, it yields the object it returns), so the shell wires its
    // own listeners before the popover adds its own.
    const popoverWindow = function (options: PopoverWindowOptions): PopoverWindow {
      const created = new electron.BrowserWindow(options);
      const wired = wirePopoverContents(created.webContents);
      // IR-TRAY-SHELL L2: a cancelled load may end in a rejected loadURL only (popover.ts swallows
      // it); the shell sees the rejection too.
      const load = created.loadURL;
      created.loadURL = (url: string): Promise<void> => {
        const loading = load.call(created, url);
        loading.catch(() => wired.loadFailed());
        return loading;
      };
      return created;
    };
    popover = new Popover({
      BrowserWindow: popoverWindow as unknown as PopoverWindowConstructor,
      shell: electron.shell,
      lock,
      platform: proc.platform,
      preload: electron.ipcMain === undefined ? undefined : widgetPreloadPath(),
      screen,
      trayBounds: () => tray?.getBounds() ?? null,
      // The fixed page's Open AgentLink: the main window with a fresh session link (the popover
      // follows that link: setSessionReady below).
      openMain: () => {
        window?.show();
        supervisor?.send({ v: 1, type: 'show', route: 'home' });
      },
      quitting: () => quitting,
    });
  }
  /**
   * TRAY-SHELL: the shell's own listeners on the popover's web contents (added before the popover's):
   * - a redirect away from the widget is blocked (popover.ts pins it), which cancels the load: the
   *   session is not usable, so the fixed page until a new session link. The end of that load is
   *   taken from whichever comes: did-fail-load, did-fail-provisional-load or the loadURL rejection;
   * - every Cmd / Ctrl combination is swallowed, so the default menu's accelerators (reload, zoom,
   *   close, …) never act in the popover; only Cmd+Q on macOS, exactly, quits (the widget's footer
   *   shows that hint, and the popover has focus).
   */
  function wirePopoverContents(contents: WebContents): { loadFailed: () => void } {
    let redirectBlocked = false;
    const loadFailed = (): void => {
      const blocked = redirectBlocked;
      redirectBlocked = false;
      if (blocked && popover?.page === 'widget') popover.setSessionReady(false);
    };
    const isWidget = (url: string): boolean => {
      const widget = popoverUrl(lock);
      const hash = url.indexOf('#');
      return widget !== null && (hash === -1 ? url : url.slice(0, hash)) === widget;
    };
    contents.on('will-redirect', (_event, url) => {
      redirectBlocked = !isWidget(url);
    });
    contents.on('did-navigate', () => {
      redirectBlocked = false;
    });
    // Any other failure: popover.ts shows the fixed page itself (and tries the widget again on the
    // next show). A failure without a blocked redirect (ERR_ABORTED: a newer load replaced this one)
    // changes nothing here.
    const onFail = (
      _event: ElectronEvent,
      _code: number,
      _description: string,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame) loadFailed();
    };
    contents.on('did-fail-load', onFail);
    contents.on('did-fail-provisional-load', onFail);
    contents.on('before-input-event', (event, input) => {
      if (input.meta !== true && input.control !== true) return;
      event.preventDefault();
      if (
        proc.platform === 'darwin' &&
        input.type === 'keyDown' &&
        input.meta === true &&
        input.control !== true &&
        input.alt !== true &&
        input.shift !== true &&
        typeof input.key === 'string' &&
        input.key.toLowerCase() === 'q'
      ) {
        app.quit();
      }
    });
    return { loadFailed };
  }

  const windowSession = electron.session.fromPartition(WINDOW_PARTITION, { cache: false });
  // DESK-TOUCHID-FIX: before a request that starts the presence helper reaches the core, focus
  // leaves the page (secure input off), so the Touch ID sheet can become key.
  await hardenSession(
    windowSession,
    lock,
    proc.platform,
    () => {
      window?.blurPage();
    },
    // TRAY-SHELL: the popover's requests outside the read-only allowlist are cancelled.
    (id) => popover?.ownsWebContents(id) === true,
  );

  // Set below, once the supervisor and the checks exist.
  let onStatusAction: (action: StatusAction) => void = () => undefined;
  window = new MainWindow({
    BrowserWindow: electron.BrowserWindow,
    shell: electron.shell,
    lock,
    platform: proc.platform,
    quitting: () => quitting,
    onStatusAction: (action) => onStatusAction(action),
    // TRAY-SHELL: the popover never stays up over the main window.
    onShown: () => popover?.hide(),
    // D-155 (7): with the icon hidden the only way back is the Dock (macOS); elsewhere a close
    // quits while it is hidden.
    quitOnClose: () => proc.platform !== 'darwin' && tray === null,
    quit: () => app.quit(),
    // FILES-FOLDER-PICKER: the picker exists only with both the IPC module and the bundled preload.
    ...(electron.ipcMain === undefined || electron.dialog.showOpenDialog === undefined
      ? {}
      : { preload: preloadPath() }),
  });
  if (electron.ipcMain !== undefined) {
    registerFolderPicker(electron.ipcMain, {
      lock,
      sessionWindow: () => window?.sessionWindow ?? null,
      dialog: electron.dialog,
      platform: proc.platform,
    });
  }
  // TRAY-SHELL: the popover's one IPC channel (widget-ipc.ts checks the sender and the input).
  if (electron.ipcMain !== undefined && popover !== null) {
    const widget = popover;
    registerWidgetIpc(electron.ipcMain, {
      lock,
      widgetContentsId: () => widget.widgetContentsId(),
      // The existing `show`: the main window on that page (the core mints its link).
      openPage: (route, target) => {
        window?.show();
        supervisor?.send({
          v: 1,
          type: 'show',
          route,
          ...(target === undefined ? {} : { target }),
        });
      },
      quit: () => app.quit(),
      close: () => widget.hide(),
    });
  }
  // The window comes up at once: the person sees AgentLink starting, never nothing.
  window.showStatus('starting');

  const paths = resourcePaths(proc.resourcesPath, proc.platform, {
    darkTaskbar: electron.nativeTheme?.shouldUseDarkColorsForSystemIntegratedUI,
  });
  let nodePath = paths.node;
  let hostScript = paths.hostScript;
  if (preview !== null) {
    // Preview only: run the core from a development checkout.
    nodePath = preview.node ?? nodePath;
    hostScript = preview.hostScript ?? hostScript;
  }

  // A tray unless the person turned the icon off (D-155 (7)); it is the way back after the window
  // is closed (macOS also keeps the Dock; elsewhere a close quits while it is off). Built-in image
  // as a fallback.
  const icon = proc.exists(paths.trayIcon) ? paths.trayIcon : '';
  let frames: TrayFrames | null = null;
  try {
    frames = proc.trayFrames?.(electron) ?? null;
  } catch {
    frames = null;
  }
  // The longest a pulse (and one queued behind it) can play before the icon settles.
  const settleMs = ((): number => {
    if (frames === null) return 0;
    const sequences = frames.sequences;
    const longest = Math.max(
      ...(['msg-in', 'msg-out', 'approval'] as const).map(
        (kind) => sequences[kind].frames.length * sequences[kind].frameMs,
      ),
    );
    return Number.isFinite(longest) ? 2 * longest + 100 : 0;
  })();
  const onTrayClick = (): void => {
    // With the core failed, the main window's status page (Try again lives there).
    if (coreDown()) {
      showWindow();
      return;
    }
    popover?.toggle();
    if (popover?.visible === true) {
      ringCleared = true;
      unreadAtClear = lastTray?.unread ?? 0;
      tray?.clearUnread();
    }
  };
  const createTray = (): void => {
    if (tray !== null || quitting) return;
    tray = new AppTray(
      electron,
      trayImage(electron.nativeImage, icon, proc.platform),
      popover === null
        ? { open: showWindow, retry: () => tryAgain(), quit: () => app.quit() }
        : { open: showWindow, quit: () => app.quit(), click: onTrayClick },
      {
        frames,
        system: {
          ...(electron.nativeTheme === undefined ? {} : { nativeTheme: electron.nativeTheme }),
          ...(electron.systemPreferences === undefined
            ? {}
            : { systemPreferences: electron.systemPreferences }),
        },
        timers: proc.timers,
        platform: proc.platform,
        appMotion,
        initial: indicator(),
      },
    );
    tray.update(hostState, approvals);
    applyIndicator();
  };
  const setMenuBarIcon = (on: boolean): void => {
    menuBarIcon = on;
    if (on) {
      createTray();
      return;
    }
    popover?.hide();
    popover?.destroy();
    if (reapplyTimer !== null) proc.timers.clearTimeout(reapplyTimer);
    reapplyTimer = null;
    tray?.destroy();
    tray = null;
    // IR-TRAY-SHELL L3: without the icon (and without a Dock), a hidden window would leave
    // AgentLink running with no way back: bring the window up (a close then quits).
    if (proc.platform !== 'darwin' && window?.visible !== true && !quitting) showWindow();
  };
  const feed = createTrayFeed(
    {
      onState: (view) => {
        lastTray = view;
        applyIndicator();
      },
      onPulse: (kind) => {
        if (kind === 'message_in') ringCleared = false;
        tray?.pulse(PULSES[kind]);
        // IR-TRAY-ENGINE L3: the engine's pulse sets its own unread / approvals marks; the core's
        // last full state decides where the icon settles (now, and again once the pulse ended).
        applyIndicator();
        if (tray === null || settleMs === 0) return;
        if (reapplyTimer !== null) proc.timers.clearTimeout(reapplyTimer);
        reapplyTimer = proc.timers.setTimeout(() => {
          reapplyTimer = null;
          applyIndicator();
        }, settleMs);
      },
      onPrefs: (prefs) => {
        appMotion = prefs.motion !== 'off';
        tray?.setAppMotion(appMotion);
        if (prefs.menuBarIcon !== menuBarIcon || (prefs.menuBarIcon && tray === null)) {
          setMenuBarIcon(prefs.menuBarIcon);
        }
      },
    },
    { now: () => proc.timers.now() },
  );
  if (menuBarIcon) createTray();

  // N7: the dock badge is the number of approvals waiting (never unread messages).
  let badge: number | undefined;
  const setBadge = (count: number): void => {
    if (badge === count) return;
    badge = count;
    try {
      app.setBadgeCount?.(count);
    } catch {
      // Best effort (an OS without a badge).
    }
  };
  // N7: native notifications from the core's fixed codes; a click focuses the window and opens the
  // kind's fixed route (a `show` enum, a fresh one-shot link from the core).
  notifier = new NativeNotifier({
    ...(electron.Notification === undefined ? {} : { Notification: electron.Notification }),
    timers: proc.timers,
    windowFocused: () => window?.focused === true,
    onClick: (route, target) => {
      window?.show();
      supervisor?.send({ v: 1, type: 'show', route, ...(target === undefined ? {} : { target }) });
    },
  });
  // WIN-ACL-NOTICE: the last data folder check could not run; the core shows a notice in the app.
  let dataFolderUnchecked = false;
  supervisor = new CoreSupervisor({
    nodePath,
    hostScript,
    cwd: proc.homeDir,
    env: proc.env,
    platform: proc.platform,
    dataFolderUnchecked: () => dataFolderUnchecked,
    spawn: proc.spawn,
    timers: proc.timers,
    onStart: () => {
      coreLog.note('core started');
      window?.resetForNewCore();
      // TRAY-SHELL: a new core: its tray messages start afresh; the popover waits for its session.
      feed.reset();
      lastTray = null;
      ringCleared = false;
      popover?.setSessionReady(false);
      applyIndicator();
      // The old page's server is gone: show the starting page until the new core is ready.
      if (window?.page === 'session') window.showStatus('starting');
    },
    onStderr: (chunk) => coreLog.write(chunk),
    onExit: (code, signal) => {
      coreLog.flush();
      const how =
        signal !== null ? `signal ${signal.replace(/[^A-Z0-9]/g, '')}` : `code ${String(code)}`;
      coreLog.note(`core exited (${how})`);
      popover?.setSessionReady(false);
      // D15-12: the session page's server is gone; never leave that page up while nothing (or
      // something else) answers on its port until the next start.
      if (!quitting && window?.page === 'session') window.showStatus('starting');
    },
    onMessage: (message) => {
      // TRAY-SHELL: tray-state, tray-pulse and shell-prefs.
      if (feed.handle(message)) return;
      switch (message.type) {
        case 'ready':
          // WIN-DESK-1: proof the pipe works both ways (fixed text, never the link).
          coreLog.note('core ready');
          updateHealth?.ready();
          if (releaseChecker !== null) sendAppUpdate(releaseChecker.view());
          // TRAY-SHELL: once the main window has this core's session, the popover loads the widget.
          if (
            window?.loadSessionUrl(message.sessionUrl, () => popover?.setSessionReady(true)) ===
            true
          ) {
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
          setTooltip(message.state);
          setBadge(approvals);
          return;
        case 'approval-waiting':
          // The tray and the dock badge show the number; N7's `notify` raises the notification.
          approvals = message.count;
          setBadge(approvals);
          return;
        case 'notify':
          notifier?.handle(message);
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
            const checker = releaseChecker;
            void Promise.all([checker.check(), inApp?.check()]).then(
              () => sendAppUpdate(checker.view()),
              () => undefined,
            );
          }
          return;
        case 'app-update-install':
          // UPD-5: only the update this shell verified itself; its state follows on every change.
          inApp?.install();
          return;
        case 'app-update-restart':
          inApp?.restart();
          return;
      }
    },
    onStateChange: (state) => {
      if (state !== 'failed') return;
      setTooltip('failed');
      popover?.setSessionReady(false);
      applyIndicator();
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
  const blocked = (
    kind: 'ai_app' | 'missing_files' | 'changed_files' | 'shared_data_folder',
  ): void => {
    coreBlocked = true;
    setTooltip('failed');
    popover?.setSessionReady(false);
    applyIndicator();
    window?.showStatus(kind);
  };
  const launchCore = (): void => {
    coreBlocked = false;
    if (supervisor?.state === 'failed') supervisor.retry();
    else supervisor?.start();
  };
  // D15-07: the tripwire runs before every core start (packaged release builds; a preview runs a
  // development core). OD-M: then, on Windows, the data folder's ACL. While they run the window
  // shows the starting page.
  let verifying = false;
  const startCore = (): Promise<void> | undefined => {
    const problem = precheck();
    if (problem !== null) {
      blocked(problem);
      return undefined;
    }
    window?.showStatus('starting');
    const verify = preview === null ? proc.verifyBundle : undefined;
    const checkFolder = proc.checkDataFolder;
    if (verify === undefined && checkFolder === undefined) {
      launchCore();
      return undefined;
    }
    verifying = true;
    return (async (): Promise<void> => {
      const bundle = verify === undefined ? 'ok' : await verify().catch((): 'changed' => 'changed');
      // A check that fails to run is 'unchecked' (data-acl.ts): it does not stop the start.
      const folder =
        bundle === 'changed' || checkFolder === undefined
          ? 'ok'
          : await checkFolder().catch((): 'unchecked' => 'unchecked');
      verifying = false;
      dataFolderUnchecked = folder === 'unchecked';
      if (quitting) return;
      if (bundle === 'changed') blocked('changed_files');
      else if (folder === 'too_open') blocked('shared_data_folder');
      else {
        // OD-M: a check that could not run still starts (Fable rules), with one fixed line.
        if (folder === 'unchecked') coreLog.note('data folder access could not be checked');
        launchCore();
      }
    })();
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
  // APP-CONTINUITY: say what the macOS keychain dialog will ask before the core first reads it.
  await proc.keychainNotice?.(electron).catch(() => undefined);
  await startCore();
  if (launch.deepLink !== null) handleDeepLink(launch.deepLink);
  if (app.isPackaged && preview === null) proc.startUpdates?.(electron);
  void releaseChecker?.start().catch(() => undefined);
  void inApp?.check();
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
    // UPD-5: on a Mac the in-app update replaces the phase-1 installer dialog. WIN-INAPP-UPDATE: on
    // Windows too, whenever this copy can update itself (the per-user install folder).
    startUpdates: (electron) => {
      if (proc.platform === 'darwin') return;
      if (proc.platform === 'win32' && inAppEnabledFor(electron, proc)) return;
      startUpdates(electron, proc.platform, proc.arch);
    },
    inAppUpdater: (electron, onChange) => inAppUpdaterFor(electron, proc, onChange),
    keychainNotice: async (electron) => {
      const stateDir = electron.app.getPath?.('userData') ?? '';
      const input = {
        platform: proc.platform,
        homeDir: homedir(),
        stateDir,
        exists: (path: string) => existsSync(path),
      };
      if (!needsKeychainNotice(input)) return;
      await electron.dialog.showMessageBox(keychainNoticeDialog());
      markKeychainNoticeShown(stateDir);
    },
    updateHealth: (app) => {
      const dir = app.getPath?.('userData');
      const version = app.getVersion?.();
      // UPD-4 on a Mac; WIN-INAPP-UPDATE on Windows (the watchdog waits for the same records).
      const inPlace = proc.platform === 'darwin' || proc.platform === 'win32';
      const write = (fn: typeof writeStarting): void => {
        if (!inPlace || dir === undefined || version === undefined) return;
        // Public data only (a version and a pid); a failed write just means no in-app update.
        fn(dir, version, proc.pid).catch(() => undefined);
      };
      return {
        starting: () => write(writeStarting),
        ready: () => {
          write(writeHealthIfPending);
          if (inPlace && dir !== undefined) void sweepStaging(join(dir, UPDATES_DIR), Date.now());
          // WIN-INAPP-UPDATE (IR Fable r1): this copy is in place for good; its RunOnce recovery
          // entry and left-over folders beside the install folder go.
          const installDir = winInstallDirOf(proc.execPath, proc.env['LOCALAPPDATA']);
          const tools = winTools(proc.env['SystemRoot']);
          if (
            proc.platform === 'win32' &&
            app.isPackaged &&
            dir !== undefined &&
            version !== undefined &&
            installDir !== null &&
            tools !== null
          )
            void afterHealthyStartWin({
              stateDir: dir,
              installDir,
              version,
              reg: tools.reg,
              run: (command, args) =>
                new Promise<void>((resolve) => {
                  execFile(command, [...args], { timeout: 15_000, windowsHide: true }, () =>
                    resolve(),
                  );
                }),
            });
        },
      };
    },
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
    trayFrames: (electron) =>
      loadTrayFrames({
        dir: trayFramesDir(proc.resourcesPath ?? ''),
        platform: proc.platform,
        nativeImage: electron.nativeImage,
        fallback: () => electron.nativeImage.createFromBuffer(BUILTIN_TRAY_PNG, { scaleFactor: 2 }),
      }),
    menuBarIconPref: () => readMenuBarIconPref(join(homedir(), '.agentlink', 'ui-settings.json')),
    checkDataFolder: () =>
      checkDataFolderAcl(
        proc.platform,
        dataFolderFor(homedir(), proc.platform, existsSync),
        proc.env,
        { run: runQuiet, scratch: aclScratch },
      ),
  };
}

/**
 * TRAY-SHELL (plan risk 7): the icon switch as last saved, or undefined. A small regular file only
 * (never a link), read once at launch; it holds the app's own UI booleans (nothing secret).
 */
export function readMenuBarIconPref(
  path: string,
  platform: NodeJS.Platform = process.platform,
  lstat: (p: string) => { isSymbolicLink(): boolean } = lstatSync,
): boolean | undefined {
  let fd: number | null = null;
  try {
    // No lstat before the open (a check-then-open race): O_NOFOLLOW refuses a link at the open, and
    // the descriptor's own fstat below confirms a regular file of a small size.
    fd = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_UI_SETTINGS_FILE_BYTES) return undefined;
    // Windows has no O_NOFOLLOW: refuse a link here, after the open (a check after the open, so
    // there is no check-then-open gap on the path that was opened).
    if (platform === 'win32' && lstat(path).isSymbolicLink()) return undefined;
    return menuBarIconFromSettings(readFileSync(fd, 'utf8'));
  } catch {
    return undefined;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best effort.
      }
    }
  }
}

/** OD-M: runs a System32 tool without a shell, window or inherited environment; stdout only. */
function runQuiet(
  file: string,
  args: readonly string[],
  env: Record<string, string>,
  ms: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { env, windowsHide: true, timeout: ms, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error !== null) reject(new Error('check failed'));
        else resolve(stdout);
      },
    );
    // A tool that reads its input would wait for a pipe to end: close it at once.
    child.stdin?.end();
  });
}

/** OD-M: a new private folder in this user's temp folder for icacls's output; removed after. */
async function aclScratch(): Promise<AclScratch> {
  const dir = await mkdtemp(join(tmpdir(), 'agentlink-acl-'));
  return {
    dir,
    read: (name) => readFile(join(dir, name)),
    dispose: () => rm(dir, { recursive: true, force: true }),
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

/** UPD-5: the in-app update on the real Electron app (off while root-key.json is the placeholder). */
function inAppUpdaterFor(
  electron: ElectronModule,
  proc: NodeJS.Process,
  onChange: () => void,
): InAppUpdater {
  const { app } = electron;
  const version = app.getVersion?.() ?? '0.0.0-dev';
  const stateDir = app.getPath?.('userData');
  const translated = proc.platform === 'darwin' && translatedNow();
  const arch = macArch(proc.arch, translated) ?? 'arm64';
  const windows = proc.platform === 'win32';
  const enabled = inAppEnabledFor(electron, proc);
  return new InAppUpdater({
    enabled,
    currentVersion: version,
    arch,
    platform: proc.platform,
    check: async () =>
      (
        await checkForUpdate({
          currentVersion: version,
          channel: updateChannel(version),
          platform: proc.platform,
          arch: updaterArch(proc.platform, proc.arch, translated),
          stateDir: stateDir ?? '',
          // WIN-INAPP-UPDATE: the Windows app runs the signed NSIS setup; a Mac swaps in the zip.
          kind: windows ? 'nsis' : 'zip',
        })
      ).accepted,
    failedVersion: () => loadFailedVersion(stateDir ?? ''),
    install: (accepted, hooks) =>
      restartForUpdate(
        () => {
          const common = {
            accepted,
            stateDir: stateDir ?? '',
            execPath: proc.execPath,
            pid: proc.pid,
            onProgress: (done: number, total: number) => hooks.onProgress(done, total),
            onVerifying: () => hooks.onVerifying(),
            confirmRestart: () => hooks.confirmRestart(),
          };
          return windows
            ? installWinFromProcess({ ...common, env: proc.env })
            : installFromProcess(common);
        },
        () => app.quit(),
      ),
    onChange,
  });
}

/** UPD-5 / WIN-INAPP-UPDATE: whether this copy may update itself in place (in-app.ts). */
function inAppEnabledFor(electron: ElectronModule, proc: NodeJS.Process): boolean {
  const { app } = electron;
  return (
    app.getPath?.('userData') !== undefined &&
    inAppEnabled({
      platform: proc.platform,
      packaged: app.isPackaged,
      preview: readPreview(proc.env) !== null,
      execPath: proc.execPath,
      localAppData: proc.env['LOCALAPPDATA'],
    })
  );
}

/** Rosetta check through sysctl.proc_translated (fixed program, fixed arguments). */
function translatedNow(): boolean {
  return procTranslated((command, args) => {
    const result = spawnSync(command, [...args], { encoding: 'utf8', timeout: 2000 });
    if (result.status !== 0 || typeof result.stdout !== 'string') throw new Error('sysctl');
    return result.stdout;
  });
}

/** WP-D10: the phase-1 updater on the real Electron app (index.ts does nothing without a pinned root). */
function startUpdates(electron: ElectronModule, platform: string, arch: string): void {
  const { app, dialog, shell } = electron;
  if (app.getVersion === undefined || app.getPath === undefined) {
    return;
  }
  const openPath = shell.openPath.bind(shell);
  const version = app.getVersion();
  // UPD-1: the build's channel (not a hard-coded `stable`) and the Mac's real arch, Rosetta-aware
  // through sysctl.proc_translated (fixed program, fixed arguments), not the raw process.arch.
  const translated =
    platform === 'darwin' &&
    procTranslated((command, args) => {
      const result = spawnSync(command, [...args], { encoding: 'utf8', timeout: 2000 });
      if (result.status !== 0 || typeof result.stdout !== 'string') throw new Error('sysctl');
      return result.stdout;
    });
  scheduleUpdateChecks(
    {
      currentVersion: version,
      channel: updateChannel(version),
      platform,
      arch: updaterArch(platform, arch, translated),
      stateDir: app.getPath('userData'),
      openPath,
      showMessageBox: (options) =>
        dialog.showMessageBox({ ...options, buttons: [...options.buttons] }),
    },
    { setTimeout: (callback, ms) => setTimeout(callback, ms).unref() },
  );
}
