// Errors of the harness config writers (M1-9a). Every message is fixed text that says what to do:
// no path, config text or value is interpolated and no underlying error is attached (I-5, I-7).
// The harness's own name is added by the caller from a fixed table, never from the file.

export type HarnessErrorCode =
  /** A link, the wrong file type, another owner, a writable-by-others folder or a realpath escape (04 §4). */
  | 'unsafe_path'
  /** The existing file is not valid JSON or TOML, or is too large: nothing is written. */
  | 'malformed'
  /** Larger than AgentLink will read; never "invalid", and never to be moved aside. */
  | 'too_large'
  /** Valid, but not in a form that can be changed with an exact, additive diff: nothing is written. */
  | 'unsupported_format'
  /** The file is not the one that was shown (it changed, or a second name appeared). */
  | 'changed'
  /** The write or the backup failed; the original file is untouched. */
  | 'write_failed';

export const HARNESS_MESSAGES: Readonly<Record<HarnessErrorCode, string>> = Object.freeze({
  unsafe_path:
    "{appName}'s settings are in a place AgentLink won't write to: it must be a plain file in your own folder, with no links. Nothing was changed. Add AgentLink to {appName} by hand instead.",
  malformed:
    "{appName}'s settings file isn't valid, so AgentLink left it alone. Nothing was changed. Fix or move the file, then run `agentlink init` again.",
  too_large:
    "{appName}'s settings file is larger than AgentLink will edit, so it was left alone. Nothing was changed. Add AgentLink to {appName} by hand instead; don't move the file.",
  unsupported_format:
    "AgentLink can't change {appName}'s settings file without rewriting parts you wrote. Nothing was changed. Add AgentLink to {appName} by hand instead.",
  changed:
    "{appName}'s settings changed while AgentLink was working, so nothing was written. Run `agentlink init` again.",
  write_failed: "AgentLink couldn't write {appName}'s settings. Nothing was changed.",
});

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  constructor(code: HarnessErrorCode) {
    super(HARNESS_MESSAGES[code]);
    this.name = 'HarnessError';
    this.code = code;
  }
}
