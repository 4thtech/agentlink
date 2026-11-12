// `agentlink owner init` † (M1-9b; 04 §2.2, §2.8 "owner init rules"; 06 §7; 07 §9.3; D-67, D-68 (3)).
//
// Creates the owner key on this machine with a generated master code (@4thtech-io/node `initOwner`,
// M1-8c): the code is shown once at this process's own terminal, re-typed and cleared; the owner
// seed is stored only wrapped under it, never in plain text (04 §2.2, G-5). It never replaces an
// existing owner key, nor an owner the agent's card already names. No argument, environment variable
// or pipe can supply or receive the code (07 §9.2).
//
// The opt-in to a chosen owner passphrase is not offered here yet: 06 §8 lists `owner init` with no
// option, and the opt-in copy lives in M1-8c's flow for the M1b setup page.
//
// M1-8h (IR-M1-9b-1 M-3): the same owner operation signs the agent's first card (04 §2.5, "the card
// signature at owner setup"). The agent stays open while node runs: node checks it has no card yet,
// signs one card for exactly this agent and the new owner, and stores it through core
// `identity.init`, so the agent can pair as soon as `owner init` succeeds. The card commits to the
// agent's local name as its display name and to the card relay list (card-relays.ts).
import type { OwnerPublicKeys } from '@4thtech-io/crypto';
import { decodeHex0x } from '@4thtech-io/crypto';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../../dispatch.js';
import { isOwnIdName } from '@4thtech-io/core';
import type { OwnerSetupOptions } from '@4thtech-io/node';
import { isAgentLabel, isAgentName } from '../../runtime/agent-name.js';
import { badArguments, openOne, ownerStep } from './common.js';
import type { OwnerCommandDeps } from './deps.js';
import { OWNER_TEXT } from './strings.js';

/** What signs and applies the first label (node's FirstLabelActions). */
type FirstLabelActions = NonNullable<OwnerSetupOptions['firstCard']['firstLabel']>['actions'];

/**
 * WP-1 (R-3; D-141): the first label of a terminal-made ID: `--label`, else the folder name. The
 * card is named by it and the same owner entry signs it as `agent.label` (node signFirstParts), so
 * what contacts see and what the app shows start out as one name. Undefined: a `--label` the label
 * rule refuses (06 §6, 06 §2.1); nothing runs then.
 */
function firstLabelOf(
  context: CommandContext,
  folder: string,
  actions: FirstLabelActions,
): { readonly label: string; readonly actions: FirstLabelActions } | undefined {
  const given = context.parsed.values['label'];
  const label = typeof given === 'string' ? given.normalize('NFC') : folder;
  if (!isAgentLabel(label) || !isOwnIdName(label)) return undefined;
  return { label, actions };
}

async function initOne(deps: OwnerCommandDeps, context: CommandContext): Promise<number> {
  const { output, parsed, terminal } = context;
  if (!labelGiven(context)) {
    output.printError(OWNER_TEXT.labelInvalid);
    return EXIT_FAILED;
  }
  const backend = await deps.backendOf(parsed.agent);
  if (backend === undefined) {
    output.printError(OWNER_TEXT.ownerUnknownAgent);
    return EXIT_FAILED;
  }
  // The owner the agent card already names, if any: then `owner init` refuses (04 §2.8).
  const opened = await openOne(deps, output, parsed.agent);
  if (!opened.ok) return opened.exit;
  const { agent } = opened;
  try {
    let cardOwner: OwnerPublicKeys | undefined;
    const view = await agent.client.identity.get();
    if (view !== undefined) {
      cardOwner = {
        ownerEvm: decodeHex0x(view.card.ownerEvm),
        ownerNostr: decodeHex0x(view.card.ownerNostr),
        ownerEnc: decodeHex0x(view.card.ownerEnc),
      };
    }
    const result = await deps.initOwner({
      backend,
      ...(cardOwner === undefined ? {} : { cardOwner }),
      // Read for AI-app markers only (04 §2.8), never for a secret.
      env: terminal.env,
      // M1-8h: the first card, signed in this same owner operation.
      firstCard: {
        agent: agent.client.agentId,
        name: agent.name,
        relays: deps.cardRelays(),
        identity: agent.client.identity,
        // M1-36b-2 (D-121 D6): the first rules (the empty ~/AgentLink/Send folder), signed by node
        // in this same owner-code entry; node checks what core prepares before it signs.
        firstPolicy: { actions: agent.client.ownerActions },
        // WP-1 (R-3): the card and the label carry one name.
        ...withLabel(context, agent.name, agent.client.ownerActions),
      },
    });
    await labelSaved(deps, agent.name, result.label, result.labelName);
  } finally {
    await agent.close();
  }
  return EXIT_OK;
}

/** False for a `--label` the label rule refuses (checked before anything is opened). */
function labelGiven(context: CommandContext): boolean {
  const given = context.parsed.values['label'];
  if (given === undefined) return true;
  return firstLabelOf(context, 'x', NO_ACTIONS) !== undefined;
}
const NO_ACTIONS: FirstLabelActions = {
  prepareLabel: () => Promise.reject(new Error('unused')),
  apply: () => Promise.reject(new Error('unused')),
};

function withLabel(
  context: CommandContext,
  folder: string,
  actions: FirstLabelActions,
): { firstLabel?: { readonly label: string; readonly actions: FirstLabelActions } } {
  const firstLabel = firstLabelOf(context, folder, actions);
  return firstLabel === undefined ? {} : { firstLabel };
}

/** 07 §9.1: config.json's label (display only), once core applied the signed one. */
async function labelSaved(
  deps: OwnerCommandDeps,
  folder: string,
  saved: unknown,
  label: string | undefined,
): Promise<void> {
  if (saved !== 'saved' || label === undefined || deps.writeLabel === undefined) return;
  await deps.writeLabel(folder, label).catch(() => undefined);
}

/** The owner keys a card names. */
function cardOwnerKeys(card: {
  ownerEvm: string;
  ownerNostr: string;
  ownerEnc: string;
}): OwnerPublicKeys {
  return {
    ownerEvm: decodeHex0x(card.ownerEvm),
    ownerNostr: decodeHex0x(card.ownerNostr),
    ownerEnc: decodeHex0x(card.ownerEnc),
  };
}

type FoundOwner =
  | { readonly status: 'one'; readonly owner: OwnerPublicKeys }
  | { readonly status: 'unreadable'; readonly agents: readonly string[] }
  | { readonly status: 'none' | 'several' };

/**
 * The owner this computer's other agents name (D-78: one owner per OS user). Read from their stored
 * cards (core verified them when they were stored); the owner step then checks that the owner item
 * on this machine unlocks to exactly these keys (04 §2.8 "Expected owner").
 *
 * IR-M1-9x-1 M-2: `none` routes to the no-card path (M1-9x), which has no expected owner, so it is
 * returned only when every other agent was read and none has a card. A revoked card still names the
 * owner and is used as the expected owner; an agent that can't be opened or read makes the command
 * refuse and name it, never fall through to the no-card path.
 */
async function machineOwner(deps: OwnerCommandDeps, except: string): Promise<FoundOwner> {
  const found = new Map<string, OwnerPublicKeys>();
  const unreadable: string[] = [];
  for (const name of await deps.listAgents()) {
    if (name === except || !isAgentName(name)) continue;
    let result: Awaited<ReturnType<OwnerCommandDeps['open']>>;
    try {
      result = await deps.open(name);
    } catch {
      unreadable.push(name);
      continue;
    }
    if (result.status !== 'ok') {
      unreadable.push(name);
      continue;
    }
    try {
      const view = await result.agent.client.identity.get();
      if (view === undefined) continue;
      const key = `${view.card.ownerEvm}:${view.card.ownerNostr}:${view.card.ownerEnc}`;
      found.set(key, cardOwnerKeys(view.card));
    } catch {
      unreadable.push(name);
    } finally {
      await result.agent.close();
    }
  }
  const owners = [...found.values()];
  if (owners.length > 1) return { status: 'several' };
  const [owner] = owners;
  if (owner !== undefined) return { status: 'one', owner };
  if (unreadable.length > 0) return { status: 'unreadable', agents: unreadable };
  return { status: 'none' };
}

/**
 * `agentlink owner add-agent --agent <name>` † (M1-9t; D-78; 04 §2.8 "Adding an agent to the existing
 * owner"): one first card for exactly this agent, signed with the owner key already on this
 * machine. Refusals come before the owner step; node checks presence and asks for the code once.
 */
async function addAgentOne(deps: OwnerCommandDeps, context: CommandContext): Promise<number> {
  const { output, parsed, terminal } = context;
  const name = parsed.agent;
  if (name === undefined) return badArguments(output);
  if (!labelGiven(context)) {
    output.printError(OWNER_TEXT.labelInvalid);
    return EXIT_FAILED;
  }
  const backend = await deps.backendOf(name);
  if (backend === undefined) {
    output.printError(OWNER_TEXT.addAgentUnknown);
    return EXIT_FAILED;
  }
  const opened = await openOne(deps, output, name);
  if (!opened.ok) return opened.exit;
  const { agent } = opened;
  try {
    if ((await agent.client.identity.get()) !== undefined) {
      output.printError(OWNER_TEXT.addAgentHasCard);
      return EXIT_FAILED;
    }
  } catch (error) {
    await agent.close();
    throw error;
  }
  // Closed while the other agents are read, so one process never holds two of them open at once.
  const found = await machineOwner(deps, agent.name).finally(() => agent.close());
  if (found.status === 'several') {
    output.printError(OWNER_TEXT.addAgentSeveralOwners);
    return EXIT_FAILED;
  }
  if (found.status === 'unreadable') {
    // Agent names are local config names checked by isAgentName, never inbound content (I-5).
    output.printError(OWNER_TEXT.addAgentUnreadable(found.agents));
    return EXIT_FAILED;
  }
  const again = await openOne(deps, output, name);
  if (!again.ok) return again.exit;
  let added: Awaited<ReturnType<OwnerCommandDeps['addAgent']>>;
  const firstLabel = withLabel(context, again.agent.name, again.agent.client.ownerActions);
  try {
    added = await deps.addAgent({
      backend,
      // M1-9x: no other agent names an owner, so node takes the owner keys from the owner item
      // itself (after the master code), or refuses with `owner init` when there is none.
      ...(found.status === 'one' ? { owner: found.owner } : {}),
      // Read for AI-app markers only (04 §2.8), never for a secret.
      env: terminal.env,
      card: {
        agent: again.agent.client.agentId,
        name: again.agent.name,
        relays: deps.cardRelays(),
        identity: again.agent.client.identity,
        // M1-36b-2 (D-121 D6): the first rules, signed in this same owner-code entry.
        firstPolicy: { actions: again.agent.client.ownerActions },
        // WP-1 (R-3): the card and the label carry one name.
        ...firstLabel,
      },
    });
    await labelSaved(deps, again.agent.name, added.label, firstLabel.firstLabel?.label);
  } finally {
    await again.agent.close();
  }
  output.print(OWNER_TEXT.addAgentDone);
  return EXIT_OK;
}

/**
 * `agentlink owner change-code` † (M1-9z; 04 §2.8 "Changing the master code"): replaces an exposed
 * master code. The owner the machine's agents name is handed to node as the expected owner, so the
 * owner item must unlock to exactly that owner; node asks for the current code, shows the new one
 * and re-wraps the owner key. The owner, its fingerprint and every card stay the same.
 */
async function changeCodeOne(deps: OwnerCommandDeps, context: CommandContext): Promise<number> {
  const { output, parsed, terminal } = context;
  const backend = await deps.backendOf(parsed.agent);
  if (backend === undefined) {
    output.printError(OWNER_TEXT.ownerUnknownAgent);
    return EXIT_FAILED;
  }
  const found = await machineOwner(deps, '');
  if (found.status === 'several') {
    output.printError(OWNER_TEXT.addAgentSeveralOwners);
    return EXIT_FAILED;
  }
  if (found.status === 'unreadable') {
    // Agent names are local config names checked by isAgentName, never inbound content (I-5).
    output.printError(OWNER_TEXT.addAgentUnreadable(found.agents));
    return EXIT_FAILED;
  }
  await deps.changeOwnerCode({
    backend,
    ...(found.status === 'one' ? { owner: found.owner } : {}),
    // Read for AI-app markers only (04 §2.8), never for a secret.
    env: terminal.env,
  });
  output.print(OWNER_TEXT.changeCodeDone);
  return EXIT_OK;
}

export function ownerHandler(deps: OwnerCommandDeps) {
  return (context: CommandContext): Promise<number> =>
    ownerStep(context, deps, (deps) => {
      const { positionals } = context.parsed;
      if (positionals.length === 1 && positionals[0] === 'init') return initOne(deps, context);
      if (positionals.length === 1 && positionals[0] === 'add-agent') {
        return addAgentOne(deps, context);
      }
      if (positionals.length === 1 && positionals[0] === 'change-code') {
        return changeCodeOne(deps, context);
      }
      return Promise.resolve(badArguments(context.output));
    });
}
