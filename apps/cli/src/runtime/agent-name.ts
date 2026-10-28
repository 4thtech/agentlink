// Local agent names (06 §6, IR-M1-9j-1 F02). The whole name matches `[a-z][a-z0-9-]{0,31}` with
// nothing before or after it: in JavaScript `$` without the `m` flag matches only at the very end,
// so a trailing newline is refused too. 1 to 32 characters, lower-case letters, digits and `-`,
// starting with a letter; it can never start with `-`, so it can never be read as an option.
//
// The name is a local label only. `init` may be run by the agent (06 §7), so a recorded name is
// agent-written text: it is checked again wherever it is used, and never shown in an error.

/** 06 §6: the exact pattern, without the `m` flag. */
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The default agent's name (06 §6). */
export const DEFAULT_AGENT_NAME = 'default';

/** True only for a string that is a whole valid local agent name. */
export function isAgentName(value: unknown): value is string {
  return typeof value === 'string' && AGENT_NAME_PATTERN.test(value);
}

/**
 * U3-c (06 §6 labels; 11 §5.8): the owner's label for an agent: 1 to 32 code points of letters,
 * digits, spaces, `.`, `'` and `-`, in Unicode NFC, not starting or ending with a space and without
 * two spaces in a row. Plain text only: no control, format, bidi or combining character can pass.
 */
const LABEL_CHARS = /^[\p{L}\p{N} .'-]+$/u;

export function isAgentLabel(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  if (length < 1 || length > 32) return false;
  if (value.normalize('NFC') !== value) return false;
  if (value.startsWith(' ') || value.endsWith(' ') || value.includes('  ')) return false;
  return LABEL_CHARS.test(value);
}
