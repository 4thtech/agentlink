// R1: the local checks `agentlink doctor` adds (06 §8; plan "telemetry-free diagnostics"): why
// AgentLink closed last time, a leftover app-host.json, half-removed IDs and AI-app entries that
// start an ID that is gone. Everything is read-only and local; nothing is sent anywhere. What is
// printed is fixed words, counts, an AI app's fixed display name and an ID folder name (06 §6 name
// rule) - never a path, a token, a message or a label.
import type { LocalUiAiApps } from '@4thtech-io/node';
import { homedir } from 'node:os';
import process from 'node:process';
import { createAiAppsDesk } from '../harness/app-desk.js';
import { HARNESSES } from '../harness/harnesses.js';
import { agentDirectory } from '../runtime/agent-dir.js';
import { isAgentName } from '../runtime/agent-name.js';
import { pidAlive, readAppHostRecord } from '../runtime/app-host-record.js';
import { readLastExit, type LastExitReason } from '../runtime/last-exit.js';

/** 11 §5 plain words. The app's name and the ID folder name are the only inserted values. */
export const DOCTOR_LOCAL_TEXT = Object.freeze({
  /** After "Last time AgentLink closed because …". */
  closedBecause: Object.freeze<Record<LastExitReason, string>>({
    ctrl_c: 'you pressed Ctrl+C',
    sigterm: 'your computer asked it to stop',
    sighup: 'its terminal window was closed',
    idle: 'it was not used for 30 minutes',
    uncaught: 'of an unexpected problem',
    rejections: 'of a run of unexpected problems',
    start_no_owner: "it wasn't set up yet",
    start_no_ids: "it couldn't open the app to make your first ID",
    start_removing: 'some IDs were only half removed',
    start_port: "it couldn't start its page on this computer",
    start_keychain: "your computer's keychain wasn't available",
    start_open: "it couldn't open your ID",
    start_failed: "it couldn't start",
  }),
  get staleHost(): string {
    return `Problem  AgentLink left a note that it is running, but it isn't. Run \`agentlink\` to start it fresh.`;
  },
  halfRemoved: (count: number): string =>
    `Problem  ${String(count)} ${count === 1 ? 'ID was' : 'IDs were'} only half removed. Run \`agentlink\` to open AgentLink and finish removing ${count === 1 ? 'it' : 'them'}.`,
  appMissingId: (app: string, id: string): string =>
    `Problem  ${app} starts the ID "${id}", which isn't on this computer any more. Open AgentLink (run \`agentlink\`), go to AI apps and connect ${app} to another ID.`,
});

/** The reasons that mean something went wrong, not that the person closed AgentLink. */
const NORMAL: ReadonlySet<LastExitReason> = new Set(['ctrl_c', 'sigterm', 'sighup', 'idle']);

export interface LocalChecksOptions {
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** The ID folders (name and whether half removed); default: the agent directory under `home`. */
  readonly ids?: () => Promise<
    readonly {
      readonly name: string;
      readonly removing: boolean;
      /** The display name; absent: the folder name. */
      readonly label?: string;
    }[]
  >;
  /** The AI apps' entries, read-only (default: the harness desk, never asking the OS about apps). */
  readonly apps?: Pick<LocalUiAiApps, 'list'>;
  /** The AI app ids with a live session for an ID (default: the ID's store, as the app reads it). */
  readonly liveApps?: (name: string) => Promise<readonly string[]>;
  /** Whether a process is alive (default: signal 0). */
  readonly alive?: (pid: number) => boolean;
}

/** One ID that can be checked: its folder name, its display name and the AI apps that start it. */
export interface LocalDoctorId {
  readonly name: string;
  readonly label: string;
  readonly apps: readonly string[];
}

export interface LocalChecks {
  readonly lines: readonly string[];
  readonly problems: number;
  /** Every ID on this computer that is not half removed, by display name (empty: none/unreadable). */
  readonly ids?: readonly LocalDoctorId[];
}

/** The checks; never throws. A check that cannot be read says nothing. */
export async function localDoctorChecks(options: LocalChecksOptions = {}): Promise<LocalChecks> {
  const home = options.home ?? homedir();
  const lines: string[] = [];
  let problems = 0;
  let checkable: LocalDoctorId[] | undefined;

  const last = await readLastExit(home);
  if (last !== undefined) {
    lines.push(
      `${NORMAL.has(last.reason) ? 'OK       ' : 'Warning  '}Last time AgentLink closed because ${DOCTOR_LOCAL_TEXT.closedBecause[last.reason]}.`,
    );
  }

  const record = await readAppHostRecord(home);
  if (record !== undefined && !(options.alive ?? pidAlive)(record.pid)) {
    lines.push(DOCTOR_LOCAL_TEXT.staleHost);
    problems += 1;
  }

  const ids = await (
    options.ids ??
    (async () =>
      (await agentDirectory(home).list()).map((e) => ({
        name: e.name,
        removing: e.removing,
        label: e.label,
      })))
  )().catch(() => undefined);
  if (ids !== undefined) {
    const half = ids.filter((id) => id.removing).length;
    if (half > 0) {
      lines.push(DOCTOR_LOCAL_TEXT.halfRemoved(half));
      problems += 1;
    }
    const apps =
      options.apps ??
      createAiAppsDesk({
        home,
        env: options.env ?? process.env,
        ...(options.platform === undefined ? {} : { platform: options.platform }),
        // Read-only: never ask the OS whether Claude Desktop runs.
        desktopRunning: () => Promise.resolve(false),
      });
    const usable = new Set(ids.filter((id) => !id.removing).map((id) => id.name));
    const listed = await apps.list().catch(() => undefined);
    const appsOf = new Map<string, string[]>();
    for (const app of listed?.apps ?? []) {
      if (app.state.kind !== 'agent') continue;
      const id = app.state.agent;
      if (!isAgentName(id)) continue;
      if (usable.has(id)) {
        appsOf.set(id, [...(appsOf.get(id) ?? []), app.name]);
        continue;
      }
      lines.push(DOCTOR_LOCAL_TEXT.appMissingId(app.name, id));
      problems += 1;
    }
    // The app's "Used by" shows the AI apps with a live session too (agent-peek); doctor agrees.
    const nameOfApp = (id: string): string =>
      HARNESSES.find((h) => h.id === id)?.appName ?? 'Another AI app';
    const liveOf =
      options.liveApps ??
      (async (name: string): Promise<readonly string[]> =>
        ((await agentDirectory(home).stats(name))?.sessions ?? []).map((s) => s.app));
    checkable = [];
    for (const id of ids.filter((i) => !i.removing && isAgentName(i.name))) {
      const live = new Set(
        (await liveOf(id.name).catch(() => [] as readonly string[])).map(nameOfApp),
      );
      const names = [
        ...(appsOf.get(id.name) ?? []),
        ...[...live].filter((n) => !(appsOf.get(id.name) ?? []).includes(n)),
      ];
      checkable.push({
        name: id.name,
        label: id.label !== undefined && id.label.length > 0 ? id.label : id.name,
        apps: Object.freeze(names.map((n) => (live.has(n) ? `${n} (connected now)` : n))),
      });
    }
  }
  return Object.freeze({
    lines: Object.freeze(lines),
    problems,
    ...(checkable === undefined ? {} : { ids: Object.freeze(checkable) }),
  });
}
