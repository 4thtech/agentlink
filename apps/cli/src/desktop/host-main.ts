// WP-D3: the desktop host's start-up (host.ts runs it). Before anything is opened it requires the
// shell's pipe on fd 3 (pipe.ts probePipeFd) and no AI app marker in the environment (guards.ts; a
// UX guard, G-1). Without them it prints ONE fixed line to stderr and exits 1: no agent is opened,
// no server starts, no session link exists. With them it wires the production pieces (nodeUiDeps
// with the link-sink server, `join`'s invite checks and handoff) and runs host-core.ts.
import { homedir } from 'node:os';
import process from 'node:process';
import { checkInviteLink, resolveInviteLink, shortInviteFetcher } from '@4thtech-io/core';
import { desktopNativeHelper, startApprovalServerWithLinkSink } from '@4thtech-io/node';
import { DROP_DEFAULT_ENDPOINT } from '@4thtech-io/storage';
import { nodeUiDeps, onStopSignals } from '../commands/ui.js';
import { sendHandoff } from '../runtime/app-host-record.js';
import {
  processStartedAt,
  removeDesktopAlertsRecord,
  writeDesktopAlertsRecord,
} from '../runtime/desktop-alerts-record.js';
import { guardedDropFetch } from '../runtime/files.js';
import { harnessMarkerSet, type Env } from '../runtime/guards.js';
import { createOutput } from '../output.js';
import { cliLogger } from '../runtime/log-level.js';
import { guardProcess } from '../runtime/ui-lifecycle.js';
import {
  HOST_EXIT_FAILED,
  runDesktopHost,
  type DesktopHostDeps,
  type DesktopInviteDeps,
} from './host-core.js';
import { DESKTOP_PIPE_FD, openDesktopPipe, probePipeFd, type DesktopPipe } from './pipe.js';

/** Fixed text (11 §5 plain words). Nothing from the environment or the pipe is inserted. */
export const DESKTOP_HOST_TEXT = Object.freeze({
  notInApp:
    'This part of AgentLink runs only inside the AgentLink app. Open the AgentLink app instead.',
});

export interface DesktopHostMainDeps {
  readonly env: Env;
  /** Looks at fd 3 (probePipeFd). */
  probe(): ReturnType<typeof probePipeFd>;
  /** Writes one line to stderr. */
  printError(line: string): void;
  /** Opens the pipe on fd 3 (openDesktopPipe). */
  openPipe(): DesktopPipe;
  /** The production host deps over that pipe. */
  hostDeps(pipe: DesktopPipe): DesktopHostDeps;
  /** Runs the host (runDesktopHost). */
  run(deps: DesktopHostDeps): Promise<number>;
}

/** The start-up checks, then the host. Returns the exit code. */
export async function desktopHostMain(deps: DesktopHostMainDeps): Promise<number> {
  if (harnessMarkerSet(deps.env) || deps.probe() !== 'ok') {
    deps.printError(DESKTOP_HOST_TEXT.notInApp);
    return HOST_EXIT_FAILED;
  }
  // WIN-DESK-1: net.Socket checks the fd type again and throws when it is not a pipe or socket.
  let pipe: DesktopPipe;
  try {
    pipe = deps.openPipe();
  } catch {
    deps.printError(DESKTOP_HOST_TEXT.notInApp);
    return HOST_EXIT_FAILED;
  }
  return deps.run(deps.hostDeps(pipe));
}

/** One fixed diagnostic line on stderr (DESK-NATIVE-DEBUG). */
export function writeDiagnosticLine(line: string): void {
  try {
    // The CLI's user-output channel (output.ts): one line on stderr.
    createOutput().printError(line);
  } catch {
    // Nothing to do: diagnostics never change the outcome.
  }
}

/** The production host deps: the OS user's home and keychain, links only to `pipe`. */
export function nodeDesktopHostDeps(pipe: DesktopPipe): DesktopHostDeps {
  const logger = cliLogger('desktop', process.env);
  const fetchShort = shortInviteFetcher({
    endpoint: DROP_DEFAULT_ENDPOINT,
    fetch: guardedDropFetch(DROP_DEFAULT_ENDPOINT, (request) => globalThis.fetch(request)),
  });
  // A rejected pipe line is counted with a fixed message only (never its content, I-7).
  pipe.onReject(() => logger.debug('desktop pipe rejected'));
  return Object.freeze<DesktopHostDeps>({
    pipe,
    uiDeps: (startServer) => nodeUiDeps({ startServer }),
    // DESK-D12c: Touch ID / Windows Hello for approvals, when the app's presence helper is in place
    // next to the bundled Node (a fixed path, never from the environment or the pipe).
    // DESK-NATIVE-DEBUG: its one fixed diagnostic line per outcome goes to stderr, which the shell's
    // redacting core log keeps (apps/desktop/src/main/core-log.ts). Fixed tokens only.
    startServer: (options, sink) => {
      // DESK-TOUCHID-FIX: the helper's secure-input note becomes the same kind of fixed line.
      const nativePresence = desktopNativeHelper(
        process.execPath,
        process.platform,
        undefined,
        writeDiagnosticLine,
      );
      return startApprovalServerWithLinkSink(
        nativePresence === undefined
          ? options
          : { ...options, nativePresence, diagnose: writeDiagnosticLine },
        sink,
      );
    },
    invite: Object.freeze<DesktopInviteDeps>({
      resolve: (link: string) => resolveInviteLink(link, fetchShort),
      check: (link: string, nowSeconds: number) => checkInviteLink(link, nowSeconds),
      now: () => Math.floor(Date.now() / 1000),
      handoff: (record, link) =>
        sendHandoff(
          { pid: record.pid, port: record.port, handoffToken: record.handoffToken },
          link,
        ),
    }),
    // N7: while this host runs, the desktop app owns the OS notifications for its open ID (no
    // osascript from mcp for that ID; every other ID keeps it).
    alertsRecord: Object.freeze({
      write: (scope: string) =>
        writeDesktopAlertsRecord(homedir(), {
          pid: process.pid,
          started: processStartedAt(),
          id: scope,
        }),
      remove: () => removeDesktopAlertsRecord(homedir(), process.pid),
    }),
    interrupt: (stop) => onStopSignals(stop),
    guard: (onFatal) => guardProcess({ log: logger, onFatal }),
  });
}

/** The production start-up (host.ts). */
export function nodeDesktopHostMainDeps(): DesktopHostMainDeps {
  return Object.freeze<DesktopHostMainDeps>({
    env: process.env,
    probe: () => probePipeFd(DESKTOP_PIPE_FD),
    // The CLI's user-output channel (output.ts): the one fixed line, on stderr.
    printError: (line) => createOutput().printError(line),
    openPipe: () => openDesktopPipe(DESKTOP_PIPE_FD),
    hostDeps: nodeDesktopHostDeps,
    run: runDesktopHost,
  });
}
