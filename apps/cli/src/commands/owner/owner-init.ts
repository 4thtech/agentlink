// `agentlink owner init` † (M1-9b; 04 §2.2, §2.8 "owner init rules"; 06 §7; 07 §9.3; D-67, D-68 (3)).
//
// Creates the owner key on this machine with a generated owner code (@agentlink/node `initOwner`,
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
import type { OwnerPublicKeys } from '@agentlink/crypto';
import { decodeHex0x } from '@agentlink/crypto';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../../dispatch.js';
import { isAgentName } from '../../runtime/agent-name.js';
import { badArguments, openOne, ownerStep } from './common.js';
import type { OwnerCommandDeps } from './deps.js';
import { OWNER_TEXT } from './strings.js';

async function initOne(deps: OwnerCommandDeps, context: CommandContext): Promise<number> {
  const { output, parsed, terminal } = context;
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
    await deps.initOwner({
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
      },
    });
  } finally {
    await agent.close();
  }
  return EXIT_OK;
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
  | { readonly status: 'none' | 'several' };

/**
 * The owner this computer's other agents name (D-78: one owner per OS user). Read from their stored
 * cards (core verified them when they were stored); the owner step then checks that the owner item
 * on this machine unlocks to exactly these keys (04 §2.8 "Expected owner").
 */
async function machineOwner(deps: OwnerCommandDeps, except: string): Promise<FoundOwner> {
  const found = new Map<string, OwnerPublicKeys>();
  for (const name of await deps.listAgents()) {
    if (name === except || !isAgentName(name)) continue;
    const result = await deps.open(name);
    if (result.status !== 'ok') continue;
    try {
      const view = await result.agent.client.identity.get();
      if (view === undefined || view.revoked) continue;
      const key = `${view.card.ownerEvm}:${view.card.ownerNostr}:${view.card.ownerEnc}`;
      found.set(key, cardOwnerKeys(view.card));
    } finally {
      await result.agent.close();
    }
  }
  const owners = [...found.values()];
  if (owners.length === 0) return { status: 'none' };
  const [owner] = owners;
  if (owners.length > 1 || owner === undefined) return { status: 'several' };
  return { status: 'one', owner };
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
  if (found.status !== 'one') {
    output.printError(
      found.status === 'none' ? OWNER_TEXT.addAgentNoOwner : OWNER_TEXT.addAgentSeveralOwners,
    );
    return EXIT_FAILED;
  }
  const again = await openOne(deps, output, name);
  if (!again.ok) return again.exit;
  try {
    await deps.addAgent({
      backend,
      owner: found.owner,
      // Read for AI-app markers only (04 §2.8), never for a secret.
      env: terminal.env,
      card: {
        agent: again.agent.client.agentId,
        name: again.agent.name,
        relays: deps.cardRelays(),
        identity: again.agent.client.identity,
      },
    });
  } finally {
    await again.agent.close();
  }
  output.print(OWNER_TEXT.addAgentDone);
  return EXIT_OK;
}

export function ownerHandler(deps: OwnerCommandDeps) {
  return (context: CommandContext): Promise<number> =>
    ownerStep(context, () => {
      const { positionals } = context.parsed;
      if (positionals.length === 1 && positionals[0] === 'init') return initOne(deps, context);
      if (positionals.length === 1 && positionals[0] === 'add-agent') {
        return addAgentOne(deps, context);
      }
      return Promise.resolve(badArguments(context.output));
    });
}
