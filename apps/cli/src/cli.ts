#!/usr/bin/env node
// The `agentlink` bin (M1-9k). It only wires the process to the dispatcher: argv, the TTY state and
// the environment for the guards, and the CLI's user-output channel. Commands register their
// handlers here as their cards land (M1-9a, M1-9b, M1-9l, M1-9m, M1-9c).
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { isatty } from 'node:tty';
import { acceptHandler } from './commands/accept.js';
import { contactsHandler } from './commands/contacts.js';
import { doctorHandler } from './commands/doctor.js';
import { inviteHandler } from './commands/invite.js';
import { requestsHandler } from './commands/requests.js';
import { statusHandler } from './commands/status.js';
import { createInitHandler, nodeInitDeps } from './commands/init.js';
import { createDispatcher } from './dispatch.js';
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

const dispatch = createDispatcher({
  init: createInitHandler(nodeInitDeps()),
  invite: inviteHandler,
  accept: acceptHandler,
  contacts: contactsHandler,
  status: statusHandler,
  doctor: doctorHandler,
  requests: requestsHandler,
});

process.exitCode = await dispatch(process.argv.slice(2), {
  output: createOutput(),
  // File descriptors 0 and 1: the guards need both stdin and stdout on a terminal (UX guard).
  terminal: { stdinIsTTY: isatty(0), stdoutIsTTY: isatty(1), env: process.env },
  version: packageVersion(),
});
