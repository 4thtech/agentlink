// M1-9y: the log level of the CLI's one-shot commands. Interactive commands (`owner init`, `init`,
// `invite` ...) print their own plain-language output; structured JSON log lines are for debugging,
// so by default only warnings and errors reach the terminal. `AGENTLINK_LOG=debug|info|warn|error`
// turns more on. Lines are still redacted by the logger (I-7) and go to stderr.
import { LEVELS, type Level } from '@agentlink/log';

export const DEFAULT_CLI_LOG_LEVEL: Level = 'warn';

/** The level for the CLI's logger: `AGENTLINK_LOG` when it names a level, else the default. */
export function cliLogLevel(env: Readonly<Record<string, string | undefined>>): Level {
  const wanted = env['AGENTLINK_LOG']?.trim().toLowerCase();
  return LEVELS.find((level) => level === wanted) ?? DEFAULT_CLI_LOG_LEVEL;
}
