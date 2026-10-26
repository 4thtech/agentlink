// M1-11b-6: `init` hands a new owner to the local app's first-run page (D-120 (1); 08 §1; 04 §2.5;
// 06 §7). Called from init.ts (one call at each end of a successful run); kept apart so the init
// flow (M1-36b) and this step change independently.
//
// - In the owner's own interactive terminal (no harness marker, no `--confirm`), when owner setup
//   may be offered (a keychain agent and no owner anywhere, local-ui-wiring.ts): the agent is
//   opened, the local approval server starts with owner setup wired, and the OS browser opens the
//   one-shot session link at /first-run (`openFirstRun`). The link goes only to the OS opener: it
//   is never printed, logged, returned or put in an event. The command then waits while the owner
//   uses the page (setup, then the settings pages), until Ctrl+C or FIRST_RUN_WAIT_MS, and closes
//   the server and the agent.
// - No browser could be opened, the server could not start, or the page was closed before setup
//   finished: the step reports "not handled" and init prints the terminal way (`owner init`) as
//   before.
// - Run by an agent (no TTY, a harness marker, or `--confirm`): no server, no browser, no link.
//   When owner setup may be offered, one fixed line tells the user to run `init` in their own
//   terminal. Handing an agent the session link would let it start setup itself (G-1).
// - Commands are named with the prefix init uses (M1-36a `cliPrefix`, after the M1-36b install
//   offer), never a bare `agentlink` (M1-36e).
//
// Threat note (G-1, D-67; 04 §2.5): the server runs in this process, which a shell-capable agent
// could also start; the TTY and marker checks are UX guards, not a boundary. The first-run setup
// is the M1-11s-c route (`setupGate`), which re-checks that no owner exists on every begin and
// finish; this step adds no route and no authority, only the opener call.
import process from 'node:process';
import { createLogger, type Logger } from '@4thtech-io/log';
import {
  startApprovalServer,
  type ApprovalServer,
  type ApprovalServerOptions,
  type LocalUiOptions,
} from '@4thtech-io/node';
import { createUiApprovalSource } from '../approval/ui-source.js';
import type { CommandContext } from '../dispatch.js';
import {
  firstRunReady,
  localUiOptions,
  logOwnerSetupEvent,
  ownerSetupDone,
} from '../mcp/local-ui-wiring.js';
import { checkOwnerTerminal } from '../runtime/guards.js';
import { nodeOwnerDeps, type OwnerAgent, type OwnerCommandDeps } from './owner/deps.js';

/** How long `init` keeps the setup page served at most (proposed: 30 minutes). */
export const FIRST_RUN_WAIT_MS = 30 * 60_000;

/** Fixed text (11 §5 plain words). Nothing from a file, the page or the user is inserted. */
export const FIRST_RUN_TEXT = Object.freeze({
  opened:
    "Your browser opened the AgentLink setup page. Protect approvals there with a passkey. Keep this window open while you use the page; press Ctrl+C when you're done.",
  done: "OK       Approvals on this computer are now protected. The settings page works while this window stays open; press Ctrl+C when you're done.",
  noBrowser: "AgentLink couldn't open your browser for the setup page.",
  notFinished: "The setup page is closed, and setup wasn't finished.",
  /** `prefix`: the command as this run was started (M1-36a), never a typed value. */
  agentRun: (prefix: string): string =>
    `One step left, and you must do it yourself: run \`${prefix} init\` in your own terminal. It opens the AgentLink setup page in your browser, where you protect approvals with a passkey (or run \`${prefix} owner init\` there instead). Don't let your AI open that page or run these for you.`,
});

/** The running setup page: the approval server and the agent it serves. */
export interface FirstRunServer {
  /** Opens the browser at a one-shot /first-run link; false when no browser could be started. */
  openFirstRun(): Promise<boolean>;
  /** Stops the server and closes the agent. */
  close(): Promise<void>;
}

export interface FirstRunDeps {
  /**
   * Opens the agent and starts the approval server with owner setup wired; undefined when setup
   * may not be offered here. `onSetUp` runs when the page finished owner setup.
   */
  start(name: string, onSetUp: () => void): Promise<FirstRunServer | undefined>;
  /** Whether owner setup may be offered for this agent (no server is started). */
  available(name: string): Promise<boolean>;
  /** The longest wait, in milliseconds. */
  readonly waitMs: number;
  /** Calls `stop` on Ctrl+C; returns the unsubscribe. */
  interrupt(stop: () => void): () => void;
}

type Wait = 'setup' | 'stop' | 'time';

/**
 * The first-run step. Resolves true when the owner step was handled here (setup finished on the
 * page, or the agent-run line was printed), so init does not print the terminal way too.
 */
export async function firstRunStep(
  context: CommandContext,
  name: string,
  interactive: boolean,
  prefix: string,
  deps: FirstRunDeps = nodeFirstRunDeps(),
): Promise<boolean> {
  const { output } = context;
  if (!interactive || !checkOwnerTerminal(context.terminal).ok) {
    const offer = await deps.available(name).catch(() => false);
    if (offer) output.print(FIRST_RUN_TEXT.agentRun(prefix));
    return offer;
  }

  let onSetUp: () => void = () => undefined;
  const setUp = new Promise<Wait>((resolve) => {
    onSetUp = () => resolve('setup');
  });
  const server = await deps.start(name, () => onSetUp()).catch(() => undefined);
  if (server === undefined) return false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const opened = await server.openFirstRun().catch(() => false);
    if (!opened) {
      output.print(FIRST_RUN_TEXT.noBrowser);
      return false;
    }
    output.print(FIRST_RUN_TEXT.opened);
    const stopped = new Promise<Wait>((resolve) => {
      unsubscribe = deps.interrupt(() => resolve('stop'));
    });
    const timedOut = new Promise<Wait>((resolve) => {
      timer = setTimeout(() => resolve('time'), deps.waitMs);
    });
    // Setup first; after it the page stays served (the settings pages) until Ctrl+C or the limit.
    const first = await Promise.race([setUp, stopped, timedOut]);
    if (first !== 'setup') {
      output.print(FIRST_RUN_TEXT.notFinished);
      return false;
    }
    output.print(FIRST_RUN_TEXT.done);
    await Promise.race([stopped, timedOut]);
    return true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe?.();
    await server.close().catch(() => undefined);
  }
}

/** The outside world of the production step (IR-M1-11b-6-1 L-2: tests pass doubles). */
export interface FirstRunSeams {
  readonly owner: Pick<OwnerCommandDeps, 'open'>;
  /** The `localUi` options for the opened agent (local-ui-wiring.ts). */
  localUi(agent: OwnerAgent): Promise<LocalUiOptions>;
  startServer(options: ApprovalServerOptions): Promise<ApprovalServer>;
  readonly logger: Logger;
}

/** The production step: the OS user's home, the OS keychain, the OS browser opener. */
export function nodeFirstRunDeps(seams: Partial<FirstRunSeams> = {}): FirstRunDeps {
  const owner = seams.owner ?? nodeOwnerDeps();
  const logger: Logger = seams.logger ?? createLogger({ name: 'init' });
  const uiOptions = seams.localUi ?? ((agent: OwnerAgent) => localUiOptions(agent));
  const startServer = seams.startServer ?? startApprovalServer;
  return Object.freeze<FirstRunDeps>({
    available: async (name) => {
      const opened = await owner.open(name);
      if (opened.status !== 'ok') return false;
      try {
        return firstRunReady(await uiOptions(opened.agent));
      } finally {
        await opened.agent.close();
      }
    },
    start: async (name, onSetUp) => {
      const opened = await owner.open(name);
      if (opened.status !== 'ok') return undefined;
      const { agent } = opened;
      try {
        const localUi = await uiOptions(agent);
        // No owner setup to offer, or no app in this build (the page would be a 404).
        if (!firstRunReady(localUi)) {
          await agent.close();
          return undefined;
        }
        const source = createUiApprovalSource(
          // The step owns the agent's lifetime; the source never closes it.
          { ...agent, close: () => Promise.resolve() },
          { now: () => Math.floor(Date.now() / 1000) },
        );
        const server = await startServer({
          source,
          localUi,
          // Fixed values only (ApprovalServerEvent, I-7).
          onEvent: (event) => {
            logger.debug('approval ui event', { ...event });
            logOwnerSetupEvent(logger, event);
            if (ownerSetupDone(event)) onSetUp();
          },
        });
        return Object.freeze<FirstRunServer>({
          openFirstRun: () => server.openFirstRun(),
          close: async () => {
            await server.close().catch(() => undefined);
            await agent.close();
          },
        });
      } catch (error) {
        await agent.close().catch(() => undefined);
        throw error;
      }
    },
    waitMs: FIRST_RUN_WAIT_MS,
    interrupt: (stop) => {
      process.once('SIGINT', stop);
      return () => {
        process.off('SIGINT', stop);
      };
    },
  });
}
