// M1-UX-MULTI-AGENT: what `init` and `ui` do on a computer with more than one agent. They list the
// agent names and, in the owner's own terminal, ask for a number. Only names that pass the 06 §6
// pattern are ever shown (a recorded name is agent-written text); nothing else about an agent is.
import { DEFAULT_AGENT_NAME, isAgentName } from '../runtime/agent-name.js';

/** Fixed text (11 §5 plain words). */
export const AGENT_CHOICE_TEXT = Object.freeze({
  listTitle: 'Agents on this computer:',
  question: 'Which one? Type its number:',
  /** Non-interactive form: one line, names separated by commas. */
  namesLine: (names: readonly string[]): string => `Agents on this computer: ${names.join(', ')}.`,
});

/** The valid, distinct agent names, in order. */
export function validAgentNames(names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => isAgentName(n)))];
}

/**
 * Which agent a command without `--agent` means: `default` when it exists (undefined, as the
 * runtime reads it), the only agent when there is one, otherwise `choose` with the names.
 */
export type AgentSelection =
  | { readonly kind: 'default' }
  | { readonly kind: 'one'; readonly name: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'choose'; readonly names: readonly string[] };

export function selectAgent(names: readonly string[]): AgentSelection {
  const valid = validAgentNames(names);
  if (valid.includes(DEFAULT_AGENT_NAME)) return { kind: 'default' };
  const [only] = valid;
  if (valid.length === 1 && only !== undefined) return { kind: 'one', name: only };
  if (valid.length === 0) return { kind: 'none' };
  return { kind: 'choose', names: valid };
}

/** Prints the numbered list and reads one answer; the chosen name, or undefined for a bad answer. */
export async function pickAgent(
  print: (text: string) => void,
  names: readonly string[],
  readLine: () => Promise<string>,
): Promise<string | undefined> {
  print(AGENT_CHOICE_TEXT.listTitle);
  names.forEach((name, index) => print(`  ${index + 1}. ${name}`));
  print(AGENT_CHOICE_TEXT.question);
  const answer = (await readLine()).trim();
  if (!/^[1-9][0-9]{0,2}$/.test(answer)) return undefined;
  return names[Number(answer) - 1];
}
