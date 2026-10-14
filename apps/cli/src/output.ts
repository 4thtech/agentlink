// The CLI's user-output channel: the one place in apps/cli that writes to the terminal directly
// (documented exception to the console ban, eslint.config.mjs CONSOLE_CHANNELS, M0-8).
//
// Use it only for what the user asked to see: command results, `--version`, the setup summary.
// It does not redact, so never pass it diagnostics, inbound content or anything the user did not
// ask to see; diagnostics go through @agentlink/log. Never use it in the stdio MCP server, where
// stdout carries the protocol.

/** Where output goes. The runtime console by default; tests pass their own. */
export interface Terminal {
  log(text: string): void;
  error(text: string): void;
}

const runtimeTerminal = (): Terminal => (globalThis as unknown as { console: Terminal }).console;

export interface Output {
  /** Prints one line of command output on stdout. */
  print(text: string): void;
  /** Prints one line of user-facing error text on stderr. */
  printError(text: string): void;
}

export function createOutput(terminal: Terminal = runtimeTerminal()): Output {
  return {
    print: (text) => terminal.log(text),
    printError: (text) => terminal.error(text),
  };
}
