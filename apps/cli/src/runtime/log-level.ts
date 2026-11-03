// M1-9y: the log level of the CLI's one-shot commands. Interactive commands (`owner init`, `init`,
// `invite` ...) print their own plain-language output; structured JSON log lines are for debugging,
// so by default none reach the terminal (W8-FEEDBACK-S1, F3). `AGENTLINK_LOG=debug|info|warn|error`
// turns them on. Lines are still redacted by the logger (I-7) and go to stderr.
import { createLogger, LEVELS, type Level, type Logger } from '@4thtech-io/log';

export const DEFAULT_CLI_LOG_LEVEL: Level = 'warn';

/** The level for the CLI's logger: `AGENTLINK_LOG` when it names a level, else the default. */
export function cliLogLevel(env: Readonly<Record<string, string | undefined>>): Level {
  const wanted = env['AGENTLINK_LOG']?.trim().toLowerCase();
  return LEVELS.find((level) => level === wanted) ?? DEFAULT_CLI_LOG_LEVEL;
}

/** True when `AGENTLINK_LOG` names a level: the person asked for structured log lines. */
export function cliLogRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  const wanted = env['AGENTLINK_LOG']?.trim().toLowerCase();
  return LEVELS.some((level) => level === wanted);
}

/**
 * The logger of the interactive commands. Without `AGENTLINK_LOG` the terminal shows only the
 * command's own plain lines, never JSON log lines: it is the same redacting logger, its lines go
 * nowhere. With `AGENTLINK_LOG=<level>` they go to stderr as before.
 */
export function cliLogger(name: string, env: Readonly<Record<string, string | undefined>>): Logger {
  if (cliLogRequested(env)) return createLogger({ name, level: cliLogLevel(env) });
  return createLogger({ name, level: DEFAULT_CLI_LOG_LEVEL, sink: () => undefined });
}
