// The CLI main module (M1-9k), loaded by cli.ts after the Node version check (M1-9y).
// It only wires the process to the dispatcher: argv, the TTY state and
// the environment for the guards, and the CLI's user-output channel. Commands register their
// handlers here as their cards land (M1-9a, M1-9b, M1-9l, M1-9m); `mcp` is M1-9c's.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { isatty } from 'node:tty';
import { acceptHandler } from './commands/accept.js';
import { createContactsHandler } from './commands/contacts.js';
import { creditsHandler } from './commands/credits.js';
import { doctorHandler } from './commands/doctor.js';
import { uiHandler } from './commands/ui.js';
import { inviteHandler } from './commands/invite.js';
import { requestsHandler } from './commands/requests.js';
import { statusHandler } from './commands/status.js';
import { verifyHandler } from './commands/verify.js';
import { createInitHandler, nodeInitDeps } from './commands/init.js';
import {
  contactsManageHandler,
  nodeOwnerDeps,
  ownerCommandHandlers,
} from './commands/owner/index.js';
import { createDispatcher } from './dispatch.js';
import { mcpCommand } from './mcp/index.js';
import { createOutput } from './output.js';

function packageVersion(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const version = packageVersion();
const dispatch = createDispatcher({
  init: createInitHandler(nodeInitDeps()),
  invite: inviteHandler,
  accept: acceptHandler,
  // M1-9za: `contacts rename | remove` † go to the owner handler.
  contacts: createContactsHandler(undefined, contactsManageHandler(nodeOwnerDeps())),
  status: statusHandler,
  doctor: doctorHandler,
  // M1-11b-9.
  ui: uiHandler,
  requests: requestsHandler,
  // M1-9h.
  credits: creditsHandler,
  verify: verifyHandler,
  // M1-9b: the owner commands (owner init, approve, deny, cancel).
  ...ownerCommandHandlers(),
  mcp: mcpCommand(version),
});

const argv = process.argv.slice(2);
process.exitCode = await dispatch(argv, {
  output: createOutput(),
  // File descriptors 0 and 1: the guards need both stdin and stdout on a terminal (UX guard).
  terminal: { stdinIsTTY: isatty(0), stdoutIsTTY: isatty(1), env: process.env },
  version,
});

// One-shot commands close their relay connections and end on their own (M1-9b). This is only the
// last-resort net: if something still keeps the loop alive 5 s after the command finished, end the
// process with the command's own exit code. The timer is unref'd, so it never delays a clean exit.
// It is armed only after the command's dispatch has resolved, so it never cuts a command short.
// `agentlink mcp` is long-running and is never cut short.
if (argv[0] !== 'mcp') {
  setTimeout(() => process.exit(process.exitCode ?? 0), 5_000).unref();
}
