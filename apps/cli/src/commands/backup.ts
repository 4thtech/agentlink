// UX1113-R1 (D-147; 06 §8; 04 §2.3.3 "Restore"): `agentlink backup restore [file] [--check]` † and
// its alias `agentlink restore [file] [--check]` †. The dispatcher's owner guard has already refused
// a harness marker and a non-interactive terminal (a pipe on stdin). The flow itself, with the hidden
// recovery-code and master-code prompts, runs in @4thtech-io/node (restoreInTerminal), so the code
// never passes through this package: never an argument, environment variable, file or pipe. No MCP
// tool reaches this command (I-4).
import type { RestoreTerminalText, TerminalRestoreOutcome } from '@4thtech-io/node';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandHandler } from '../dispatch.js';
import { BACKUP_TEXT, restoreText } from './backup-strings.js';

export interface BackupDeps {
  /** The restore flow on this user's keychain and own TTY (node's restoreInTerminal). */
  readonly restore: (
    request: { readonly file?: string; readonly check: boolean },
    text: RestoreTerminalText,
  ) => Promise<TerminalRestoreOutcome>;
}

/** The handler of `backup` (only its `restore` subcommand) and of `restore`. */
export function createBackupHandler(deps: BackupDeps): CommandHandler {
  return async ({ command, parsed, output }) => {
    const positionals = [...parsed.positionals];
    if (command === 'backup') {
      if (positionals[0] !== 'restore') {
        output.printError(BACKUP_TEXT.usage());
        return EXIT_USAGE;
      }
      positionals.shift();
    }
    if (positionals.length > 1) {
      output.printError(BACKUP_TEXT.usage());
      return EXIT_USAGE;
    }
    const file = positionals[0];
    const check = parsed.values['check'] === true;
    const outcome = await deps.restore(
      { ...(file === undefined ? {} : { file }), check },
      restoreText(),
    );
    return outcome === 'restored' || outcome === 'checked' ? EXIT_OK : EXIT_FAILED;
  };
}
