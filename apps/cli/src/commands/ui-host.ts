// U3-c: the CLI side of the app host (08 §1 "Agents and AI apps in the app"; 04 §2.5 "Several agents
// in one app"; 06 §6; D-138; I-1, I-4, I-7).
//
// `agentlink ui` serves one agent at a time and switches between the owner's agents in the same
// process, port and session. This file opens one agent for the host through the same path every other
// command uses (`OwnerCommandDeps.open`, the M1-9k openAgent: config and folder rules, the recorded
// KeyStore, the store, and the shared folder lock of 06 §6), wires it for the pages exactly as `ui`
// did before (localUiOptions, createUiApprovalSource), and hands its `close` to the host, which closes
// it before it opens another (KeyStore isolation). The folders are reached only through
// `agentDirectory` (runtime/agent-dir.ts), so the folder and name rules stay in one place.
//
// I-4: nothing here adds an MCP tool or a route; a switch signs nothing and takes no owner presence.
// I-7: no name, label or path is logged; failures are a plain `undefined`.
//
// U3-g-b (08 §1 "with no agent yet, Welcome"; proposed, owner confirms at merge): with no agent folder
// at all (not even one being removed), `ui` starts the app host with NO open agent (`startUiWelcome`):
// the server serves Welcome and the setup-time reads only, and first run's `finish` creates the first
// agent (AgentDirectory `create`) and opens it in the same host. Only when the OS keychain can hold a
// new agent (07 §9.4; a file-KeyStore setup stays `agentlink init` in the terminal) and this build
// has the app. Nothing here signs or holds a secret.
//
// U3-g-c (08 §1 "with no agent yet, Welcome"; 06 §7; proposed, owner confirms at merge): the no-agent
// host also gets the CLI's harness desk (harness/app-desk.ts, the U3-f seam), LIST ONLY, so
// Welcome's "Pick your AI app" lists the detected apps before the first agent exists. Entry-only
// (the desk's list: only AgentLink's own entry, a foreign one is just "not ours"); nothing is
// logged. Preview, apply and disconnect stay refused with no agent open; once first run's `finish`
// opens the first agent, that agent's own full desk (localUiOptions) answers them.
//
// HOTFIX-045-REMOVE-FIRSTRUN (04 §2.5 "Removing an agent"; 06 §6): the no-agent host gets the same
// removal port as the host `ui` starts for an existing agent (ui-remove.ts uiRemovalPort), so Remove
// works in the session first run started. It is required here so no host is started without it.
// The route, its gates (session, Host, Origin, CSRF, fetch metadata, generation, owner presence and
// the signed `agent.revoke`) and the port are unchanged: the server's remove gate runs them.
import type {
  AgentDirectory,
  AgentRemovalPort,
  ApprovalServer,
  ApprovalServerEvent,
  ApprovalServerOptions,
  ApprovalServerSource,
  AppHostAgent,
  AppHostHandoffRecord,
  LocalUiAiApps,
  LocalUiAssets,
  LocalUiOptions,
} from '@4thtech-io/node';
import { createUiApprovalSource } from '../approval/ui-source.js';
import { newAgentFirstCard } from '../mcp/local-ui-wiring.js';
import type { OwnerAgent, OwnerCommandDeps } from './owner/deps.js';

/** The per-agent part of the local UI options: everything but the app's files. */
export function withoutAssets(options: LocalUiOptions): Omit<LocalUiOptions, 'assets'> {
  const copy: { -readonly [K in keyof LocalUiOptions]: LocalUiOptions[K] } = { ...options };
  delete copy.assets;
  return copy;
}

/** What the host needs to open one agent for the pages. */
export interface UiHostDeps {
  readonly owner: Pick<OwnerCommandDeps, 'open'>;
  readonly directory: AgentDirectory;
  /** The per-agent local UI wiring (local-ui-wiring.ts localUiOptions). */
  readonly localUi: (agent: OwnerAgent) => Promise<LocalUiOptions>;
  /** Unix seconds, for the approval source. */
  readonly now: () => number;
}

/**
 * Opens `name` for the app host, or undefined when it is not listed, is marked `removing` (or is in
 * the owner's revoked list), or cannot be opened. Whatever was opened is closed again on failure.
 */
export async function openUiHostAgent(
  deps: UiHostDeps,
  name: string,
): Promise<AppHostAgent | undefined> {
  const entry = await deps.directory.read(name).catch(() => undefined);
  // 04 §2.5: an agent marked `removing` is never opened as usable.
  if (entry === undefined || !entry.available || entry.removing) return undefined;
  const opened = await deps.owner.open(name).catch(() => undefined);
  if (opened?.status !== 'ok') return undefined;
  const { agent } = opened;
  try {
    // The app's files are the server's and never change on a switch.
    const localUi = withoutAssets(await deps.localUi(agent));
    const source = createUiApprovalSource(
      // The host owns the agent's lifetime; the source never closes it.
      { ...agent, close: () => Promise.resolve() },
      { now: deps.now },
    );
    return Object.freeze<AppHostAgent>({
      name: agent.name,
      label: entry.label,
      source,
      localUi,
      // U3-d: its card parts, used only when the app just created this agent (first parts).
      firstCard: newAgentFirstCard(agent),
      close: () => agent.close(),
    });
  } catch {
    await agent.close().catch(() => undefined);
    return undefined;
  }
}

/** U3-g-b: what the no-agent app host needs (tests pass doubles). */
export interface UiWelcomeDeps {
  readonly directory: AgentDirectory;
  /** True when the OS keychain can hold a new agent (selectKeyStoreBackend without file opt-in). */
  keychainUsable(): Promise<boolean>;
  /** The app's files embedded in this build. */
  assets(): LocalUiAssets;
  /** Opens an agent for the host (openUiHostAgent): the first agent, once first run created it. */
  open(name: string): Promise<AppHostAgent | undefined>;
  /** HOTFIX-045-REMOVE-FIRSTRUN: removing an agent (uiRemovalPort), as in the agent host. */
  readonly removal: AgentRemovalPort;
  /** Starts the approval server (startApprovalServer). */
  startServer(
    options: ApprovalServerOptions,
  ): Promise<Pick<ApprovalServer, 'openFirstRun' | 'openJoin' | 'close'>>;
  /** Fixed-value events (I-7). */
  readonly onEvent?: (event: ApprovalServerEvent) => void;
  /** U3-invite: the canonical link `join` checked (held in memory by the host only). */
  readonly waitingInvite?: string;
  /** U3-invite: the handoff record (~/.agentlink/app-host.json, 0600). */
  readonly handoff?: AppHostHandoffRecord;
  /** U3-g-c: the CLI's harness desk (createAiAppsDesk); the host gets its `list` only. */
  readonly aiApps?: () => LocalUiAiApps;
}

/** U3-g-b: the running no-agent app host: it always opens on the first-run page (Welcome). */
export interface UiWelcomeServer {
  readonly page: 'first-run';
  open(): Promise<boolean>;
  close(): Promise<void>;
}

/** U3-g-b: the host's source while no agent is open; the host replaces it (it never answers). */
const NO_AGENT_SOURCE: ApprovalServerSource = Object.freeze<ApprovalServerSource>({
  context: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  apply: () => Promise.reject(new Error('No agent is open.')),
});

/**
 * U3-g-b: starts the app host with no agent open, or undefined (nothing started) when any agent
 * folder exists (even one marked `removing`), the keychain cannot hold a new agent, or this build has
 * no app. The server closes whichever agent first run opened.
 */
export async function startUiWelcome(deps: UiWelcomeDeps): Promise<UiWelcomeServer | undefined> {
  const entries = await deps.directory.list().catch(() => undefined);
  if (entries === undefined || entries.length !== 0) return undefined;
  if (!(await deps.keychainUsable().catch(() => false))) return undefined;
  const assets = deps.assets();
  if (assets.files.has('index.html') !== true) return undefined;
  // U3-g-c: read-only: only the desk's list reaches the host (never its plan or agent lookup).
  const desk = deps.aiApps?.();
  const aiAppsList: Pick<LocalUiAiApps, 'list'> | undefined =
    desk === undefined ? undefined : Object.freeze({ list: () => desk.list() });
  const server = await deps.startServer({
    source: NO_AGENT_SOURCE,
    // The app's files only: no agent client, no owner setup of an agent (first run makes one).
    localUi: { assets },
    host: {
      directory: deps.directory,
      open: (name) => deps.open(name),
      // HOTFIX-045-REMOVE-FIRSTRUN: Remove in this session (the folder lock, its own open, the
      // revoked list), the same port the agent host gets.
      removal: deps.removal,
      // The real home and owner files (no override). W4-ONE-TOUCH (D-140): the desk's plan for
      // first run's own setup gate only, so one gesture creates the agent and connects its app.
      firstRun: desk === undefined ? {} : { aiApps: Object.freeze({ plan: desk.plan.bind(desk) }) },
      // U3-invite (08 §4): the invite `join` checked, held in memory by the host only.
      ...(deps.waitingInvite === undefined ? {} : { waitingInvite: deps.waitingInvite }),
      // U3-invite: the 0600 handoff record, so a later `join` hands over here.
      ...(deps.handoff === undefined ? {} : { handoff: deps.handoff }),
      // U3-g-c: Welcome's "Pick your AI app" (GET /api/ui/apps) with no agent yet.
      ...(aiAppsList === undefined ? {} : { aiAppsList }),
    },
    ...(deps.onEvent === undefined ? {} : { onEvent: deps.onEvent }),
  });
  return Object.freeze<UiWelcomeServer>({
    page: 'first-run',
    // U3-invite: openJoin goes to first run while no owner exists; first run then ends on the
    // waiting invite (the link is never in the URL).
    open: () => (deps.waitingInvite === undefined ? server.openFirstRun() : server.openJoin()),
    close: () => server.close(),
  });
}
