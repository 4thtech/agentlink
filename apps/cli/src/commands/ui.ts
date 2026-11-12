// `agentlink ui` (M1-11b-9; 08 §1 "`agentlink ui` opens it manually"; 04 §2.5; 11 §5): opens the
// local app on demand, in the owner's own interactive terminal.
//
// - In that terminal: the agent is opened, the local approval server starts, and the OS browser
//   opens the one-shot session link at Home (U3-a, D-138; 08 §1), or at the first-run page while no
//   owner exists (the same owner-setup rule as `init`, local-ui-wiring.ts). The link goes only to the
//   OS opener (`openHome` / `openFirstRun`): it is never printed, logged, returned or put in an
//   event. The command serves until Ctrl+C or UI_WAIT_MS, then closes the server and the agent.
// - Run by an agent (no TTY, or a harness marker): one fixed line tells the user to run the command
//   in their own terminal, named with the CLI prefix (M1-36e). No agent is opened, no server starts,
//   no link exists. Handing an agent the session link would let it use the page (G-1).
// - Not an MCP tool: no tool returns or opens this page (I-4).
//
// U3-b (USABILITY-WAVE-3 §7.4): it never asks which agent: the last used one (app.json), else the one an
// AI app serves (default first), else the first by name (current-agent.ts). `--agent` stays, as Advanced.
//
// U3-c (D-138, 08 §1): the served process is the app host. It starts with this agent and switches
// between the owner's agents in the same process, port and session (ui-host.ts; node app-host.ts);
// a switch signs nothing and takes no owner presence. Its server closes whichever agent is open.
//
// U3-g-b (08 §1 "with no agent yet, Welcome"): with no agent folder at all, the app host starts with
// no agent open and the browser opens the first-run page (Welcome); first run creates the first agent
// in the same host (ui-host.ts startUiWelcome). Run by an AI, the fixed line is unchanged (D-39).
//
// Threat note (G-1, D-67; 04 §2.5): the TTY and marker checks are UX guards, not a boundary; a
// shell-capable agent as the same OS user could start the server itself. This step adds no route and
// no authority: owner actions on the pages still need the owner's presence (passkey or code) and an
// owner signature, and first-run setup is the `setupGate` route that re-checks that no owner exists.
import { homedir } from 'node:os';
import process from 'node:process';
import type { Logger } from '@4thtech-io/log';
import { cliLogger } from '../runtime/log-level.js';
import {
  hasOwnerOnMachine,
  probeOsKeychain,
  selectKeyStoreBackend,
  startApprovalServer,
} from '@4thtech-io/node';
import { createAiAppsDesk } from '../harness/app-desk.js';
import { embeddedLocalUiAssets } from '../mcp/local-ui-assets.js';
import { createUiApprovalSource } from '../approval/ui-source.js';
import { EXIT_FAILED, EXIT_OK, type CommandContext, type CommandHandler } from '../dispatch.js';
import { localUiOptions, logOwnerSetupEvent } from '../mcp/local-ui-wiring.js';
import { cliPrefix } from '../runtime/cli-prefix.js';
import { agentDirectory } from '../runtime/agent-dir.js';
import { DEFAULT_AGENT_NAME } from '../runtime/agent-name.js';
import { checkOwnerTerminal } from '../runtime/guards.js';
import { appServes, chooseCurrentAgent } from './current-agent.js';
import { nodeOwnerDeps } from './owner/deps.js';
import { hostUiOf, openUiHostAgent, startUiWelcome, type UiHostDeps } from './ui-host.js';
import { uiRemovalPort } from './ui-remove.js';
import { removeAppHostRecord, writeAppHostRecord } from '../runtime/app-host-record.js';
import { writeLastExit, type LastExitReason } from '../runtime/last-exit.js';
import { guardProcess, type FatalReason } from '../runtime/ui-lifecycle.js';
import { cliVersion } from '../runtime/cli-version.js';
import {
  OPEN_CHECK_MS,
  openAndWatch,
  setupOpenedLine,
  stdinEnter,
  type OpenWatch,
} from '../runtime/open-watch.js';

/**
 * How long `ui` keeps serving with nobody using it (06 §5 sets "a time limit (30 minutes)"; F25: it
 * counts from the last use, not from the start, so a page in use is never cut off). Use is any page
 * request or an open page (live stream).
 */
export const UI_WAIT_MS = 30 * 60_000;

/** While a page is open, `ui` looks again this often, so a closed tab starts the idle time soon. */
const OPEN_PAGE_CHECK_MS = 15_000;

/** R1: why `ui` could not start. */
export type StartFailure =
  'no_owner' | 'no_ids' | 'only_removing' | 'port' | 'keychain' | 'open' | 'failed';

const START_EXIT: Readonly<Record<StartFailure, LastExitReason>> = Object.freeze({
  no_owner: 'start_no_owner',
  no_ids: 'start_no_ids',
  only_removing: 'start_removing',
  port: 'start_port',
  keychain: 'start_keychain',
  open: 'start_open',
  failed: 'start_failed',
});

/** Bind failures: the local page cannot be served (a fixed set of codes, never the text). */
const PORT_CODES = new Set(['EADDRINUSE', 'EADDRNOTAVAIL', 'EACCES']);

function isPortError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : '';
  return typeof code === 'string' && PORT_CODES.has(code);
}

/** Fixed text (11 §5 plain words). Nothing from a file, the page or the user is inserted. */
export const UI_TEXT = Object.freeze({
  /** F40: "Opening", never "opened": the OS opener cannot prove a page loaded (open-watch.ts). */
  opened:
    "Opening AgentLink Home in your browser… Keep this window open while you use it; press Ctrl+C when you're done.",
  /** F41: the platform's word for the gesture (Touch ID, Windows Hello, a passkey); no "setup page". */
  openedSetup: setupOpenedLine(process.platform),
  /** R1: no browser could be started, but the app is healthy: it keeps serving. */
  noBrowser:
    "AgentLink couldn't open your browser, but it's still running. Keep this window open; press Ctrl+C when you're done.",
  noBrowserServing: (origin: string): string =>
    `AgentLink couldn't open your browser, but it's still running at ${origin}. Keep this window open; press Ctrl+C when you're done.`,
  /** R1: a problem AgentLink could not carry on through (the run ended, cleanly). */
  closedProblem: (prefix: string): string =>
    `AgentLink closed because of an unexpected problem. Run \`${prefix}\` to open it again, or \`${prefix} doctor\` if it keeps happening.`,
  /** F25: Ctrl+C, closing the terminal or a stop signal: one plain line, no link. */
  closed: (prefix: string): string => `AgentLink closed. Run \`${prefix}\` to open it again.`,
  /** F25: the idle limit (UI_WAIT_MS) ended the run. */
  closedIdle: (prefix: string): string =>
    `AgentLink closed after 30 minutes without use. Run \`${prefix}\` to open it again.`,
  /** `prefix`: the command as this run was started (M1-36a), never a typed value. */
  notReady: (prefix: string): string =>
    `AgentLink isn't set up here yet. Run \`${prefix} init\` in your own terminal first.`,
  /** R1: why it could not start, one line each; only `no_owner` asks for init. */
  startFailure: Object.freeze<Record<StartFailure, (prefix: string) => string>>({
    no_owner: (prefix) =>
      `AgentLink isn't set up here yet. Run \`${prefix} init\` in your own terminal first.`,
    no_ids: (prefix) =>
      `AgentLink couldn't open the app to make your first ID. Run \`${prefix} doctor\` to see why.`,
    only_removing: (prefix) =>
      `Some of your IDs were only half removed, so AgentLink couldn't start. Run \`${prefix} doctor\` to see what is left.`,
    port: (prefix) =>
      `AgentLink couldn't start its page on this computer. Close any other open AgentLink, then run \`${prefix}\` again.`,
    keychain: (prefix) =>
      `AgentLink can't reach your computer's keychain. Unlock it, then run \`${prefix}\` again.`,
    open: (prefix) =>
      `AgentLink couldn't open your ID. Your IDs are still here. Run \`${prefix} doctor\` to see why.`,
    failed: (prefix) =>
      `AgentLink couldn't start. Your IDs are still here. Run \`${prefix} doctor\` to see why.`,
  }),
  agentRun: (prefix: string): string =>
    `You must do this yourself: run \`${prefix} ui\` in your own terminal. It opens your AgentLink pages in your browser. Don't let your AI open them or run this for you.`,
});

export type UiPage = 'home' | 'first-run';

/** The two openers `ui` uses (ApprovalServer): each hands the OS opener a fixed one-shot link. */
export interface UiOpeners {
  openHome(): Promise<boolean>;
  openFirstRun(): Promise<boolean>;
}

/** U3-a (D-138): Home with an owner, first run while no owner exists. Nothing reaches the link. */
export function openUiPage(page: UiPage, server: UiOpeners): Promise<boolean> {
  return page === 'first-run' ? server.openFirstRun() : server.openHome();
}

/** The running pages: the approval server and the agent it serves. */
export interface UiServer {
  /** Which page `open` goes to: first-run while no owner exists, otherwise Home. */
  readonly page: UiPage;
  /** Opens the browser at a one-shot link to `page`; false when no browser could be started. */
  open(): Promise<boolean>;
  /** R1: the local address (`http://localhost:<port>`, never a session link), for when no browser opens. */
  readonly origin?: string;
  /**
   * F25: whether the app is in use (absent: only the time since start counts). `lastAt` is a time in
   * ms of the last page request; `openStreams` the open pages.
   */
  readonly activity?: { lastAt(): number; openStreams(): number; linksUsed?(): number };
  /** Stops the server and closes the agent. */
  close(): Promise<void>;
}

/** U3-invite: what `agentlink join` adds to a `ui` start (08 §4). */
export interface UiJoin {
  /** The canonical link `join` checked; the host holds it in memory only (never logged). */
  readonly invite: string;
  /** The fixed line printed once the browser opened. */
  readonly opened: string;
}

export interface UiDeps {
  /**
   * Opens the agent and starts the server; undefined when the agent is not set up here. U3-invite:
   * with `invite`, the host holds it as the waiting invite and `open` goes to first run (no owner
   * yet) or the join screen.
   */
  start(
    name: string | undefined,
    options?: { readonly invite?: string },
  ): Promise<UiServer | undefined>;
  /** U3-b: the local agent names on this computer (absent: not looked for). */
  agents?(): Promise<readonly string[]>;
  /** U3-b: the last used agent (app.json), if any. */
  lastUsed?(): Promise<string | undefined>;
  /** U3-b: whether an AI app already starts this agent. */
  serves?(name: string): Promise<boolean>;
  /**
   * U3-g-b: with no agent at all, starts the app host with no agent open (Welcome and first run);
   * undefined when it cannot (an agent folder exists, no usable keychain, no app in this build).
   */
  startWelcome?(options?: { readonly invite?: string }): Promise<UiServer | undefined>;
  /** The longest time with no use, in milliseconds (F25: idle, not wall-clock). */
  readonly waitMs: number;
  /** Calls `stop` on Ctrl+C, SIGTERM or SIGHUP (with the signal's name); returns the unsubscribe. */
  interrupt(stop: (signal?: string) => void): () => void;
  /**
   * R1: why `start` found nothing to start (no owner, no IDs, only half-removed IDs, no keychain …).
   * Absent: the line for "not set up here yet".
   */
  diagnose?(): Promise<StartFailure>;
  /** R1: stray background errors keep the host up; `onFatal` ends it. Returns the unsubscribe. */
  guard?(onFatal: (reason: FatalReason) => void): () => void;
  /** R1: writes why this run closed (~/.agentlink/last-exit.json). Must not throw. */
  recordExit?(reason: LastExitReason): Promise<void>;
  /** F40: Enter in this terminal (absent: no "press Enter to try again"). Returns the unsubscribe. */
  onEnter?(press: () => void): () => void;
  /** F40: how long the page has to use its link before the follow-up (default OPEN_CHECK_MS). */
  readonly openCheckMs?: number;
}

/** The command. Returns the process exit code. */
export async function uiStep(
  context: CommandContext,
  deps: UiDeps = nodeUiDeps(),
  prefix: string = cliPrefix(),
): Promise<number> {
  if (!checkOwnerTerminal(context.terminal).ok) {
    context.output.printError(UI_TEXT.agentRun(prefix));
    return EXIT_FAILED;
  }
  return serveUi(context, deps, prefix);
}

/**
 * The served part of `ui`, after the terminal check (U3-invite: shared with `join`, which passes
 * the checked invite). Picks the agent, starts the app host, opens the browser and serves until
 * Ctrl+C or UI_WAIT_MS.
 */
export async function serveUi(
  context: CommandContext,
  deps: UiDeps,
  prefix: string,
  join?: UiJoin,
): Promise<number> {
  const { output } = context;
  let agent = context.parsed.agent;
  let none = false;
  if (agent === undefined && deps.agents !== undefined) {
    // U3-b (USABILITY-WAVE-3 §7.4): never asked. The last used agent, else the one an AI app
    // serves (`default` first), else the first by name.
    const names = await deps.agents().catch(() => undefined);
    none = names !== undefined && names.length === 0;
    const last = await deps.lastUsed?.().catch(() => undefined);
    const chosen = await chooseCurrentAgent(
      names ?? [],
      last,
      (name) => deps.serves?.(name) ?? Promise.resolve(false),
    );
    // `default` is opened the way every command without `--agent` opens it.
    if (chosen !== undefined && chosen !== DEFAULT_AGENT_NAME) agent = chosen;
  }
  const startOptions = join === undefined ? {} : { invite: join.invite };
  // U3-g-b (08 §1): no agent at all: the app opens on Welcome, with no agent open yet. U3-invite:
  // with an invite, first run then ends on "Accept {name}'s invite?" (08 §4).
  let server: UiServer | undefined =
    none && deps.startWelcome !== undefined
      ? await deps.startWelcome(startOptions).catch(() => undefined)
      : undefined;
  let thrown: unknown;
  server ??= await deps.start(agent, startOptions).catch((error: unknown) => {
    thrown = error;
    return undefined;
  });
  if (server === undefined) {
    // R1: say what went wrong; "run init" only when nothing is set up. Nothing from the error is shown.
    const failure: StartFailure = isPortError(thrown)
      ? 'port'
      : thrown === undefined
        ? await (deps.diagnose?.() ?? Promise.resolve('no_owner' as const)).catch(
            () => 'failed' as const,
          )
        : await (deps.diagnose?.() ?? Promise.resolve('failed' as const)).catch(
            () => 'failed' as const,
          );
    output.printError(UI_TEXT.startFailure[failure](prefix));
    await deps.recordExit?.(START_EXIT[failure]);
    return EXIT_FAILED;
  }
  let unsubscribe: (() => void) | undefined;
  let unguard: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watch: OpenWatch | undefined;
  try {
    const fatal = new Promise<FatalReason>((resolve) => {
      unguard = deps.guard?.(resolve);
    });
    // F40: "Opening…", then, if no one-shot link is used in time, "press Enter to try again".
    // R1: a browser that will not open does not stop a healthy host.
    const linksUsed = server.activity?.linksUsed?.bind(server.activity);
    watch = await openAndWatch(
      {
        open: () => server.open(),
        linksUsed,
        print: (line) => output.print(line),
        onEnter: deps.onEnter?.bind(deps),
        checkMs: deps.openCheckMs ?? OPEN_CHECK_MS,
      },
      {
        opened:
          join !== undefined
            ? join.opened
            : server.page === 'first-run'
              ? UI_TEXT.openedSetup
              : UI_TEXT.opened,
        failed:
          server.origin === undefined ? UI_TEXT.noBrowser : UI_TEXT.noBrowserServing(server.origin),
      },
    );
    const stopped = new Promise<string | undefined>((resolve) => {
      unsubscribe = deps.interrupt(resolve);
    });
    const idle = new Promise<'idle'>((resolve) => {
      const started = Date.now();
      let seenOpen = started;
      const check = (): void => {
        const used = server.activity;
        const open = used?.openStreams() ?? 0;
        // An open page is use; the idle time counts from the last time one was seen (or any request).
        if (open > 0) seenOpen = Date.now();
        const last = Math.max(started, seenOpen, used?.lastAt() ?? started);
        const remaining = deps.waitMs - (Date.now() - last);
        if (remaining <= 0) {
          resolve('idle');
          return;
        }
        timer = setTimeout(check, open > 0 ? Math.min(remaining, OPEN_PAGE_CHECK_MS) : remaining);
      };
      timer = setTimeout(check, deps.waitMs);
    });
    const reason = await Promise.race([
      stopped.then((signal) => ({ kind: 'stop' as const, signal })),
      idle.then(() => ({ kind: 'idle' as const })),
      fatal.then((why) => ({ kind: 'fatal' as const, why })),
    ]);
    if (reason.kind === 'fatal') {
      output.print(UI_TEXT.closedProblem(prefix));
      await deps.recordExit?.(reason.why);
      return EXIT_FAILED;
    }
    output.print(reason.kind === 'idle' ? UI_TEXT.closedIdle(prefix) : UI_TEXT.closed(prefix));
    await deps.recordExit?.(
      reason.kind === 'idle'
        ? 'idle'
        : reason.signal === 'SIGTERM'
          ? 'sigterm'
          : reason.signal === 'SIGHUP'
            ? 'sighup'
            : 'ctrl_c',
    );
    return EXIT_OK;
  } finally {
    watch?.stop();
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe?.();
    unguard?.();
    await server.close().catch(() => undefined);
  }
}

/** F40: the production Enter, only while standard input is a terminal. */
function optionalEnter(): Pick<UiDeps, 'onEnter'> {
  const enter = stdinEnter();
  return enter === undefined ? {} : { onEnter: enter };
}

/**
 * F25: Ctrl+C, a closing terminal (SIGHUP) and a plain stop (SIGTERM) all end the run the same way:
 * the caller closes the server (which removes the pid-matched app-host.json) and prints one line.
 */
export function onStopSignals(stop: () => void, proc: NodeJS.Process = process): () => void {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) proc.once(signal, stop);
  return () => {
    for (const signal of signals) proc.off(signal, stop);
  };
}

/**
 * R1: why nothing could be started, from what is on this computer now (names, counts and a keychain
 * probe only; no secret is read). Never throws.
 */
export async function diagnoseStart(
  home: string,
  probes: {
    readonly keychainUsable?: () => Promise<boolean>;
    readonly ownerOnMachine?: () => Promise<boolean>;
  } = {},
): Promise<StartFailure> {
  try {
    const keychainUsable =
      probes.keychainUsable ??
      (async () => selectKeyStoreBackend(await probeOsKeychain(), { fileOptIn: false }).ok);
    const entries = await agentDirectory(home).list();
    if (entries.length > 0) {
      if (entries.every((e) => e.removing)) return 'only_removing';
      return (await keychainUsable().catch(() => false)) ? 'open' : 'keychain';
    }
    if (!(await keychainUsable().catch(() => false))) return 'keychain';
    const owner = await (probes.ownerOnMachine ?? hasOwnerOnMachine)().catch(() => false);
    return owner ? 'no_ids' : 'no_owner';
  } catch {
    return 'failed';
  }
}

/** The production step: the OS user's home, the OS keychain, the OS browser opener. */
export function nodeUiDeps(): UiDeps {
  const owner = nodeOwnerDeps();
  const logger: Logger = cliLogger('ui', process.env);
  return Object.freeze<UiDeps>({
    // U3-b: no agent that is being removed; the rest through the AgentDirectory seam.
    agents: async () =>
      (await agentDirectory(homedir()).list()).filter((e) => !e.removing).map((e) => e.name),
    lastUsed: () => agentDirectory(homedir()).readCurrent(),
    serves: appServes({
      home: homedir(),
      env: process.env,
      now: Math.floor(Date.now() / 1000),
    }),
    // U3-g-b: the no-agent app host (Welcome); first run creates the first agent from the page.
    // U3-invite: it also holds the waiting invite (`join`) and the handoff record.
    startWelcome: (welcomeOptions = {}) => {
      const directory = agentDirectory(homedir());
      const hostDeps: UiHostDeps = {
        owner,
        directory,
        localUi: (opened) => localUiOptions(opened),
        now: () => Math.floor(Date.now() / 1000),
      };
      return startUiWelcome({
        directory,
        keychainUsable: async () =>
          selectKeyStoreBackend(await probeOsKeychain(), { fileOptIn: false }).ok,
        assets: () => embeddedLocalUiAssets(),
        open: (name) => openUiHostAgent(hostDeps, name),
        // HOTFIX-045-REMOVE-FIRSTRUN: Remove works in the session first run started.
        removal: uiRemovalPort(),
        startServer: (options) => startApprovalServer(options),
        // Fixed values only (ApprovalServerEvent, I-7).
        onEvent: (event) => {
          logger.debug('approval ui event', { ...event });
          logOwnerSetupEvent(logger, event);
        },
        ...(welcomeOptions.invite === undefined ? {} : { waitingInvite: welcomeOptions.invite }),
        handoff: {
          write: (record) => writeAppHostRecord(homedir(), record),
          remove: () => removeAppHostRecord(homedir()),
        },
        // U3-g-c: the same harness desk as an open agent's (U3-f), listed read-only on Welcome.
        aiApps: () => createAiAppsDesk({ home: homedir(), env: process.env }),
      });
    },
    start: async (name, startOptions = {}) => {
      const { invite } = startOptions;
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
        const page: UiPage = localUi.ownerSetup === undefined ? 'home' : 'first-run';
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
        // WP-1: the ID open at launch carries its key-items token too, so it can be renamed (D-141).
        const initialUi = hostUiOf(agent, localUi);
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
            // F2: Welcome's "Which AI app" list also works when a switch left no agent open.
            aiAppsList: Object.freeze({
              list: () => createAiAppsDesk({ home: homedir(), env: process.env }).list(),
            }),
            // U3-e: removing an agent (the folder lock, its own open, the revoked list).
            removal: uiRemovalPort(),
            // U3-invite (08 §4): the invite `join` checked, held in memory by the host only.
            ...(invite === undefined ? {} : { waitingInvite: invite }),
            // U3-invite: the 0600 handoff record, so a later `join` hands its invite over here.
            handoff: {
              write: (record) => writeAppHostRecord(homedir(), record),
              remove: () => removeAppHostRecord(homedir()),
            },
          },
          // Fixed values only (ApprovalServerEvent, I-7).
          onEvent: (event) => {
            logger.debug('approval ui event', { ...event });
            logOwnerSetupEvent(logger, event);
          },
        });
        return Object.freeze<UiServer>({
          page,
          activity: server.activity,
          origin: server.origin,
          // U3-invite: first run (no owner yet) or the join screen; never a link with the invite.
          open: () => (invite === undefined ? openUiPage(page, server) : server.openJoin()),
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
    interrupt: (stop) => onStopSignals(stop),
    // F40: Enter in the owner's terminal tries the browser again with a fresh one-shot link.
    ...optionalEnter(),
    // R1: stray background errors are logged with a fixed code and the host keeps serving.
    guard: (onFatal) => guardProcess({ log: logger, onFatal }),
    recordExit: (reason) => writeLastExit(homedir(), { reason, version: cliVersion() }),
    diagnose: () => diagnoseStart(homedir()),
  });
}

/** The registered handler. */
export const uiHandler: CommandHandler = (context) => uiStep(context);
