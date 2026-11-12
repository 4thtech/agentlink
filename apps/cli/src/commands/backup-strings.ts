// UX1113-R1 (D-147; 06 §8 `agentlink backup restore [file] [--check]`, alias `agentlink restore`):
// the terminal words of restore. Plain language (11 §5, D-146): "recovery kit", "recovery code",
// "master code", "ID". Fixed text only: no line ever carries a code, a path or a value typed.
import type { RestoreError, RestoreTerminalText } from '@4thtech-io/node';
import { commandPrefix } from '../runtime/cli-prefix.js';

const ERRORS: Readonly<Record<RestoreError, string>> = Object.freeze({
  not_a_kit: "This isn't an AgentLink recovery kit. Nothing was changed.",
  newer_version: 'This kit was made by a newer AgentLink. Update AgentLink, then try again.',
  other_owner:
    'This kit belongs to a different owner than the one on this computer. Restore it as a new user on this computer, or on a clean computer.',
  wrong_code: "That recovery code doesn't open this kit. Nothing was changed.",
  damaged: "This kit file is damaged and can't be restored. Nothing was changed.",
  wait: 'Too many wrong codes for this kit. Wait a few minutes, then try again.',
  busy: 'Another restore is running on this computer. Finish or cancel it first.',
  presence_required: 'Your master code is needed first.',
  presence_rejected: "That master code didn't work.",
  needs_terminal: "This kit can't be restored here.",
  expired: 'The kit file changed or the restore took too long. Start again.',
  too_large: 'This kit file is too large.',
  invalid: "That choice isn't valid. Nothing was changed.",
  failed: "The restore didn't finish. IDs listed as restored are back; nothing else was changed.",
});

/** The fixed words of `agentlink restore`. */
export const BACKUP_TEXT = Object.freeze({
  checkOpens: 'This kit opens. Nothing was written.',
  usage: () => `Usage: ${commandPrefix()} restore [file] [--check]`,
});

/** What the node restore flow writes (RestoreTerminalText). */
export function restoreText(): RestoreTerminalText {
  return Object.freeze({
    noKit: `No recovery kit was found in Downloads, Desktop or your home folder. Run \`${commandPrefix()} restore <file>\` with the kit's file.`,
    pickKit: 'Which kit? Type its number (Enter for 1): ',
    kitLine: (n: number, name: string) => `  ${String(n)}. ${name}`,
    errors: ERRORS,
    masterCodePrompt: 'Master code of this computer: ',
    recoveryCodePrompt: 'Recovery code (type it yourself, never give it to your AI): ',
    checkOpens: BACKUP_TEXT.checkOpens,
    idLine: (name: string, state: string, people: number) =>
      `  ${name}: ${STATE[state] ?? state}, ${String(people)} ${people === 1 ? 'person' : 'people'}`,
    newName: (name: string, suggested: string) =>
      `An ID named ${name} is already here. New name for this one (Enter for ${suggested}): `,
    confirm: (count: number) =>
      `Restore ${String(count)} ${count === 1 ? 'ID' : 'IDs'} on this computer?`,
    nothingToRestore: 'Every ID in this kit is already here. Nothing was changed.',
    outcomeLine: (name: string, outcome: string) => `  ${name}: ${OUTCOME[outcome] ?? outcome}`,
    masterCodeShown:
      'Your new master code. Write it down now: it is shown only once. Your recovery code does not change.',
    savedIt: 'Did you write down your new master code?',
    nextSteps: `Done. Reconnect your AI apps and your own storage. Still have the old computer? Remove AgentLink there. \`${commandPrefix()} doctor\` shows the restored owner.`,
  });
}

const STATE: Readonly<Record<string, string>> = Object.freeze({
  new: 'will be restored',
  name_taken: 'name taken here, comes back under a new name',
  already_here: 'already here, skipped',
  removed_earlier: 'removed earlier, not restored',
});

const OUTCOME: Readonly<Record<string, string>> = Object.freeze({
  restored: 'restored',
  failed: 'not restored',
  skipped: 'skipped',
});
