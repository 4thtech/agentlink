// M1-11b-6: what the CLI wires into the local approval server's app (08 §1; D-118; D-120 (1)),
// shared by `agentlink mcp` (command.ts) and `agentlink init` (commands/first-run.ts).
//
// - The app's files embedded in this build (local-ui-assets.ts) and the agent's core client.
// - Owner setup on the first-run page (`localUi.ownerSetup`, M1-11s-c) ONLY for a keychain agent and
//   ONLY while no owner exists anywhere: no card names one, none of the `owner`, `owner-passkey` and
//   `owner-next` keychain items exists, no file-KeyStore owner file (`owner.alko`, `owner.alkp`) or
//   other file-KeyStore entry exists (IR-M1-11s-c-1 L-6), and no other agent folder exists (an agent
//   restored from a recovery kit is written before its owner seed, 04 §2.3.3; @4thtech-io/node
//   `ownerSetupAvailable`). Any doubt (a file-KeyStore
//   agent, an unreadable config, a failed check) leaves it out, and the setup routes then answer
//   503 `unavailable`. The server checks again on every begin and finish; this is the first gate.
// - The default owner files (the real home) are kept: no `ownerFiles` override is passed.
// - M1-UX-FIRSTRUN-V2 (D-130 (2)): the setup's first card carries `firstPolicy` with the agent's own
//   core owner actions, so the one first-run gesture also signs the first policy (the 06 §3
//   defaults with `~/AgentLink/Send` allowed), as `owner init` does. The real home is used (no
//   `home` override). The owner actions stay with the approval server, never with a page handler.
// - Events: an owner set up from the page is named outside the browser with one fixed line and the
//   public fingerprint (IR-M1-11s-c-1 L-2), through the redacting logger. Nothing else of an event
//   is logged at info, and no event ever holds a token, link, code or seed (I-7).
import { homedir } from 'node:os';
import type { AgentLinkClient } from '@4thtech-io/core';
import type { Logger } from '@4thtech-io/log';
import {
  ownerSetupAvailable,
  type ApprovalServerEvent,
  type FirstAgentCard,
  type KeyStoreBackendKind,
  type LocalUiAssets,
  type LocalUiOptions,
} from '@4thtech-io/node';
// The card relay list `owner init` uses (commands/owner/card-relays.ts re-exports this same list;
// the MCP side never imports an owner command, test/policy-command.test.ts).
import { DEFAULT_RELAYS } from '@4thtech-io/transport-nostr';
import { cliPrefix } from '../runtime/cli-prefix.js';
import { readAgentConfig } from '../runtime/index.js';
import { embeddedLocalUiAssets } from './local-ui-assets.js';

/** The outside world of the wiring (tests pass doubles). */
export interface LocalUiWiringDeps {
  /** The KeyStore the named agent uses, from its config; undefined when there is none. */
  keyStoreOf(name: string): Promise<KeyStoreBackendKind | undefined>;
  /** True only when no owner exists anywhere for this OS user (store-only, fail closed). */
  ownerSetupAvailable(first: FirstAgentCard): Promise<boolean>;
  /** The relay list the agent's first card commits to (card-relays.ts). */
  cardRelays(): readonly string[];
  /** The app's files (embedded in this build). */
  assets(): LocalUiAssets;
}

export function nodeLocalUiWiring(home: string = homedir()): LocalUiWiringDeps {
  return Object.freeze<LocalUiWiringDeps>({
    keyStoreOf: async (name) => (await readAgentConfig(home, name))?.config.keyStore,
    ownerSetupAvailable: (first) => ownerSetupAvailable(first),
    cardRelays: () => DEFAULT_RELAYS,
    assets: () => embeddedLocalUiAssets(),
  });
}

/** The agent the local UI serves. */
export interface LocalUiAgent {
  readonly name: string;
  readonly client: AgentLinkClient;
}

/** True when owner setup may be wired for `first` (see the header). Never throws. */
async function setupAllowed(
  name: string,
  first: FirstAgentCard,
  deps: LocalUiWiringDeps,
): Promise<boolean> {
  try {
    if ((await deps.keyStoreOf(name)) !== 'keychain') return false;
    return (await deps.ownerSetupAvailable(first)) === true;
  } catch {
    return false;
  }
}

/** The `localUi` options for the approval server of `agent` (see the header). */
export async function localUiOptions(
  agent: LocalUiAgent,
  deps: LocalUiWiringDeps = nodeLocalUiWiring(),
): Promise<LocalUiOptions> {
  const firstCard: FirstAgentCard = {
    agent: agent.client.agentId,
    name: agent.name,
    relays: deps.cardRelays(),
    identity: agent.client.identity,
  };
  const wired = await setupAllowed(agent.name, firstCard, deps);
  return {
    assets: deps.assets(),
    client: agent.client,
    ...(wired
      ? {
          ownerSetup: {
            firstCard: { ...firstCard, firstPolicy: { actions: agent.client.ownerActions } },
          },
        }
      : {}),
  };
}

/**
 * True when the first-run page can set up an owner with these options: owner setup is wired (no
 * owner anywhere, see the header) and this build has the app (otherwise the page is a 404).
 */
export function firstRunReady(localUi: LocalUiOptions): boolean {
  return localUi.ownerSetup !== undefined && localUi.assets?.files.has('index.html') === true;
}

/** True when the event says the first-run page finished owner setup. */
export function ownerSetupDone(event: ApprovalServerEvent): boolean {
  return (
    event.kind === 'owner_setup' &&
    (event.outcome === 'done' || event.outcome === 'done_unconfirmed')
  );
}

/** IR-M1-11s-c-1 L-2: the fixed line naming an owner set up from the page (public fingerprint). */
export function logOwnerSetupEvent(logger: Logger, event: ApprovalServerEvent): void {
  if (!ownerSetupDone(event) || event.kind !== 'owner_setup') return;
  if (event.fingerprint === undefined) return;
  logger.info(
    `Approvals on this computer are now protected by a new owner, set up on the setup page. If you did not do this yourself, do not use this agent; check with \`${cliPrefix()} doctor\`.`,
    { fingerprint: event.fingerprint },
  );
}
