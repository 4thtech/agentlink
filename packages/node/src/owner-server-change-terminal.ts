// NET-CLI (S2; D-158 (5), (6), (7); 06 §8 `agentlink owner servers set | reset` †; 04 §2.5, §2.6;
// 07 §4.3; I-1, I-4, I-7): a server-list change or a reset at the owner's own terminal.
//
// The same owner operation as the app's Advanced › Message network, through the same pieces:
// - The plan: server-change-plan.ts planServerChange, the planner the app's routes use (the servers
//   tested again here, core buildServerList, the leaving servers, the contacts, the warnings).
//   Every refusal comes before anything is shown or asked.
// - The review is written first (the caller's fixed words for the plan's fixed fields), then
//   "Continue?", then owner presence at this process's own prompt (the master code; never an
//   argument, a variable or a pipe), then one owner session that signs exactly that card through
//   signServerChange (owner-relay-migration.ts), the app's path. Without presence nothing is signed.
// - The package entry changeServersAtTerminal refuses an AI-harness marker and a missing terminal
//   before it reads anything, and takes no owner-store or terminal seam (REL-0513-FENCE, like
//   updateContactDetailsAtTerminal); the seam variant stays inside the package.
// No MCP tool, tool argument or `nextStep` reaches it (I-4). Nothing is logged: no list, host or card.
import type { AgentLinkClient } from '@4thtech-io/core';
import { AUTOMATIC_SERVERS, parseOwnServers } from '@4thtech-io/core';
import type { OwnerPresence, OwnerPublicKeys } from '@4thtech-io/crypto';
import { precheckServers } from '@4thtech-io/transport-nostr';
import { NodeKeyStoreError } from './errors.js';
import type { AgentEpochKeys } from './key-epoch.js';
import { osKeychain } from './keychain.js';
import { processPrecheckBudget } from './local-ui/api/network-test.js';
import { serverListPort } from './local-ui/context.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { secretLabel, type PromptingOwnerKeyStore } from './owner-operation.js';
import { signServerChange, type ServerChangeOutcome } from './owner-relay-migration.js';
import { assertNoHarnessMarker, ttyOwnerTerminal, type OwnerTerminal } from './owner-terminal.js';
import { nodeHostResolver, nodeNip11Fetcher, nodeRelayConnector } from './relay-io.js';
import {
  planServerChange,
  planUnchanged,
  serverStateRefusal,
  type ServerChangeAsk,
  type ServerChangeReview,
  type ServerPlanRefusalReason,
  type ServerTestRun,
} from './server-change-plan.js';

export type { ServerChangeReview } from './server-change-plan.js';

/** What the owner typed: their own list with the two choices, or "back to automatic". */
export type ServerChangeRequest =
  | {
      readonly kind: 'servers';
      readonly servers: readonly string[];
      /** "Also use AgentLink's automatic servers" (the mix-in). */
      readonly automatic: boolean;
      /** false: "Don't also announce on the default servers" (mix-in off only). */
      readonly announce: boolean;
    }
  | { readonly kind: 'reset' };

export interface ServersAtTerminalInput {
  /** The open agent's agentId; the card must name exactly it. */
  readonly agent: string;
  readonly client: AgentLinkClient;
  /** The open agent's key items (epochKeysOf its KeyStore). */
  readonly epochKeys: AgentEpochKeys;
  /** The owner the agent's card names. */
  readonly ownerKeys: OwnerPublicKeys;
  readonly request: ServerChangeRequest;
  /** The review's fixed lines for the plan (the caller's words; hosts and codes only). */
  describe(review: ServerChangeReview): readonly string[];
}

export type ServersAtTerminalOutcome =
  | Extract<ServerChangeOutcome, { readonly status: 'changed' }>
  | {
      readonly status: 'refused';
      readonly reason: ServerPlanRefusalReason | 'invalid_list';
      /** `too_many_previous` only: the unix second from which the change fits. */
      readonly fitsAt?: number;
    };

const refused = (
  reason: ServerPlanRefusalReason | 'invalid_list',
  fitsAt?: number,
): ServersAtTerminalOutcome =>
  Object.freeze({ status: 'refused', reason, ...(fitsAt === undefined ? {} : { fitsAt }) });

/** The request as the planner's ask, or undefined when the list breaks the shape or URL rule. */
function askOf(request: ServerChangeRequest): ServerChangeAsk | undefined {
  if (request.kind === 'reset') {
    return { kind: 'reset', own: AUTOMATIC_SERVERS, automatic: true, announce: true };
  }
  const own = parseOwnServers(request.servers, request.automatic === true);
  if (own === undefined) return undefined;
  return {
    kind: 'servers',
    own,
    automatic: request.automatic === true,
    announce: request.announce !== false,
  };
}

/**
 * The owner operation with the owner store, terminal and test run it is given (internal, never a
 * package export; tests reach it by this module path). The caller opens and closes the store.
 */
export async function changeServersWith(
  store: PromptingOwnerKeyStore,
  terminal: OwnerTerminal,
  input: ServersAtTerminalInput,
  io: { readonly test: ServerTestRun; readonly now: () => number },
): Promise<ServersAtTerminalOutcome> {
  const ask = askOf(input.request);
  if (ask === undefined) return refused('invalid_list');
  const port = serverListPort(input.client);
  const got = await planServerChange({
    ask,
    state: await port.state(),
    contacts: () => port.contacts(),
    now: io.now(),
    test: io.test,
  });
  if (got.status === 'refused') return refused(got.reason, got.fitsAt);
  for (const line of input.describe(got.review)) terminal.write(line);
  if (!(await terminal.confirm('Continue?'))) {
    throw new NodeKeyStoreError('owner_prompt_cancelled', 'Cancelled. Nothing was changed.');
  }
  const kind = await store.secretKind();
  const presence: OwnerPresence =
    terminal.readPresence === undefined
      ? { kind: 'passphrase', secret: await terminal.readSecret(secretLabel(kind)) }
      : await terminal.readPresence(secretLabel(kind));
  const session = await store.unlock(presence);
  try {
    // The agent may have changed while the owner read the review: the same checks again.
    const state = await port.state();
    const stateRefused = serverStateRefusal(state);
    if (stateRefused !== undefined) return refused(stateRefused);
    if (planUnchanged(got.plan, state)) return refused('same_list');
    const { client } = input;
    const outcome = await signServerChange(session, input.ownerKeys, {
      agent: input.agent,
      client: {
        identity: client.identity,
        sendCardUpdates: () => client.sendCardUpdates(),
        contacts: client.contacts,
      },
      epochKeys: input.epochKeys,
      relays: got.plan.relays,
      announceDefault: got.plan.announceDefault,
    });
    return outcome.status === 'changed' ? outcome : refused(outcome.reason, outcome.fitsAt);
  } finally {
    await session.close();
    await store.lock();
  }
}

/** The app's test, at this process's budget (`busy` over it), with the Node relay I/O. */
const productionTest: ServerTestRun = (own, withDefaults) =>
  processPrecheckBudget.run(() => {
    const options = {
      resolver: nodeHostResolver(),
      connector: nodeRelayConnector(),
      nip11: nodeNip11Fetcher(),
    };
    return Promise.all([
      precheckServers(own, options),
      withDefaults ? precheckServers(AUTOMATIC_SERVERS, options) : Promise.resolve([]),
    ] as const);
  });

/**
 * `agentlink owner servers set | reset` † (the package entry): one owner operation on this OS
 * user's keychain and this process's own TTY prompt, like updateContactDetailsAtTerminal. No
 * owner-store or terminal seam: anything extra in the input is never read. An AI harness or a
 * missing terminal is refused before anything is read or tested.
 */
export async function changeServersAtTerminal(
  input: ServersAtTerminalInput,
): Promise<ServersAtTerminalOutcome> {
  assertNoHarnessMarker();
  const terminal = ttyOwnerTerminal();
  const { agent, client, epochKeys, ownerKeys, request, describe } = input;
  const checked: ServersAtTerminalInput = {
    agent,
    client,
    epochKeys,
    ownerKeys,
    request,
    describe,
  };
  if (askOf(request) === undefined) return refused('invalid_list');
  const store = await KeychainOwnerKeyStore.open(osKeychain(), ownerKeys);
  try {
    return await changeServersWith(store, terminal, checked, {
      test: productionTest,
      now: () => Math.floor(Date.now() / 1000),
    });
  } finally {
    await store.close();
  }
}
