// `agentlink ui` (M1-11b-9; 08 §1 "`agentlink ui` opens it manually"; 04 §2.5; 11 §5): opens the
// local app on demand, in the owner's own interactive terminal.
//
// - In that terminal: the agent is opened, the local approval server starts, and the OS browser
//   opens the one-shot session link at the Activity page, or at the first-run page while no owner
//   exists (the same owner-setup rule as `init`, local-ui-wiring.ts). The link goes only to the OS
//   opener (`openActivity` / `openFirstRun`): it is never printed, logged, returned or put in an
//   event. The command serves until Ctrl+C or UI_WAIT_MS, then closes the server and the agent.
// - Run by an agent (no TTY, or a harness marker): one fixed line tells the user to run the command
//   in their own terminal, named with the CLI prefix (M1-36e). No agent is opened, no server starts,
//   no link exists. Handing an agent the session link would let it use the page (G-1).
// - Not an MCP tool: no tool returns or opens this page (I-4).
//
// U3-c (D-138, 08 §1): the served process is the app host. It starts with this agent and switches
// between the owner's agents in the same process, port and session (ui-host.ts; node app-host.ts);
// a switch signs nothing and takes no owner presence. Its server closes whichever agent is open.
//
// Threat note (G-1, D-67; 04 §2.5): the TTY and marker checks are UX guards, not a boundary; a
// shell-capable agent as the same OS user could start the server itself. This step adds no route and
// no authority: owner actions on the pages still need the owner's presence (passkey or code) and an
// owner signature, and first-run setup is the `setupGate` route that re-checks that no owner exists.
import { homedir } from 'node:os';
import process from 'node:process';
import { createLogger, type Logger } from '@4thtech-io/log';
import { startApprovalServer } from '@4thtech-io/node';
import { createUiApprovalSource } from '../approval/ui-source.js';
import { EXIT_FAILED, EXIT_OK, type CommandContext, type CommandHandler } from '../dispatch.js';
import { localUiOptions, logOwnerSetupEvent } from '../mcp/local-ui-wiring.js';
import { cliPrefix } from '../runtime/cli-prefix.js';
import { agentDirectory, listAgentNames } from '../runtime/agent-dir.js';
import { DEFAULT_AGENT_NAME } from '../runtime/agent-name.js';
import { checkOwnerTerminal } from '../runtime/guards.js';
import { AGENT_CHOICE_TEXT, pickAgent, selectAgent } from './agent-choice.js';
import { sharedLineReader } from './init.js';
import { nodeOwnerDeps } from './owner/deps.js';
import { openUiHostAgent, withoutAssets, type UiHostDeps } from './ui-host.js';

/** How long `ui` serves the pages at most (proposed: 30 minutes, as for the first-run step). */
export const UI_WAIT_MS = 30 * 60_000;

/** Fixed text (11 §5 plain words). Nothing from a file, the page or the user is inserted. */
export const UI_TEXT = Object.freeze({
  opened:
    "Your browser opened your AgentLink activity page. Keep this window open while you use it; press Ctrl+C when you're done.",
  openedSetup:
    "Your browser opened the AgentLink setup page. Protect approvals there with a passkey. Keep this window open while you use the page; press Ctrl+C when you're done.",
  noBrowser: "AgentLink couldn't open your browser.",
  /** `prefix`: the command as this run was started (M1-36a), never a typed value. */
  notReady: (prefix: string): string =>
    `AgentLink isn't set up here yet. Run \`${prefix} init\` in your own terminal first.`,
  /** M1-UX-MULTI-AGENT: no `--agent` and several agents here: the names follow on the next line. */
  moreThanOne: (prefix: string): string =>
    `This computer has more than one AgentLink agent. Run \`${prefix} ui --agent <name>\` with the agent you want to open.`,
  agentRun: (prefix: string): string =>
    `You must do this yourself: run \`${prefix} ui\` in your own terminal. It opens your AgentLink pages in your browser. Don't let your AI open them or run this for you.`,
});

export type UiPage = 'activity' | 'first-run';

/** The running pages: the approval server and the agent it serves. */
export interface UiServer {
  /** Which page `open` goes to: first-run while no owner exists, otherwise Activity. */
  readonly page: UiPage;
  /** Opens the browser at a one-shot link to `page`; false when no browser could be started. */
  open(): Promise<boolean>;
  /** Stops the server and closes the agent. */
  close(): Promise<void>;
}

export interface UiDeps {
  /** Opens the agent and starts the server; undefined when the agent is not set up here. */
  start(name: string | undefined): Promise<UiServer | undefined>;
  /** M1-UX-MULTI-AGENT: the local agent names on this computer (absent: not looked for). */
  agents?(): Promise<readonly string[]>;
  /** Reads one typed line (for the numbered pick). */
  readLine?(): Promise<string>;
  /** The longest serve time, in milliseconds. */
  readonly waitMs: number;
  /** Calls `stop` on Ctrl+C; returns the unsubscribe. */
  interrupt(stop: () => void): () => void;
}

/** The command. Returns the process exit code. */
export async function uiStep(
  context: CommandContext,
  deps: UiDeps = nodeUiDeps(),
  prefix: string = cliPrefix(),
): Promise<number> {
  const { output } = context;
  if (!checkOwnerTerminal(context.terminal).ok) {
    output.printError(UI_TEXT.agentRun(prefix));
    return EXIT_FAILED;
  }
  let agent = context.parsed.agent;
  if (agent === undefined && deps.agents !== undefined) {
    const selection = selectAgent(await deps.agents().catch(() => []));
    if (selection.kind === 'one') agent = selection.name;
    else if (selection.kind === 'choose') {
      const picked =
        deps.readLine === undefined
          ? undefined
          : await pickAgent((text) => output.print(text), selection.names, deps.readLine);
      if (picked === undefined) {
        output.printError(UI_TEXT.moreThanOne(prefix));
        output.printError(AGENT_CHOICE_TEXT.namesLine(selection.names));
        return EXIT_FAILED;
      }
      agent = picked;
    }
  }
  const server = await deps.start(agent).catch(() => undefined);
  if (server === undefined) {
    output.printError(UI_TEXT.notReady(prefix));
    return EXIT_FAILED;
  }
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const opened = await server.open().catch(() => false);
    if (!opened) {
      output.printError(UI_TEXT.noBrowser);
      return EXIT_FAILED;
    }
    output.print(server.page === 'first-run' ? UI_TEXT.openedSetup : UI_TEXT.opened);
    const stopped = new Promise<void>((resolve) => {
      unsubscribe = deps.interrupt(resolve);
    });
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deps.waitMs);
    });
    await Promise.race([stopped, timedOut]);
    return EXIT_OK;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe?.();
    await server.close().catch(() => undefined);
  }
}

/** The production step: the OS user's home, the OS keychain, the OS browser opener. */
export function nodeUiDeps(): UiDeps {
  const owner = nodeOwnerDeps();
  const logger: Logger = createLogger({ name: 'ui' });
  return Object.freeze<UiDeps>({
    agents: () => listAgentNames(homedir()),
    readLine: sharedLineReader(),
    start: async (name) => {
      // U3-c: the folders only through the AgentDirectory seam; a `removing` agent never opens.
      const directory = agentDirectory(homedir());
      const entry = await directory.read(name ?? DEFAULT_AGENT_NAME).catch(() => undefined);
      if (entry?.removing === true) return undefined;
      const opened = await owner.open(name);
      if (opened.status !== 'ok') return undefined;
      const { agent } = opened;
      try {
        const localUi = await localUiOptions(agent);
        // No app in this build: the pages would be a 404.
        if (localUi.assets?.files.has('index.html') !== true) {
          await agent.close();
          return undefined;
        }
        const page: UiPage = localUi.ownerSetup === undefined ? 'activity' : 'first-run';
        const source = createUiApprovalSource(
          // This step owns the agent's lifetime; the source never closes it.
          { ...agent, close: () => Promise.resolve() },
          { now: () => Math.floor(Date.now() / 1000) },
        );
        const now = (): number => Math.floor(Date.now() / 1000);
        const hostDeps: UiHostDeps = {
          owner,
          directory,
          localUi: (opened) => localUiOptions(opened),
          now,
        };
        const initialUi = withoutAssets(localUi);
        const server = await startApprovalServer({
          source,
          localUi,
          // U3-c: the app host; it owns the agent from here and closes whichever is open.
          host: {
            directory,
            initial: {
              name: agent.name,
              label: entry?.label ?? agent.name,
              source,
              localUi: initialUi,
              close: () => agent.close(),
            },
            open: (other) => openUiHostAgent(hostDeps, other),
          },
          // Fixed values only (ApprovalServerEvent, I-7).
          onEvent: (event) => {
            logger.debug('approval ui event', { ...event });
            logOwnerSetupEvent(logger, event);
          },
        });
        return Object.freeze<UiServer>({
          page,
          open: () => (page === 'first-run' ? server.openFirstRun() : server.openActivity()),
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
    waitMs: UI_WAIT_MS,
    interrupt: (stop) => {
      process.once('SIGINT', stop);
      return () => {
        process.off('SIGINT', stop);
      };
    },
  });
}

/** The registered handler. */
export const uiHandler: CommandHandler = (context) => uiStep(context);
