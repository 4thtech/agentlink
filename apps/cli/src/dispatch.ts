// The `agentlink` command dispatcher (M1-9k; 06 §8). It registers every M1a command, parses
// arguments with `node:util` parseArgs (no new dependency) and runs the guards that every command of
// its kind needs before its handler sees anything:
//
// - Owner commands (†) and interactive-only commands need an interactive terminal with no harness
//   marker set (04 §2.5, §2.8; 06 §8). This is a UX guard, NOT a security boundary (G-1, D-67).
//   The `agentlink mcp` process itself never passes it, because its stdin and stdout are the MCP
//   pipe. But any shell the agent controls can pass it (a pseudo-terminal such as `script`, with the
//   markers removed from the environment), so nothing may rely on it. What stops the agent is the
//   owner-presence step each owner handler takes (the owner code at the prompt, M1-9b) and the
//   owner signature core verifies (I-4); the D-67 residual (an agent that fakes the prompt and
//   learns the code) is accepted for M1.
// - `--agent` is checked against the local agent-name pattern (06 §6); an approval ID against its
//   exact pattern (04 §2.4.1).
// - Nothing the caller typed is ever echoed: usage errors and refusals are fixed text (I-5), and
//   values a handler prints go through the terminal output rule (src/terminal/sanitize.ts, 06 §8).
// - M1-9zd: an argument shaped like a generated owner code (04 §2.8 kind 1) stops every command
//   before anything else runs, with fixed text that never echoes it. A UX guard, like the others:
//   the code is already in the shell's history, so the text says how to change it.
//
// The commands themselves land with their cards (M1-9a, M1-9b, M1-9l, M1-9m, M1-9c); until then
// each is registered and answers "not available yet".
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { isApprovalId } from './approval/next-step.js';
import type { Output } from './output.js';
import { isAgentName } from './runtime/agent-name.js';
import { RUNTIME_MESSAGES, RuntimeError } from './runtime/errors.js';
import { checkOwnerTerminal, type TerminalContext } from './runtime/guards.js';
import { looksLikeOwnerCode } from './runtime/owner-code-shape.js';
import { commandPrefix } from './runtime/cli-prefix.js';

type Options = NonNullable<ParseArgsConfig['options']>;

/** How a command is guarded before its handler runs. */
export type CommandGuard =
  /** Runs anywhere. */
  | 'none'
  /** Owner operation (†): interactive terminal, no harness marker, owner presence in the handler. */
  | 'owner'
  /** Interactive terminal and no harness marker (06 §8 `requests`), without owner presence. */
  | 'interactive';

export interface CommandSpec {
  /** The command word (a subcommand, when there is one, is the first positional). */
  readonly name: CommandName;
  /** The usage lines for `--help`, in 06 §8 form. */
  readonly usage: readonly string[];
  readonly guard: CommandGuard;
  /** When set, the guard applies only when this returns true (`contacts rename | remove` are †). */
  readonly guardWhen?: (parsed: ParsedCommand) => boolean;
  readonly options: Options;
  /** Positionals that must be an approval ID, by index. */
  readonly approvalIdAt?: readonly number[];
}

export type CommandName =
  | 'init'
  | 'owner'
  | 'status'
  | 'invite'
  | 'accept'
  | 'contacts'
  | 'requests'
  | 'policy'
  | 'credits'
  | 'verify'
  | 'approve'
  | 'deny'
  | 'cancel'
  | 'doctor'
  | 'mcp';

const AGENT: Options = { agent: { type: 'string' } };

/**
 * The commands of 06 §8, in its order. M1-9h adds `credits` and `verify`. Not here yet: `ui` and the
 * passkey option of `init` (they wait for the local settings UI), `storage connect`, `backup`,
 * `relays set`, and `init --keystore file` / `keystore passphrase` (they wait for the file KeyStore,
 * M1-8f, off the M1a path, D-73 (4)).
 */
export const COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    name: 'init',
    usage: [
      'agentlink init [--agent <name>] [--harness <id|none>] [--config <path>]',
      'agentlink init --hook [--agent <name>]',
    ],
    guard: 'none',
    options: {
      ...AGENT,
      confirm: { type: 'string' },
      // D-78 (06 §7): one harness, or `none` for the identity only; `--config` for OpenCode or
      // Antigravity only (checked in the handler).
      harness: { type: 'string' },
      config: { type: 'string' },
      // M1-29 (06 §7, D-53): the optional SessionStart hook, a separate opt-in.
      hook: { type: 'boolean' },
    },
  },
  {
    name: 'owner',
    usage: [
      'agentlink owner init                     †',
      'agentlink owner add-agent --agent <name>   †',
      'agentlink owner change-code              †',
    ],
    guard: 'owner',
    options: AGENT,
  },
  {
    name: 'status',
    usage: ['agentlink status [--brief]'],
    guard: 'none',
    options: { ...AGENT, brief: { type: 'boolean' } },
  },
  { name: 'invite', usage: ['agentlink invite'], guard: 'none', options: AGENT },
  {
    name: 'accept',
    usage: ['agentlink accept <url> [--approval <approvalId>]'],
    guard: 'none',
    options: { ...AGENT, approval: { type: 'string' } },
  },
  {
    name: 'contacts',
    usage: [
      'agentlink contacts',
      'agentlink contacts rename <contactId> <name> [--agent <name>]   †',
      'agentlink contacts remove <contactId> [--agent <name>]   †',
    ],
    guard: 'owner',
    // The `rename` and `remove` subcommands (M1-9za) are owner operations; the plain list is not.
    // `--verify` (M1-9m) is not registered until safety-code checks land, so nothing names it
    // (M1-36c).
    guardWhen: (parsed) => parsed.positionals.length > 0,
    options: AGENT,
  },
  {
    name: 'requests',
    usage: ['agentlink requests [accept | ignore | block <requestId>]'],
    guard: 'interactive',
    options: { ...AGENT, all: { type: 'boolean' } },
  },
  {
    name: 'policy',
    // M1-9m: show, and the allowed folders for sending files. M1-9m-b: recover (D-100).
    // `set <key> <value>` (commitments limits, the sell warning) is not registered, so it is not
    // listed (M1-36c).
    usage: [
      'agentlink policy show [--agent <name>]   †',
      'agentlink policy allow-folder <path> [--agent <name>]   †',
      'agentlink policy remove-folder <path> [--agent <name>]   †',
      'agentlink policy recover [--agent <name>]   †',
    ],
    guard: 'owner',
    options: AGENT,
  },
  {
    name: 'credits',
    usage: ['agentlink credits [--topup] [--agent <name>]'],
    guard: 'none',
    options: { ...AGENT, topup: { type: 'boolean' } },
  },
  {
    name: 'verify',
    usage: ['agentlink verify <proof.json> [--agent <name>]'],
    guard: 'none',
    options: AGENT,
  },
  {
    name: 'approve',
    usage: [
      'agentlink approve <approvalId> [--agent <name>]   †',
      'agentlink approve [--agent <name>]     †',
    ],
    guard: 'owner',
    options: AGENT,
    approvalIdAt: [0],
  },
  {
    name: 'deny',
    usage: ['agentlink deny <approvalId> [--agent <name>]   †'],
    guard: 'owner',
    options: AGENT,
    approvalIdAt: [0],
  },
  {
    name: 'cancel',
    usage: ['agentlink cancel <approvalId> [--agent <name>]   †'],
    guard: 'owner',
    options: AGENT,
    approvalIdAt: [0],
  },
  { name: 'doctor', usage: ['agentlink doctor'], guard: 'none', options: AGENT },
  { name: 'mcp', usage: ['agentlink mcp'], guard: 'none', options: AGENT },
] satisfies CommandSpec[]);

/** The command names, for tests and for the harness config writers. */
export const COMMAND_NAMES: readonly CommandName[] = Object.freeze(COMMANDS.map((c) => c.name));

export interface ParsedCommand {
  readonly values: Readonly<Record<string, string | boolean | undefined>>;
  readonly positionals: readonly string[];
  /** The checked local agent name, or undefined for the default agent. */
  readonly agent: string | undefined;
}

export interface CommandContext {
  readonly command: CommandName;
  readonly parsed: ParsedCommand;
  readonly output: Output;
  readonly terminal: TerminalContext;
}

/** A command's handler. Returns the process exit code. */
export type CommandHandler = (context: CommandContext) => Promise<number>;

export interface DispatchIO {
  readonly output: Output;
  readonly terminal: TerminalContext;
  readonly version: string;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** Fixed text (I-5: nothing the caller typed is echoed). */
export const DISPATCH_TEXT = Object.freeze({
  get unknownCommand(): string {
    return `Unknown command. Run \`${commandPrefix()} --help\` to see the commands.`;
  },
  get badArguments(): string {
    return `That command's arguments aren't right. Run \`${commandPrefix()} --help\` to see how to use it.`;
  },
  notAvailable: "This command isn't available in this version of AgentLink yet.",
  harnessDetected:
    'This looks like a terminal your AI app controls. Run this command yourself, in a terminal window you opened.',
  notInteractive:
    'This command needs you at an interactive terminal. Run it yourself, in a terminal window you opened.',
  get failed(): string {
    return `Something went wrong. Run \`${commandPrefix()} doctor\` in your own terminal to see why.`;
  },
  // M1-9zd (11 §5.5, §6.10): fixed text; nothing of what was typed is repeated.
  get ownerCodeInCommand(): string {
    return [
      "Problem  That looks like your owner code, so AgentLink didn't run anything.",
      '         Type your owner code only at the prompt a command shows. It is never',
      '         part of a command, and never paste it into a chat. Your shell may have',
      '         kept what you typed in its history, so change your owner code:',
      `         ${commandPrefix()} owner change-code`,
    ].join('\n');
  },
});

/** The `--help` groups (M1-36c): a one-line purpose each, so a new user knows where to start. */
const HELP_GROUPS: readonly { readonly title: string; readonly names: readonly CommandName[] }[] = [
  { title: 'Start here (once):', names: ['init', 'owner'] },
  {
    title: 'Every day:',
    names: ['status', 'invite', 'accept', 'requests', 'approve', 'deny', 'cancel'],
  },
  { title: 'More:', names: ['contacts', 'policy', 'credits', 'verify', 'doctor', 'mcp'] },
];

/** The `--help` text: exactly the registered commands of 06 §8, grouped. */
export function helpText(): string {
  const lines = [
    'AgentLink: private messages between AI agents, with proof when you want it.',
    '',
    'Usage: agentlink <command> [options]',
    `New here? Run \`${commandPrefix()} init\`, then ask your AI to send an invite.`,
    '',
    '† needs you, the owner, in your own terminal.',
  ];
  for (const group of HELP_GROUPS) {
    lines.push('', group.title);
    for (const name of group.names) {
      const spec = COMMANDS.find((command) => command.name === name);
      for (const line of spec?.usage ?? []) lines.push(`  ${line}`);
    }
  }
  lines.push('', 'Options: --help, --version');
  return lines.join('\n');
}

const notAvailable: CommandHandler = ({ output }) => {
  output.printError(DISPATCH_TEXT.notAvailable);
  return Promise.resolve(EXIT_FAILED);
};

/**
 * Builds the dispatcher. `handlers` replaces the "not available yet" stub of the commands that have
 * landed; every other registered command keeps the stub.
 */
export function createDispatcher(
  handlers: Partial<Readonly<Record<CommandName, CommandHandler>>> = {},
): (argv: readonly string[], io: DispatchIO) => Promise<number> {
  const table = new Map<CommandName, CommandHandler>();
  for (const spec of COMMANDS) table.set(spec.name, handlers[spec.name] ?? notAvailable);

  return async (argv, io) => {
    const { output } = io;
    // M1-9zd: before help, the command lookup or argument parsing, so no path can print it.
    if (looksLikeOwnerCode(argv)) {
      output.printError(DISPATCH_TEXT.ownerCodeInCommand);
      return EXIT_USAGE;
    }
    const [first, ...rest] = argv;
    if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
      output.print(helpText());
      return EXIT_OK;
    }
    if (first === '--version' || first === '-v') {
      output.print(io.version);
      return EXIT_OK;
    }
    const spec = COMMANDS.find((command) => command.name === first);
    if (spec === undefined) {
      output.printError(DISPATCH_TEXT.unknownCommand);
      return EXIT_USAGE;
    }

    let parsed: ParsedCommand;
    try {
      const result = parseArgs({
        args: [...rest],
        options: spec.options,
        allowPositionals: true,
        strict: true,
      });
      const agentValue = result.values['agent'];
      if (agentValue !== undefined && !isAgentName(agentValue)) {
        output.printError(RUNTIME_MESSAGES.agent_name_invalid);
        return EXIT_USAGE;
      }
      parsed = Object.freeze({
        values: Object.freeze({ ...result.values }) as ParsedCommand['values'],
        positionals: Object.freeze([...result.positionals]),
        agent: typeof agentValue === 'string' ? agentValue : undefined,
      });
    } catch {
      // parseArgs errors name the offending value: never printed (I-5).
      output.printError(DISPATCH_TEXT.badArguments);
      return EXIT_USAGE;
    }

    const guarded =
      spec.guard !== 'none' && (spec.guardWhen === undefined || spec.guardWhen(parsed));
    if (guarded) {
      const check = checkOwnerTerminal(io.terminal);
      if (!check.ok) {
        output.printError(
          check.reason === 'harness_detected'
            ? DISPATCH_TEXT.harnessDetected
            : DISPATCH_TEXT.notInteractive,
        );
        return EXIT_FAILED;
      }
    }

    for (const at of spec.approvalIdAt ?? []) {
      const value = parsed.positionals[at];
      if (value !== undefined && !isApprovalId(value)) {
        output.printError(RUNTIME_MESSAGES.approval_id_invalid);
        return EXIT_USAGE;
      }
    }

    const handler = table.get(spec.name) ?? notAvailable;
    try {
      return await handler({ command: spec.name, parsed, output, terminal: io.terminal });
    } catch (error) {
      // Only the runtime's own fixed messages are printed; any other error text could carry a value
      // (I-5), so it is replaced by fixed text.
      output.printError(
        error instanceof RuntimeError ? RUNTIME_MESSAGES[error.code] : DISPATCH_TEXT.failed,
      );
      return EXIT_FAILED;
    }
  };
}
