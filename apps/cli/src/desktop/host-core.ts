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
// - `~/.agentlink/app-host.json` is written by the server's handoff option (nodeUiDeps), so a
//   terminal `agentlink join` hands its invite to this host unchanged; it is removed on close.
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
} from '@4thtech-io/node';
import { startUiServer, type UiDeps, type UiServer } from '../commands/ui.js';
import type { FatalReason } from '../runtime/ui-lifecycle.js';
import type { DesktopPipe } from './pipe.js';
import {
  isSessionUrl,
  type HostCounts,
  type HostState,
  type InviteOutcome,
  type ShellMessage,
  type ShowRoute,
  type StopReason,
} from './protocol.js';

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

  /** The server starter given to the `ui` deps: the link sink, the record and the open agent. */
  const startServer = async (options: ApprovalServerOptions): Promise<ApprovalServer> => {
    const host = options.host;
    const initial = host?.initial;
    current = initial?.source ?? options.source;
    const wrapped: ApprovalServerOptions = {
      ...options,
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
  sendStatus();

  let started: { ok: true; server: UiServer } | { ok: false; failure: StopReason };
  try {
    started = await startUiServer(deps.uiDeps(startServer), undefined);
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

  const show = async (route: ShowRoute): Promise<void> => {
    if (approvalServer === undefined) return;
    if (route === 'approvals') await approvalServer.open().catch(() => false);
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
    else if (message.type === 'show') await show(message.route);
    else {
      const outcome = await invite(message.link);
      pipe.send({ v: 1, type: 'invite-result', outcome });
    }
  };
  pipe.onMessage((message) => {
    queue = queue.then(() => handle(message)).catch(() => undefined);
  });

  const every = deps.statusEveryMs ?? STATUS_EVERY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    const source = current;
    if (source !== undefined) {
      const list = await source.list().catch(() => undefined);
      if (list !== undefined && source === current) waiting = list.length;
    } else waiting = 0;
    if (stopping) return;
    sendStatus();
    timer = setTimeout(() => void tick(), every);
  };
  await tick();

  const reason = await stopped;
  if (timer !== undefined) clearTimeout(timer);
  state = 'closing';
  sendStatus();
  await queue;
  await server.close().catch(() => undefined);
  pipe.send({ v: 1, type: 'stopped', reason });
  unsubscribe();
  unguard?.();
  await pipe.close();
  return reason === 'fatal' ? HOST_EXIT_FAILED : HOST_EXIT_OK;
}
