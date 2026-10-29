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
  LocalUiAiApps,
  LocalUiAiAppView,
  LocalUiAiAppWrite,
} from '@4thtech-io/node';
import type { JsonObject } from '@4thtech-io/crypto';
import { readAgentConfig } from '../runtime/agent-dir.js';
import { isAgentName } from '../runtime/agent-name.js';
import { agentlinkEntry, readEntryState, removeEntry, setEntry, type EntryState } from './entry.js';
import { HarnessError } from './errors.js';
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
  /** The agentId an agent folder records (07 §9.1; default: its config.json). */
  readonly agentIdOf?: (name: string) => Promise<string | undefined>;
  /** Fixed-text events only (never a path, a name or file content). */
  readonly log?: (line: string) => void;
}

const DESKTOP: HarnessDef['id'] = 'claude-desktop';
const DESKTOP_CHECK_MS = 3_000;

/**
 * Best effort: is the Claude desktop app running (06 §7)? macOS: `pgrep -x Claude`; Windows:
 * `tasklist` for `Claude.exe`. Fixed programs and arguments, no shell; the output is only matched,
 * never logged. A check that fails says "running" (fail closed: nothing is written).
 */
export function claudeDesktopRunning(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const run = (file: string, args: readonly string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(
        file,
        [...args],
        { timeout: DESKTOP_CHECK_MS, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => {
          const code =
            error === null ? 0 : typeof error.code === 'number' ? error.code : Number.NaN;
          resolve({ code, out: typeof stdout === 'string' ? stdout : '' });
        },
      );
    });
  if (platform === 'darwin') {
    return run('/usr/bin/pgrep', ['-x', 'Claude']).then(({ code }) => code !== 1);
  }
  if (platform === 'win32') {
    return run('tasklist', ['/FI', 'IMAGENAME eq Claude.exe', '/NH', '/FO', 'CSV']).then(
      ({ code, out }) => code !== 0 || out.toLowerCase().includes('"claude.exe"'),
    );
  }
  // No Claude Desktop on this system (harnesses.ts): nothing to wait for.
  return Promise.resolve(false);
}

function viewState(state: EntryState): LocalUiAiAppEntryState {
  if (state.kind === 'agent') return { kind: 'agent', agent: state.agent };
  return state.kind === 'none' ? { kind: 'none' } : { kind: 'foreign' };
}
const UNREADABLE: LocalUiAiAppEntryState = Object.freeze({ kind: 'unreadable' });

/** The harness desk over the fixed table (see the header). */
export function createAiAppsDesk(options: AiAppsDeskOptions): LocalUiAiApps {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const desktopRunning = options.desktopRunning ?? (() => claudeDesktopRunning(platform));
  const agentIdOf =
    options.agentIdOf ??
    (async (name: string) => (await readAgentConfig(options.home, name))?.config.agentId);
  const log = options.log ?? (() => undefined);
  const context: HarnessContext = {
    home: options.home,
    env: options.env,
    platform,
    now: 0,
    ...(options.uid === undefined ? {} : { uid: options.uid }),
  };
  const fileOptions = options.uid === undefined ? {} : { uid: options.uid };
  const running = (def: HarnessDef): Promise<boolean> =>
    def.id === DESKTOP ? desktopRunning().catch(() => true) : Promise.resolve(false);

  /** The config as read now, entry-only, or `unreadable`. Never throws with file content. */
  async function read(def: HarnessDef): Promise<
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
      return { base, parts, path, before, state: readEntryState(def, before.text) };
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
      const desktop = defs.some((def) => def.id === DESKTOP)
        ? await desktopRunning().catch(() => true)
        : false;
      const apps: LocalUiAiAppView[] = [];
      for (const def of defs) {
        const found = await read(def);
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
            state: found === 'unreadable' ? UNREADABLE : viewState(found.state),
            quitFirst: def.id === DESKTOP && desktop,
          }),
        );
      }
      return Object.freeze({ apps: Object.freeze(apps), desktopRunning: desktop });
    },

    async plan(app, agent): Promise<LocalUiAiAppPlan> {
      if (!isHarnessId(app) || !isAgentName(agent)) {
        return { status: 'not_found', app: isHarnessId(app) ? app : '', name: '' };
      }
      const def = harnessById(app);
      const brief = (status: Exclude<LocalUiAiAppPlan['status'], 'change'>): LocalUiAiAppPlan =>
        Object.freeze({ status, app: def.id, name: def.appName });
      if (!(await detected(def.id))) return brief('not_found');
      if (await running(def)) return brief('quit_first');
      const found = await read(def);
      if (found === 'unreadable') return brief('unreadable');
      const { base, parts, path, before, state } = found;
      if (state.kind === 'foreign') return brief('conflict');
      let text: string;
      let kind: 'connect' | 'move' | 'disconnect';
      try {
        if (state.kind === 'agent' && state.agent === agent) {
          kind = 'disconnect';
          text = removeEntry(def, before.text);
        } else {
          kind = state.kind === 'agent' ? 'move' : 'connect';
          text = setEntry(def, before.text, agent);
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
      const newEntry = kind === 'disconnect' ? null : (agentlinkEntry(def, agent) as JsonObject);
      const oldAgent = state.kind === 'agent' ? state.agent : null;
      const newAgent = kind === 'disconnect' ? null : agent;
      const commit = async (agentId: string): Promise<LocalUiAiAppWrite> => {
        if (await running(def)) return 'quit_first';
        // Fixed content (04 §2.5): the folder the entry runs records the agentId that was signed.
        const runs = newAgent ?? oldAgent;
        if (runs === null || !isAgentName(runs)) return 'agent_mismatch';
        const recorded = await agentIdOf(runs).catch(() => undefined);
        if (recorded === undefined || recorded !== agentId) return 'agent_mismatch';
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
        commit,
      });
    },

    agentIdOf: (name) =>
      isAgentName(name) ? agentIdOf(name).catch(() => undefined) : Promise.resolve(undefined),
  });
}
