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
import type { OwnerPublicKeys } from '@agentlink/crypto';
import { decodeHex0x } from '@agentlink/crypto';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../../dispatch.js';
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
  let cardOwner: OwnerPublicKeys | undefined;
  try {
    const view = await opened.agent.client.identity.get();
    if (view !== undefined) {
      cardOwner = {
        ownerEvm: decodeHex0x(view.card.ownerEvm),
        ownerNostr: decodeHex0x(view.card.ownerNostr),
        ownerEnc: decodeHex0x(view.card.ownerEnc),
      };
    }
  } finally {
    await opened.agent.close();
  }
  await deps.initOwner({
    backend,
    ...(cardOwner === undefined ? {} : { cardOwner }),
    // Read for AI-app markers only (04 §2.8), never for a secret.
    env: terminal.env,
  });
  return EXIT_OK;
}

export function ownerHandler(deps: OwnerCommandDeps) {
  return (context: CommandContext): Promise<number> =>
    ownerStep(context, () => {
      const { positionals } = context.parsed;
      if (positionals.length !== 1 || positionals[0] !== 'init') {
        return Promise.resolve(badArguments(context.output));
      }
      return initOne(deps, context);
    });
}
