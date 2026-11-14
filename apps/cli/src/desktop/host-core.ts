// WP-D3 (desktop plan rev. 1, Decision 2 and 3, §2; 08 §1, §4; 04 §2.5; I-4, I-5, I-7): the core
// desktop host. It runs the same app host as `agentlink ui` (ui.ts startUiServer: the agent choice,
// Welcome with no agent, D-138 switching, removal, first run) with one difference: the approval
// server's one-shot session links go to the shell over the private pipe (protocol.ts `ready`), never
// to the OS browser opener, stdout, stderr, a log or a file.
//
// - Events to the shell are counts and fixed states only (`status`, `approval-waiting`).
// - `invite {link}`: the core checks it again exactly like `agentlink join` (the 08 §4 pattern in
//   the parser, then the short-link resolve and core's Accept step 1) and hands it to its own server
//   through the same loopback handoff `join` uses (runtime/app-host-record.ts sendHandoff), with the
//   record it holds in memory. The server's join desk keeps it in memory; accepting still needs the
//   owner's presence. The link is never logged, printed, written or echoed back.
// - `show {route}`: a fixed enum, never a path; it mints a fresh one-shot link, sent as `ready`.
// - DESK051-UPD `app-update {…}`: the shell's update state, kept in memory for Settings > Updates
//   (node local-ui/api/app-update.ts); "Check for updates" sends `app-update-check` (no other key).
//   The core makes no request of its own for it. UPD-5: "Update now" sends `app-update-install` and
//   "Restart now" `app-update-restart` (no other key), each only in its state; the shell decides
//   (it installs only what it verified). `busy` (the page warns before a restart) is the tray's
//   count of requests waiting for the owner.
// - `~/.agentlink/app-host.json` is written by the server's handoff option (nodeUiDeps), so a
//   terminal `agentlink join` hands its invite to this host unchanged; it is removed on close.
// - N7 (PLAN-NOTIFY §3.5): the desktop app owns the OS notifications. Each tick turns the open ID's
//   notification items and the approvals count into fixed `notify` codes (alerts.ts) for the
//   switches the owner turned on; the shell builds the words. Its own server never runs the
//   osascript / notify-send alert (approvalAlerts: false), and `~/.agentlink/desktop-alerts.json`
//   ({v, pid, started, at, id}) tells `agentlink mcp` not to either, for the open ID only, while this
//   host runs (no double alerts; mcp still alerts for every other ID).
// - `shutdown`, the pipe closing, a stop signal or a fatal error: the server closes, `stopped`
//   goes out, the pipe closes, and the run ends.
//
// Not an MCP tool and not a command (I-4): no AI app can reach it; an AI that starts the file
// without the app's pipe gets one fixed line (host-main.ts). Same G-1 caveat as `ui`: a same-user
// process could build its own pipe; owner actions still need presence and an owner signature.
import type {
  AppHostAgent,
  AppHostHandoffRecordValue,
  ApprovalServer,
  ApprovalServerOptions,
  ApprovalServerSource,
  AppUpdateView,
  LocalUiAppUpdateDesk,
} from '@4thtech-io/node';
import { startUiServer, type UiDeps, type UiServer } from '../commands/ui.js';
import { notifyMessages, planAlerts, refsToName, type AlertBaseline } from './alerts.js';
import type { FatalReason } from '../runtime/ui-lifecycle.js';
import type { DesktopPipe } from './pipe.js';
import { dedupeFileAndMessage, type RecentAlerts } from './alert-dedupe.js';
import {
  isNotifyTarget,
  isSessionUrl,
  type HostCounts,
  type HostState,
  type InviteOutcome,
  type ShellMessage,
  type ShowRoute,
  type StopReason,
} from './protocol.js';

/** N7 (IR-N7-1 L-2): desktop-alerts.json is written again at least this often (its lease). */
export const RECORD_RENEW_MS = 60_000;

/** UPD-5: the states of a running in-app update (no check meanwhile). */
const IN_APP_RUNNING: ReadonlySet<string> = new Set([
  'downloading',
  'verifying',
  'ready',
  'restarting',
]);

/** How often the counts are read (a pending list read of the open agent and the open pages). */
export const STATUS_EVERY_MS = 5_000;

/** The invite steps `join` uses (core resolveInviteLink, checkInviteLink; sendHandoff). */
export interface DesktopInviteDeps {
  resolve(link: string): Promise<string>;
  check(link: string, nowSeconds: number): Promise<unknown>;
  now(): number;
  /** The loopback handoff to this host's own server ('waiting' | 'invite_waiting' | 'failed'). */
  handoff(
    record: AppHostHandoffRecordValue,
    link: string,
  ): Promise<'waiting' | 'invite_waiting' | 'failed'>;
}

export interface DesktopHostDeps {
  readonly pipe: DesktopPipe;
  /** The `ui` deps with this server starter (nodeUiDeps(hooks)). */
  uiDeps(startServer: (options: ApprovalServerOptions) => Promise<ApprovalServer>): UiDeps;
  /** Starts the server with the link sink (startApprovalServerWithLinkSink). */
  startServer(
    options: ApprovalServerOptions,
    sink: (sessionUrl: string) => Promise<boolean>,
  ): Promise<ApprovalServer>;
  readonly invite: DesktopInviteDeps;
  /** Calls `stop` on SIGINT, SIGTERM or SIGHUP; returns the unsubscribe. */
  interrupt(stop: () => void): () => void;
  /** R1: stray background errors keep the host up; `onFatal` ends it. Returns the unsubscribe. */
  guard?(onFatal: (reason: FatalReason) => void): () => void;
  /** Default STATUS_EVERY_MS. */
  readonly statusEveryMs?: number;
  /**
   * N7: the mark that this desktop app owns the OS notifications for one ID, `scope` (the open ID;
   * desktop-alerts-record.ts). Written after each first look at an ID and renewed every
   * RECORD_RENEW_MS; removed when no ID is open and when the host stops. Absent: no mark (tests).
   */
  readonly alertsRecord?: { write(scope: string): Promise<void>; remove(): Promise<void> };
}

/** Exit codes: 0 for a clean stop, 1 when it could not start or a fatal error ended it. */
export const HOST_EXIT_OK = 0;
export const HOST_EXIT_FAILED = 1;

/** The invite failure words from a core error code (join.ts uses the same codes). */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Runs the host until it stops. Returns the exit code. */
export async function runDesktopHost(deps: DesktopHostDeps): Promise<number> {
  const { pipe } = deps;
  let state: HostState = 'starting';
  let lastStatus = '';
  let lastWaiting: number | undefined;
  let approvalServer: ApprovalServer | undefined;
  let record: AppHostHandoffRecordValue | undefined;
  /** The open agent's pending source (switches follow it); undefined while none is open. */
  let current: ApprovalServerSource | undefined;
  /** Whether an agent was opened after the start (first run made one). */
  let openedSinceStart = false;
  let waiting = 0;
  /** N7: the IDs of the approvals waiting, and whose they are. */
  let waitingIds: readonly string[] = [];
  let waitingOf: ApprovalServerSource | undefined;
  /** DESK051-UPD: the shell's last update state (undefined until it sends one). */
  let appUpdate: AppUpdateView | undefined;

  let stopWith: (reason: StopReason) => void = () => undefined;
  const stopped = new Promise<StopReason>((resolve) => {
    stopWith = resolve;
  });
  let stopping = false;
  const stop = (reason: StopReason): void => {
    if (stopping) return;
    stopping = true;
    stopWith(reason);
  };

  const sendStatus = (): void => {
    const counts: HostCounts = {
      openPages: approvalServer?.activity.openStreams() ?? 0,
      waitingApprovals: waiting,
    };
    const key = `${state}:${String(counts.openPages)}:${String(counts.waitingApprovals)}`;
    if (key !== lastStatus) {
      lastStatus = key;
      pipe.send({ v: 1, type: 'status', state, counts });
    }
    if (lastWaiting !== waiting && state === 'running') {
      lastWaiting = waiting;
      pipe.send({ v: 1, type: 'approval-waiting', count: waiting });
    }
  };

  /** The only place a session link goes: the pipe, as `ready`, after it is checked. */
  const sink = (sessionUrl: string): Promise<boolean> => {
    // Fail closed: nothing before the server is known, and only its own origin.
    if (stopping || approvalServer === undefined || !isSessionUrl(sessionUrl)) {
      return Promise.resolve(false);
    }
    if (!sessionUrl.startsWith(`${approvalServer.origin}/`)) return Promise.resolve(false);
    return Promise.resolve(pipe.send({ v: 1, type: 'ready', sessionUrl }));
  };

  const tracked = (agent: AppHostAgent): AppHostAgent => {
    current = agent.source;
    const source = agent.source;
    return Object.freeze<AppHostAgent>({
      ...agent,
      close: async () => {
        if (current === source) current = undefined;
        await agent.close();
      },
    });
  };

  /** DESK051-UPD: Settings > Updates. A check is the shell's; meanwhile the page sees "checking". */
  const appUpdateDesk: LocalUiAppUpdateDesk = Object.freeze<LocalUiAppUpdateDesk>({
    install: 'desktop',
    view: () => appUpdate,
    check: () => {
      const now = appUpdate;
      if (now === undefined || now.state === 'off' || stopping) return now;
      // Not while an in-app update runs (the shell would not check then either).
      if (IN_APP_RUNNING.has(now.state)) return now;
      if (!pipe.send({ v: 1, type: 'app-update-check' })) return now;
      appUpdate = Object.freeze({
        ...now,
        state: 'checking',
        latest: '',
        download: '',
        installable: false,
        percent: 0,
      });
      return appUpdate;
    },
    // UPD-5: Update now, only for an update the shell said it can install here.
    startInstall: () => {
      const now = appUpdate;
      if (now === undefined || stopping) return now;
      if (now.state !== 'available' || now.installable !== true) return now;
      if (!pipe.send({ v: 1, type: 'app-update-install' })) return now;
      appUpdate = Object.freeze({ ...now, state: 'downloading', percent: 0 });
      return appUpdate;
    },
    // UPD-5: Restart now, only once the shell said the update is ready.
    restart: () => {
      const now = appUpdate;
      if (now === undefined || stopping || now.state !== 'ready') return now;
      if (!pipe.send({ v: 1, type: 'app-update-restart' })) return now;
      appUpdate = Object.freeze({ ...now, state: 'restarting', percent: 0 });
      return appUpdate;
    },
    busy: () => waiting > 0,
  });

  /** The server starter given to the `ui` deps: the link sink, the record and the open agent. */
  const startServer = async (options: ApprovalServerOptions): Promise<ApprovalServer> => {
    const host = options.host;
    const initial = host?.initial;
    current = initial?.source ?? options.source;
    const wrapped: ApprovalServerOptions = {
      ...options,
      appUpdate: appUpdateDesk,
      // N7: the shell shows native notifications; this server never runs osascript / notify-send.
      approvalAlerts: () => Promise.resolve(false),
      ...(host === undefined
        ? {}
        : {
            host: {
              ...host,
              ...(initial === undefined
                ? {}
                : {
                    initial: {
                      ...initial,
                      close: async () => {
                        if (current === initial.source) current = undefined;
                        await initial.close();
                      },
                    },
                  }),
              open: async (name: string) => {
                const agent = await host.open(name);
                if (agent === undefined) return undefined;
                openedSinceStart = true;
                return tracked(agent);
              },
              ...(host.handoff === undefined
                ? {}
                : {
                    handoff: {
                      // Held in memory for the shell's invites; the file is `join`'s (0600).
                      write: async (value: AppHostHandoffRecordValue) => {
                        record = value;
                        await host.handoff?.write(value);
                      },
                      remove: async () => {
                        record = undefined;
                        await host.handoff?.remove();
                      },
                    },
                  }),
            },
          }),
    };
    const server = await deps.startServer(wrapped, sink);
    approvalServer = server;
    return server;
  };

  const unsubscribe = deps.interrupt(() => stop('signal'));
  const unguard = deps.guard?.(() => stop('fatal'));
  pipe.onClose(() => stop('pipe_closed'));
  // DESK051-UPD: kept at once (the first one follows the first `ready`, before the queue below).
  pipe.onMessage((message) => {
    if (message.type !== 'app-update') return;
    appUpdate = Object.freeze({
      state: message.state,
      current: message.current,
      latest: message.latest,
      download: message.download,
      installable: message.installable,
      percent: message.percent,
    });
  });
  sendStatus();

  let started: { ok: true; server: UiServer } | { ok: false; failure: StopReason };
  try {
    const result = await startUiServer(deps.uiDeps(startServer), undefined);
    // WIN-BROKEN-ID: the pipe's reasons are fixed (protocol.ts); a broken ID that left no host is `open`.
    started = result.ok
      ? result
      : { ok: false, failure: result.failure === 'broken_id' ? 'open' : result.failure };
  } catch {
    started = { ok: false, failure: 'failed' };
  }
  if (!started.ok || stopping) {
    if (started.ok) await started.server.close().catch(() => undefined);
    const reason = started.ok ? await stopped : started.failure;
    pipe.send({ v: 1, type: 'stopped', reason });
    unsubscribe();
    unguard?.();
    await pipe.close();
    return started.ok && reason !== 'fatal' ? HOST_EXIT_OK : HOST_EXIT_FAILED;
  }
  const { server } = started;
  state = 'running';
  sendStatus();
  // The first page: Home, first run while no owner exists (the sink sends `ready`).
  await server.open().catch(() => false);

  const show = async (route: ShowRoute, target?: string): Promise<void> => {
    if (approvalServer === undefined) return;
    // NOTIFY-DEEPLINK: the one request or person a notification named; the server checks the shape
    // again. A request that is no longer waiting opens the approve page's own "no longer waiting" state
    // (the page decides); an unknown person opens Home (the fallback below).
    if (route === 'approvals' && target !== undefined && isNotifyTarget('approvals', target)) {
      if (await approvalServer.open(target).catch(() => false)) return;
    } else if (route === 'inbox' && target !== undefined && isNotifyTarget('inbox', target)) {
      if (await approvalServer.openPerson(target).catch(() => false)) return;
    }
    if (route === 'approvals' || route === 'inbox') await approvalServer.open().catch(() => false);
    else if (route === 'updates') await approvalServer.openUpdates().catch(() => false);
    else if (route === 'join') await approvalServer.openJoin().catch(() => false);
    else if (server.page === 'first-run' && !openedSinceStart) {
      await approvalServer.openFirstRun().catch(() => false);
    } else await approvalServer.openHome().catch(() => false);
  };

  const invite = async (link: string): Promise<InviteOutcome> => {
    let resolved: string;
    try {
      resolved = await deps.invite.resolve(link);
    } catch (error) {
      const code = codeOf(error);
      return code === 'invite_fetch_failed'
        ? 'unreachable'
        : code === 'invite_unavailable'
          ? 'unavailable'
          : 'refused';
    }
    try {
      await deps.invite.check(resolved, deps.invite.now());
    } catch (error) {
      return codeOf(error) === 'invite_expired' ? 'expired' : 'refused';
    }
    if (record === undefined) return 'failed';
    return deps.invite.handoff(record, resolved).catch(() => 'failed' as const);
  };

  // One message at a time, in order.
  let queue: Promise<void> = Promise.resolve();
  const handle = async (message: ShellMessage): Promise<void> => {
    if (stopping) return;
    if (message.type === 'shutdown') stop('shutdown');
    else if (message.type === 'show') await show(message.route, message.target);
    else if (message.type === 'app-update')
      return; // kept by its own listener above
    else {
      const outcome = await invite(message.link);
      pipe.send({ v: 1, type: 'invite-result', outcome });
    }
  };
  pipe.onMessage((message) => {
    queue = queue.then(() => handle(message)).catch(() => undefined);
  });

  /**
   * N7: the last look at the open ID. A failed look keeps it (IR-N7-1 L-3: a reset would make an
   * approval that arrives meanwhile count as already there); only another ID starts a fresh one.
   */
  let alertBaseline: AlertBaseline | undefined;
  /** Whose approvals the baseline holds. */
  let baselineOf: ApprovalServerSource | undefined;
  /**
   * N7 (IR-N7-1 L-5, L-2): the ID this host alerts for, as told to `agentlink mcp` in
   * desktop-alerts.json (mcp still alerts for every other ID), and when it was last written (a lease
   * renewed every RECORD_RENEW_MS; a record that is not renewed stops counting).
   */
  let recordScope: string | undefined;
  /** NOTIFY-UPDATE-READY: the first look of this run is done (an update already waiting is alerted once). */
  let firstLookDone = false;
  /** NOTIFY-DEDUPE: who was alerted about lately (a file and its message are one alert). */
  const recentAlerts: RecentAlerts = new Map();
  let recordAt = 0;
  const mark = async (scope: string | undefined): Promise<void> => {
    if (deps.alertsRecord === undefined) return;
    if (scope === undefined || scope === '') {
      if (recordScope !== undefined) await deps.alertsRecord.remove().catch(() => undefined);
      recordScope = undefined;
      return;
    }
    const at = Date.now();
    if (scope === recordScope && at - recordAt < RECORD_RENEW_MS) return;
    // After the look that set the baseline: an approval raised before this write is still alerted
    // by mcp (it saw the old record), never swallowed.
    await deps.alertsRecord.write(scope).then(
      () => {
        recordScope = scope;
        recordAt = at;
      },
      () => undefined,
    );
  };
  const alert = async (): Promise<void> => {
    const server = approvalServer;
    const source = current;
    if (server === undefined || source === undefined) {
      alertBaseline = undefined;
      await mark(undefined);
      return;
    }
    // The approvals of another ID not read yet: wait for the next look.
    if (waitingOf !== source) return;
    const state = await server.desktopAlerts().catch(() => undefined);
    if (state === undefined) return;
    // Another ID's approvals (a switch): a fresh first look, whatever the scope says yet.
    const prev = baselineOf === source ? alertBaseline : undefined;
    const { news, baseline } = planAlerts(prev, waitingIds, state, { launch: !firstLookDone });
    firstLookDone = true;
    alertBaseline = baseline;
    baselineOf = source;
    await mark(state.scope);
    if (news.length === 0) return;
    // NOTIFY-DEDUPE: a person's file and its message are one alert.
    const alerts = dedupeFileAndMessage(
      news,
      (kind) => state.prefs[kind === 'files' ? 'files' : 'messages'],
      recentAlerts,
      Date.now(),
    );
    const refs = refsToName(alerts, state.prefs);
    const names =
      refs.length === 0
        ? new Map<string, string>()
        : await server.ownerNames(refs).catch(() => new Map<string, string>());
    if (stopping) return;
    for (const message of notifyMessages(alerts, state.prefs, names)) pipe.send(message);
  };

  const every = deps.statusEveryMs ?? STATUS_EVERY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    const source = current;
    if (source !== undefined) {
      const list = await source.list().catch(() => undefined);
      if (list !== undefined && source === current) {
        waiting = list.length;
        waitingIds = list.map((v) => v.approvalId);
        waitingOf = source;
      }
    } else {
      waiting = 0;
      waitingIds = [];
      waitingOf = undefined;
    }
    if (stopping) return;
    sendStatus();
    await alert().catch(() => undefined);
    if (stopping) return;
    timer = setTimeout(() => void tick(), every);
  };
  await tick();

  const reason = await stopped;
  if (timer !== undefined) clearTimeout(timer);
  state = 'closing';
  sendStatus();
  await queue;
  await server.close().catch(() => undefined);
  await deps.alertsRecord?.remove().catch(() => undefined);
  pipe.send({ v: 1, type: 'stopped', reason });
  unsubscribe();
  unguard?.();
  await pipe.close();
  return reason === 'fatal' ? HOST_EXIT_FAILED : HOST_EXIT_OK;
}
