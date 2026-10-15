// Shared pieces of the everyday commands (M1-9l): opening the agent for one command, the fixed text
// the copy sheet does not carry, and the terminal-output helpers.
//
// Output rule (06 §8, I-5): every value that is not fixed text goes through src/terminal/sanitize.ts
// before it is printed; values another party chose are printed only inside a marked region. Errors
// print only the fixed sentences of core, node and the runtime, never the caller's input.
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { CoreError } from '@agentlink/core';
import { NodeKeyStoreError, NodeStoreError } from '@agentlink/node';
import type { CommandContext } from '../dispatch.js';
import { EXIT_FAILED } from '../dispatch.js';
import { RuntimeError } from '../runtime/errors.js';
import { openAgent, type OpenAgentResult, type OpenedAgent } from '../runtime/open-agent.js';
import { terminalOneLine } from '../terminal/sanitize.js';

/**
 * Reads one answer line. The caller prints the question first through the Output channel (the one
 * place in apps/cli that writes to the terminal, eslint CONSOLE_CHANNELS). Resolves undefined when
 * input has ended.
 */
export interface Prompter {
  ask(): Promise<string | undefined>;
  close(): void;
}

/** What the everyday commands take from the process. Tests pass doubles. */
export interface CommandDeps {
  /** Opens the local agent (the runtime's `openAgent`). */
  readonly open: (agent: string | undefined) => Promise<OpenAgentResult>;
  /** The home directory that holds `.agentlink` (doctor reads the recorded config). */
  readonly home: string;
  /** Unix seconds. */
  readonly clock: () => number;
  /** A terminal prompt, created only when a command needs to ask (interactive commands). */
  readonly prompter: () => Prompter;
  /**
   * The sender code of an unknown sender key (04 §2.9, D-72). It must come from the crypto helper
   * `senderCode` (card M1-1-sc), never from a tag literal here. Until that helper lands the CLI
   * shows no code and names requests by their request ID.
   */
  readonly senderCode?: (fromKey: string) => string;
  /**
   * Keychain hygiene (IR-M1-8a-1 L-10): the unrecorded seed and `probe:` items an interrupted
   * keychain write can leave. @agentlink/node exports no such listing yet, so there is no default.
   */
  readonly strayItems?: StrayItems;
}

export interface StrayItems {
  /** How many stray items the keychain holds for this agent (a count, never an account name). */
  count(agentId: string): Promise<number>;
  /** Removes them. */
  remove(agentId: string): Promise<number>;
}

const systemClock = (): number => Math.floor(Date.now() / 1000);

/** A readline prompter over the process's stdin (the terminal echoes what the user types). */
function readlinePrompter(): Prompter {
  const rl = createInterface({ input: process.stdin });
  // The async iterator buffers lines that arrive between questions.
  const lines = rl[Symbol.asyncIterator]();
  return {
    ask: async () => {
      try {
        const next = await lines.next();
        return next.done === true ? undefined : next.value;
      } catch {
        return undefined;
      }
    },
    close: () => rl.close(),
  };
}

export function createDeps(over: Partial<CommandDeps> = {}): CommandDeps {
  return Object.freeze({
    open: (agent: string | undefined) => openAgent(agent === undefined ? {} : { agent }),
    home: homedir(),
    clock: systemClock,
    prompter: readlinePrompter,
    ...over,
  });
}

/** Fixed text for the everyday commands (11 §6.10; the copy sheet has no entry for these yet). */
export const TEXT = Object.freeze({
  inviteReady:
    'Invite ready: it works once, until {date}. Send it only to the person you want to connect with: whoever uses it first is connected.',
  inviteNext:
    "Once they accept, you'll both see a safety code to compare. Compare it only on your own screen, never in a chat.",
  inviteShareHeader: 'Text you can send with it:',
  acceptNeedsApprovalLead: 'Approval needed to accept this invite.',
  acceptThenRetry:
    'After you approve, run the same accept command again and add `--approval {approvalId}`.',
  acceptWaiting:
    "Invite accepted. You'll be connected when {contactName}'s agent answers. Then compare the safety code on your own screen, not in a chat.",
  acceptOffline:
    "Warning  Invite accepted, but the message network can't be reached right now. AgentLink keeps the answer ready and sends it when the network is back.",
  acceptStillWaiting:
    "That approval hasn't been decided yet. Approve it in your own terminal first.",
  acceptDenied: 'You declined, so nothing was sent.',
  acceptExpired:
    'That approval expired. Run the accept command again, without --approval, to ask again.',
  acceptRefused:
    "That approval can't be used for this invite. Run accept again to ask for a new one.",
  acceptNotAllowed: "Your rules don't let this agent accept invites. Only you can change that.",
  contactsNone: 'You have no contacts yet. Create an invite to connect with someone.',
  contactsHeader: '{count, plural, one {1 contact} other {# contacts}}',
  statusOffline:
    "Warning  Can't reach the message network, so this shows only what is already stored.",
  statusPartial: 'Warning  Some relays did not answer, so this may be incomplete.',
  requestRow: '{index}. Request from an unknown sender',
  requestId: 'Request ID: {requestId}',
  requestIdUnavailable: 'Request ID: unavailable',
  requestReadable: 'Your AI can read this message.',
  requestMore:
    '{count, plural, one {1 more request is not shown.} other {# more requests are not shown.}} Deal with these first, then run `agentlink requests` again.',
  requestNotFound: "That request isn't in your list any more.",
  requestIsContact: "That sender is one of your contacts, so it can't be blocked here.",
  requestNeedsId: 'Say which request: `agentlink requests {action} <requestId>`.',
  blockedHeader: '{count, plural, one {1 blocked sender} other {# blocked senders}}',
  blockedNone: 'You have not blocked anyone.',
  blockedRow: '{index}. Blocked sender',
  blockedKey: 'Key: {key}',
  blockedHow: 'To unblock, run `agentlink requests unblock <key>`.',
  unblockNeedsKey: 'Say which sender: `agentlink requests unblock <key>`.',
  unblockNone: "That sender isn't blocked.",
  verifyNotYet:
    'Checking a safety code (`contacts --verify`) is not available in this version yet.',
  doctorKeychain: 'OK       Agent identity: system keychain',
  doctorFile:
    'Warning  Agent identity: passphrase-locked file (no system keychain)\n         That is weaker than a keychain if someone copies this disk.',
  doctorRelays: '{count, plural, one {OK       1 own relay} other {OK       # own relays}}',
  doctorNoRelays:
    'Problem  No own relays\n         Run `agentlink init` again to set up this agent.',
  doctorSend: 'OK       This agent can send and sign',
  doctorSendBlocked:
    "Problem  This agent can't send or sign right now\n         Its identity is revoked, or a key change is unfinished.",
  doctorPartial:
    'Warning  Some relays did not answer\n         Run `agentlink doctor` again, or check your connection.',
  doctorOpenFailed:
    "Problem  Couldn't open this agent\n         Check the folder under ~/.agentlink.",
  doctorNoAgent: 'Problem  {message}',
  doctorNoKeychain: 'Problem  {message}',
  doctorFix: '         {fix}',
  doctorStray:
    '{count, plural, one {Warning  1 leftover item from an interrupted setup is in your keychain} other {Warning  # leftover items from an interrupted setup are in your keychain}}',
  doctorStrayAsk: 'Remove them? (y/N)',
  doctorStrayRemoved: 'OK       Removed {count} leftover items',
  doctorNotChecked:
    'Not checked in this version: payments network, file storage and AI apps (`agentlink doctor` adds them later).',
} as const);

/** Fills `{name}` slots of a TEXT entry. Values are sanitized one-line text or numbers. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
}

/** Prints text that may span lines, one output call per line. */
export function printAll(context: CommandContext, lines: readonly string[]): void {
  for (const line of lines) context.output.print(line);
}

/**
 * The fixed sentence of an error from core, node or the runtime, sanitized again as a one-line
 * value; undefined for any other error (its text could carry a value, I-5).
 */
export function fixedErrorText(error: unknown): string | undefined {
  if (
    error instanceof CoreError ||
    error instanceof RuntimeError ||
    error instanceof NodeKeyStoreError ||
    error instanceof NodeStoreError
  ) {
    return terminalOneLine(error.message);
  }
  return undefined;
}

/**
 * Opens the agent, runs `run`, and always closes it. A `needs_setup` answer prints its fixed text.
 * A fixed error prints its sentence and fails; any other error goes to the dispatcher's fixed text.
 */
export async function withAgent(
  context: CommandContext,
  deps: CommandDeps,
  run: (agent: OpenedAgent) => Promise<number>,
): Promise<number> {
  const opened = await deps.open(context.parsed.agent);
  if (opened.status === 'needs_setup') {
    context.output.printError(opened.message);
    if (opened.fix !== undefined) context.output.printError(opened.fix);
    return EXIT_FAILED;
  }
  const { agent } = opened;
  try {
    return await run(agent);
  } catch (error) {
    const text = fixedErrorText(error);
    if (text === undefined) throw error;
    context.output.printError(text);
    return EXIT_FAILED;
  } finally {
    await agent.close();
  }
}
