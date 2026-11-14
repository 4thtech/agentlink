// U3-f (S2; D-138, U3-spec-04; 04 §2.5 "Writing AI app configs"; 06 §7 "The app as a second path";
// 08 §1 "Entry-only config display"; proposed, owner confirms at merge): the harness seam the CLI
// passes to the local app (`LocalUiOptions.aiApps`), so packages/node has no second config writer.
//
// - Paths come only from the fixed harness table (harnesses.ts configLocation; never `--config`,
//   never a path from the page). Every read and write goes through files.ts: realpath, no link at
//   any level, a regular file with one name owned by this user, at most MAX_CONFIG_BYTES; the write
//   is a fresh temporary file renamed into place, after a backup that keeps the original file mode.
// - Entry-only (entry.ts): the list and the plan carry only the `agentlink` entry, and only when it
//   is exactly AgentLink's for a valid agent name; a foreign entry is a conflict with nothing of it
//   shown. The file's bytes stay inside the plan's `commit` closure: never a field, an error or a
//   log line (I-7). Log lines are fixed text.
// - Fixed content: `npx -y @4thtech-io/agentlink mcp` plus `--agent <name>` (06 §7). Before a write
//   the agent folder the entry runs is read again and must record the agentId the owner signed for.
// - The file's identity (device and inode) is taken when the plan is made and checked again by the
//   write together with the bytes (files.ts `changed`).
// - Claude Desktop rewrites its file on exit: while it runs (best effort, checked when listing,
//   planning and again right before the write) nothing is written for it. It is never closed here.
//
// - WP-D7 (plan 2026-11-12 Decision 2 "AI apps", "Translocation (M3)"): the desktop app's form
//   (`<bundled node> <bundled cli> mcp …`, desktop-app.ts) is recognised next to the npx form, and
//   "Use the app for …" (`{form: 'app'}`) plans a `switch` of the same agent's entry to it. A move or
//   disconnect keeps the entry's form. The app is located when the plan is made and again right
//   before the write; a translocated, temporary or read-only location is never written
//   (`app_location`). Optionally the installer's `agentlink` launcher is pointed at the app too
//   (launcher.ts), only when it is exactly the installer's own file.
// - APP-CONTINUITY (08 §1 "One AgentLink, browser or app"): inside the desktop app a new connect
//   is the app form (when the app may be written), so an app-only computer needs no Node or npx; a
//   move keeps the entry's form, so entries made from the browser keep working unchanged.
//
// Threat note (04 §2.5): an entry starts a program, so this is a code-execution path. The fixed
// content, the fixed paths and the owner's signed gesture (node local-ui/api/apps.ts) are what stop
// the local app page from rewiring AI apps; a same-user process can edit these files anyway (G-1,
// 06 §7: transparency, not a boundary).
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import type {
  LocalUiAiAppEntryState,
  LocalUiAiAppPlan,
  LocalUiAiAppPlanRequest,
  LocalUiAiApps,
  LocalUiAiAppView,
  LocalUiAiAppWrite,
  LocalUiLauncherChange,
} from '@4thtech-io/node';
import type { JsonObject } from '@4thtech-io/crypto';
import { readAgentConfig } from '../runtime/agent-dir.js';
import { isAgentName } from '../runtime/agent-name.js';
import {
  locateDesktopApp,
  resourcesOfExecPath,
  type AppStart,
  type DesktopApp,
} from './desktop-app.js';
import {
  entryOf,
  readEntryState,
  removeEntry,
  setEntry,
  type EntryForm,
  type EntryState,
} from './entry.js';
import { HarnessError } from './errors.js';
import { appLauncherText, launcherDisplay, launcherParts, readLauncher } from './launcher.js';
import { readConfigFile, writeConfigFile, type ConfigFile } from './files.js';
import {
  configLocation,
  detectHarnesses,
  harnessById,
  isHarnessId,
  type HarnessContext,
  type HarnessDef,
} from './harnesses.js';

export interface AiAppsDeskOptions {
  readonly home: string;
  /** The environment of this process (Windsurf's own XDG_CONFIG_HOME / APPDATA, CLAUDE_CONFIG_DIR). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** Who must own the folders and files (files.ts). Default: this process's user. */
  readonly uid?: number;
  /** Unix seconds, for the backup's name. */
  readonly now?: () => number;
  /** Claude Desktop runs now (best effort; default: the OS process list, claudeDesktopRunning). */
  readonly desktopRunning?: () => Promise<boolean>;
  /** R2: the three-way check (running, not running, could not check); wins over `desktopRunning`. */
  readonly desktopState?: () => Promise<DesktopState>;
  /** The agentId an agent folder records (07 §9.1; default: its config.json). */
  readonly agentIdOf?: (name: string) => Promise<string | undefined>;
  /** Fixed-text events only (never a path, a name or file content). */
  readonly log?: (line: string) => void;
  /**
   * WP-D7: the desktop app on this computer, looked up for every list, plan and write (default:
   * locateDesktopApp for this process; `undefined`: none).
   */
  readonly desktopApp?: () => Promise<DesktopApp | undefined>;
  /**
   * APP-CONTINUITY (08 §1 "One AgentLink, browser or app"): this desk runs inside the desktop app
   * (its bundled Node). Then a new connect writes the app form when the app may be written, so a
   * computer with only the app (no Node, no npx) gets a working entry. Default: whether this
   * process's Node is the app's (resourcesOfExecPath).
   */
  readonly runningInApp?: boolean;
}

const DESKTOP: HarnessDef['id'] = 'claude-desktop';
const DESKTOP_CHECK_MS = 3_000;

/** R2: what the process check found. `unknown`: the check itself failed (it says nothing). */
export type DesktopState = 'running' | 'not_running' | 'unknown';

type DesktopCheckRun = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly code: number; readonly out: string }>;

const runCheck: DesktopCheckRun = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: DESKTOP_CHECK_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : Number.NaN;
        resolve({ code, out: typeof stdout === 'string' ? stdout : '' });
      },
    );
  });

/**
 * Best effort: is the Claude desktop app running (06 §7)? macOS: `pgrep -x Claude` (exit 0 running,
 * exit 1 not running, anything else: the check failed); Windows: `tasklist` for `Claude.exe`. Fixed
 * programs and arguments, no shell; the output is only matched, never logged.
 */
export async function claudeDesktopState(
  platform: NodeJS.Platform = process.platform,
  run: DesktopCheckRun = runCheck,
): Promise<DesktopState> {
  if (platform === 'darwin') {
    const { code } = await run('/usr/bin/pgrep', ['-x', 'Claude']);
    return code === 0 ? 'running' : code === 1 ? 'not_running' : 'unknown';
  }
  if (platform === 'win32') {
    const { code, out } = await run('tasklist', [
      '/FI',
      'IMAGENAME eq Claude.exe',
      '/NH',
      '/FO',
      'CSV',
    ]);
    if (code !== 0) return 'unknown';
    return out.toLowerCase().includes('"claude.exe"') ? 'running' : 'not_running';
  }
  // No Claude Desktop on this system (harnesses.ts): nothing to wait for.
  return 'not_running';
}

/**
 * The same check as a yes or no for callers that must fail closed (the `init` prompt): a check that
 * could not run says "running".
 */
export async function claudeDesktopRunning(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  return (await claudeDesktopState(platform)) !== 'not_running';
}

function viewState(state: EntryState): LocalUiAiAppEntryState {
  if (state.kind === 'agent') {
    // WP-D7: only the app form is named; an entry without `form` is the npx form, as before.
    return state.form === 'app'
      ? { kind: 'agent', agent: state.agent, form: 'app' }
      : { kind: 'agent', agent: state.agent };
  }
  return state.kind === 'none' ? { kind: 'none' } : { kind: 'foreign' };
}
const UNREADABLE: LocalUiAiAppEntryState = Object.freeze({ kind: 'unreadable' });

const sameStart = (a: AppStart, b: AppStart): boolean => a.node === b.node && a.cli === b.cli;

/** The harness desk over the fixed table (see the header). */
export function createAiAppsDesk(options: AiAppsDeskOptions): LocalUiAiApps {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const legacyCheck = options.desktopRunning;
  const desktopCheck: () => Promise<DesktopState> =
    options.desktopState ??
    (legacyCheck === undefined
      ? () => claudeDesktopState(platform)
      : () => legacyCheck().then((r): DesktopState => (r ? 'running' : 'not_running')));
  const desktopNow = (): Promise<DesktopState> => desktopCheck().catch(() => 'unknown');
  const agentIdOf =
    options.agentIdOf ??
    (async (name: string) => (await readAgentConfig(options.home, name))?.config.agentId);
  const log = options.log ?? (() => undefined);
  const locate = options.desktopApp ?? (() => locateDesktopApp({ home: options.home, platform }));
  const inApp =
    options.runningInApp ?? resourcesOfExecPath(process.execPath, platform) !== undefined;
  /** The desktop app now; a failed lookup is no app. */
  const appNow = (): Promise<DesktopApp | undefined> => locate().catch(() => undefined);
  const context: HarnessContext = {
    home: options.home,
    env: options.env,
    platform,
    now: 0,
    ...(options.uid === undefined ? {} : { uid: options.uid }),
  };
  const fileOptions = options.uid === undefined ? {} : { uid: options.uid };
  const running = (def: HarnessDef): Promise<boolean> =>
    def.id === DESKTOP ? desktopNow().then((state) => state === 'running') : Promise.resolve(false);

  /** The config as read now, entry-only, or `unreadable`. Never throws with file content. */
  async function read(
    def: HarnessDef,
    app: AppStart | undefined,
  ): Promise<
    | {
        readonly base: string;
        readonly parts: readonly string[];
        readonly path: string;
        readonly before: ConfigFile;
        readonly state: EntryState;
      }
    | 'unreadable'
  > {
    try {
      const { base, parts, path } = await configLocation(def, context);
      const before = await readConfigFile(base, parts, fileOptions);
      return {
        base,
        parts,
        path,
        before,
        state: readEntryState(def, before.text, app === undefined ? {} : { app }),
      };
    } catch {
      return 'unreadable';
    }
  }

  /** The installer's launcher as read now (`unreadable` on any problem). */
  async function readLauncherFile(
    app: AppStart,
  ): Promise<{ readonly before: ConfigFile; readonly kind: string } | 'unreadable'> {
    try {
      const before = await readConfigFile(options.home, launcherParts(platform), fileOptions);
      return { before, kind: readLauncher(before.text, app, platform).kind };
    } catch {
      return 'unreadable';
    }
  }

  async function detected(id: HarnessDef['id']): Promise<boolean> {
    return (await detectHarnesses(context)).some((def) => def.id === id);
  }

  return Object.freeze<LocalUiAiApps>({
    async list() {
      const defs = await detectHarnesses(context);
      const state: DesktopState = defs.some((def) => def.id === DESKTOP)
        ? await desktopNow()
        : 'not_running';
      const desktop = state === 'running';
      const found = await appNow();
      const apps: LocalUiAiAppView[] = [];
      for (const def of defs) {
        const read_ = await read(def, found?.start);
        let path: string;
        try {
          path = (await configLocation(def, context)).path;
        } catch {
          path = '';
        }
        apps.push(
          Object.freeze({
            app: def.id,
            name: def.appName,
            path,
            state: read_ === 'unreadable' ? UNREADABLE : viewState(read_.state),
            quitFirst: def.id === DESKTOP && desktop,
            // R2: the check itself failed: not "Quit first", but "couldn't check".
            ...(def.id === DESKTOP && state === 'unknown' ? { checkFailed: true } : {}),
          }),
        );
      }
      return Object.freeze({
        apps: Object.freeze(apps),
        desktopRunning: desktop,
        ...(found === undefined
          ? {}
          : { desktopApp: found.status === 'ok' ? 'available' : 'move_first' }),
      } as const);
    },

    async plan(app, agent, request: LocalUiAiAppPlanRequest = {}): Promise<LocalUiAiAppPlan> {
      if (!isHarnessId(app) || !isAgentName(agent)) {
        return { status: 'not_found', app: isHarnessId(app) ? app : '', name: '' };
      }
      const def = harnessById(app);
      const brief = (status: Exclude<LocalUiAiAppPlan['status'], 'change'>): LocalUiAiAppPlan =>
        Object.freeze({ status, app: def.id, name: def.appName });
      const wantApp = request.form === 'app';
      if (request.launcher === true && !wantApp) return brief('unreadable');
      if (!(await detected(def.id))) return brief('not_found');
      if (await running(def)) return brief('quit_first');
      const located = await appNow();
      // An app in a translocated, temporary or read-only place is never written into a config.
      if (wantApp && located?.status !== 'ok') return brief('app_location');
      const appStart = located?.start;
      const found = await read(def, appStart);
      if (found === 'unreadable') return brief('unreadable');
      const { base, parts, path, before, state } = found;
      if (state.kind === 'foreign') return brief('conflict');
      let text: string;
      let kind: 'connect' | 'move' | 'disconnect' | 'switch';
      let form: EntryForm | undefined;
      const recognise = appStart === undefined ? {} : { app: appStart };
      try {
        if (state.kind === 'agent' && state.agent === agent) {
          if (wantApp) {
            if (state.form === 'app') return brief('present');
            kind = 'switch';
            form = 'app';
            text = setEntry(def, before.text, agent, { ...recognise, form });
          } else {
            kind = 'disconnect';
            text = removeEntry(def, before.text, recognise);
          }
        } else {
          kind = state.kind === 'agent' ? 'move' : 'connect';
          // APP-CONTINUITY: a new connect from inside the app (where it may be written) is the
          // app form; a move keeps the entry's form (a browser-made npx entry stays npx).
          form = wantApp
            ? 'app'
            : state.kind === 'agent'
              ? state.form
              : inApp && located?.status === 'ok'
                ? 'app'
                : 'npx';
          // A move keeps an app-form entry only while the app may be written.
          if (form === 'app' && located?.status !== 'ok') return brief('app_location');
          text = setEntry(def, before.text, agent, { ...recognise, form });
        }
      } catch {
        return brief('unreadable');
      }
      let file: string;
      try {
        file = join(await realpath(base), ...parts);
      } catch {
        return brief('unreadable');
      }
      const oldEntry = state.kind === 'agent' ? (state.entry as JsonObject) : null;
      let newEntry: JsonObject | null;
      try {
        newEntry =
          kind === 'disconnect' || form === undefined
            ? null
            : (entryOf(def, agent, form, appStart) as JsonObject);
      } catch {
        return brief('unreadable');
      }
      const oldAgent = state.kind === 'agent' ? state.agent : null;
      const newAgent = kind === 'disconnect' ? null : agent;

      // The installer's launcher (WP-D7, optional): offered, or planned when asked for.
      let launcher: { readonly change: LocalUiLauncherChange; readonly before: ConfigFile } | null =
        null;
      let launcherOffer = false;
      if (form === 'app' && appStart !== undefined && kind !== 'disconnect') {
        const current = await readLauncherFile(appStart);
        const repointable = current !== 'unreadable' && current.kind === 'npx';
        if (request.launcher === true) {
          if (!repointable || current.before.text === undefined) return brief('unreadable');
          launcher = {
            before: current.before,
            change: Object.freeze({
              path: launcherDisplay(platform),
              oldText: current.before.text,
              newText: appLauncherText(appStart, platform),
            }),
          };
        } else {
          launcherOffer = repointable;
        }
      }

      const commit = async (agentId: string): Promise<LocalUiAiAppWrite> => {
        if (await running(def)) return 'quit_first';
        // Fixed content (04 §2.5): the folder the entry runs records the agentId that was signed.
        const runs = newAgent ?? oldAgent;
        if (runs === null || !isAgentName(runs)) return 'agent_mismatch';
        const recorded = await agentIdOf(runs).catch(() => undefined);
        if (recorded === undefined || recorded !== agentId) return 'agent_mismatch';
        // Plan Decision 2 "Translocation (M3)": an app-form write points at the app as it is now,
        // in a place that may be written (looked up again: the app may have been moved meanwhile).
        if (form === 'app') {
          const again = await appNow();
          if (
            again?.status !== 'ok' ||
            appStart === undefined ||
            !sameStart(again.start, appStart)
          ) {
            return 'app_location';
          }
        }
        try {
          await writeConfigFile(base, parts, before, text, {
            ...fileOptions,
            now: now(),
            keepBackupMode: true,
          });
        } catch (error) {
          if (error instanceof HarnessError && error.code === 'changed') return 'changed';
          log('ai app settings not written');
          return 'failed';
        }
        log('ai app settings written');
        if (launcher !== null) {
          try {
            // Default backup mode (0600): a backup in the launcher's folder must not be a command.
            await writeConfigFile(
              options.home,
              launcherParts(platform),
              launcher.before,
              launcher.change.newText,
              { ...fileOptions, now: now() },
            );
            log('agentlink command pointed at the app');
          } catch {
            // The entry is written; the owner is told the command was not changed.
            log('agentlink command not changed');
            return 'written_launcher_unchanged';
          }
        }
        return 'written';
      };
      return Object.freeze({
        status: 'change',
        kind,
        app: def.id,
        name: def.appName,
        path,
        file,
        oldEntry,
        newEntry,
        oldAgent,
        newAgent,
        identity: before.identity ?? 'none',
        ...(launcher === null ? {} : { launcher: launcher.change }),
        ...(launcherOffer ? { launcherOffer: true } : {}),
        commit,
      });
    },

    agentIdOf: (name) =>
      isAgentName(name) ? agentIdOf(name).catch(() => undefined) : Promise.resolve(undefined),
  });
}
