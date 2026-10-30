// Shared pieces of the everyday commands (M1-9l): opening the agent for one command, the fixed text
// the copy sheet does not carry, and the terminal-output helpers.
//
// Output rule (06 §8, I-5): every value that is not fixed text goes through src/terminal/sanitize.ts
// before it is printed; values another party chose are printed only inside a marked region. Errors
// print only the fixed sentences of core, node and the runtime, never the caller's input.
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { CoreError } from '@4thtech-io/core';
import { NodeKeyStoreError, NodeStoreError } from '@4thtech-io/node';
import type { CommandContext } from '../dispatch.js';
import { EXIT_FAILED } from '../dispatch.js';
import { commandPrefix } from '../runtime/cli-prefix.js';
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
   * Keychain hygiene (IR-M1-8a-1 L-10): the unrecorded seed and `probe:` items an interrupted
   * keychain write can leave. @4thtech-io/node exports no such listing yet, so there is no default.
   */
  readonly strayItems?: StrayItems;
  /**
   * M1-9z (IR-M1-9z-1 F2): true when an owner code change didn't finish (a leftover `owner-next`
   * item). Store-only: nothing is unlocked. Production wires @4thtech-io/node's check in doctor.ts;
   * there is no default, so tests never touch the OS keychain.
   */
  readonly unfinishedOwnerCodeChange?: () => Promise<boolean>;
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

/**
 * Fixed text for the everyday commands (11 §6.10; the copy sheet has no entry for these yet). A
 * command in it starts with `commandPrefix()` (M1-36e), read through a getter, never the bare name.
 */
export const TEXT = Object.freeze({
  inviteReady:
    'Invite ready: it works once, until {date}. Send it only to the person you want to connect with: whoever uses it first is connected.',
  inviteNext:
    'Once they accept, you will be connected. Checking each other with a safety code arrives in a later version; until then the name they show is self-declared.',
  inviteShareHeader: 'Text you can send with it:',
  acceptNeedsApprovalLead: 'Approval needed to accept this invite.',
  acceptThenRetry:
    'After you approve, run the same accept command again and add `--approval {approvalId}`.',
  acceptWaiting:
    "Invite accepted. You'll be connected when {contactName}'s agent answers. Checking each other with a safety code arrives in a later version; until then the name they show is self-declared.",
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
  statusPartial: 'Warning  Part of the message network did not answer, so this may be incomplete.',
  // W4-PAUSE (06 §6 "Paused agents"): fixed text, the same sentence the tools give.
  statusPaused: 'Warning  This agent is paused. The owner can resume it in the AgentLink app.',
  // M1-5g: a relay returned a second at its cap. Fixed text: no count, relay or time (I-5, I-7).
  statusIncomplete:
    'Warning  Some messages may be missing from this check. AgentLink will look for them again on the next check.',
  requestRow: '{index}. Request from an unknown sender',
  requestId: 'Request ID: {requestId}',
  requestIdUnavailable: 'Request ID: unavailable',
  requestReadable: 'Your AI can read this message.',
  get requestMore(): string {
    return `{count, plural, one {1 more request is not shown.} other {# more requests are not shown.}} Deal with these first, then run \`${commandPrefix()} requests\` again.`;
  },
  requestNotFound: "That request isn't in your list any more.",
  requestIsContact: "That sender is one of your contacts, so it can't be blocked here.",
  get requestNeedsId(): string {
    return `Say which request: \`${commandPrefix()} requests {action} <requestId>\`.`;
  },
  blockedHeader: '{count, plural, one {1 blocked sender} other {# blocked senders}}',
  blockedNone: 'You have not blocked anyone.',
  blockedRow: '{index}. Blocked sender',
  blockedKey: 'Key: {key}',
  get blockedHow(): string {
    return `To unblock, run \`${commandPrefix()} requests unblock <key>\`.`;
  },
  get unblockNeedsKey(): string {
    return `Say which sender: \`${commandPrefix()} requests unblock <key>\`.`;
  },
  unblockNone: "That sender isn't blocked.",
  doctorKeychain: 'OK       Agent identity: system keychain',
  doctorFile:
    'Warning  Agent identity: passphrase-locked file (no system keychain)\n         That is weaker than a keychain if someone copies this disk.',
  doctorRelays:
    '{count, plural, one {OK       Message network: 1 server for this agent} other {OK       Message network: # servers for this agent}}',
  get doctorNoRelays(): string {
    return `Problem  This agent has no message network servers\n         Run \`${commandPrefix()} init\` again to set up this agent.`;
  },
  doctorSend: 'OK       This agent can send and sign',
  doctorSendBlocked:
    "Problem  This agent can't send or sign right now\n         Its identity is revoked, or a key change is unfinished.",
  get doctorPartial(): string {
    return `Warning  Part of the message network did not answer\n         Run \`${commandPrefix()} doctor\` again, or check your connection.`;
  },
  doctorOpenFailed:
    "Problem  Couldn't open this agent\n         Check the folder under ~/.agentlink.",
  doctorNoAgent: 'Problem  {message}',
  doctorNoKeychain: 'Problem  {message}',
  doctorFix: '         {fix}',
  doctorStray:
    '{count, plural, one {Warning  1 leftover item from an interrupted setup is in your keychain} other {Warning  # leftover items from an interrupted setup are in your keychain}}',
  doctorStrayAsk: 'Remove them? (y/N)',
  get doctorOwnerCodeUnfinished(): string {
    return `Problem  An owner code change didn't finish. In a terminal you opened yourself, run \`${commandPrefix()} owner change-code\` to finish or clean it up. Keep both your current and your new owner code until then.`;
  },
  doctorStrayRemoved: 'OK       Removed {count} leftover items',
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

/**
 * W4-PAUSE (D-143 (5); 06 §6 "Paused agents"): whether the owner paused this agent. Fail closed: a
 * pause state that cannot be read counts as paused. A client without the read is not paused.
 */
export async function agentPausedNow(client: {
  readonly paused?: () => Promise<boolean>;
}): Promise<boolean> {
  if (typeof client.paused !== 'function') return false;
  try {
    return await client.paused();
  } catch {
    return true;
  }
}
