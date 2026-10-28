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
import type { AgentDirectory, AppHostAgent, LocalUiOptions } from '@4thtech-io/node';
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
