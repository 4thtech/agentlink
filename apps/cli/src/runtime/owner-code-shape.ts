// M1-9zd: does a command line carry something shaped like a generated owner code? A UX guard only
// (04 §2.5, §2.8; G-1, D-67): it catches an owner code typed as part of a command, which the shell
// keeps in its history, and lets the dispatcher stop before anything runs. It is a shape check, not
// a secret check: nothing is unlocked or compared, and the argument is never stored or printed.
//
// A generated owner code is 24 RFC 4648 base32 characters (`A–Z2–7`), shown in upper case as six
// groups of four separated by spaces (@4thtech-io/node `grouped`). Only the forms a code is shown,
// copied or retyped in are matched, so ordinary text is not (IR-M1-9zd-1 L-1):
// - the 24 characters in one word, in one case;
// - six groups of four in one word, separated by spaces or dashes, in one case;
// - six argv words that are each one group of four (the code typed with spaces, unquoted).
// The joined characters must then read as a code under 04 §2.8 kind 1 (`0`/`1`/`8` as `O`/`I`/`B`,
// then exactly 24 of `A–Z2–7`). Lower case is matched only with a digit in it, so lower-case words
// never are, and the solid form never matches a whole local agent name (06 §6).

import { isAgentName } from './agent-name.js';

const CODE_LENGTH = 24;
const GROUPS = 6;
const SOLID = /^[A-Za-z0-9]{24}$/;
const GROUPED = /^[A-Za-z0-9]{4}(?:[ -][A-Za-z0-9]{4}){5}$/;
const GROUP = /^[A-Za-z0-9]{4}$/;
const BASE32 = /^[A-Z2-7]{24}$/;

/** One case only; lower case only together with a digit (a code always has the case it was shown). */
function caseLooksLikeCode(text: string): boolean {
  const upper = /[A-Z]/.test(text);
  const lower = /[a-z]/.test(text);
  if (upper && lower) return false;
  return !lower || /[0-9]/.test(text);
}

/** The joined characters read as a code under 04 §2.8 kind 1. */
function readsAsCode(chars: string): boolean {
  if (chars.length !== CODE_LENGTH || !caseLooksLikeCode(chars)) return false;
  const read = chars.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  return BASE32.test(read);
}

/** One word in a form a code is shown or pasted in. */
function wordIsCode(word: string): boolean {
  // A whole local agent name is typed on purpose (`--agent`), so the solid form never matches one.
  if (SOLID.test(word)) return !isAgentName(word) && readsAsCode(word);
  if (GROUPED.test(word)) return readsAsCode(word.replace(/[ -]/g, ''));
  return false;
}

/** The value part of `--option=value`, or the word itself. */
const valueOf = (word: string): string => {
  const eq = word.startsWith('--') ? word.indexOf('=') : -1;
  return eq === -1 ? word : word.slice(eq + 1);
};

/**
 * True when any argument, or six consecutive arguments that are each one group of four (a code
 * typed with spaces, which the shell splits into six words), is in a form an owner code is shown in.
 */
export function looksLikeOwnerCode(argv: readonly string[]): boolean {
  const words = argv.map(valueOf);
  for (let i = 0; i < words.length; i += 1) {
    if (wordIsCode(words[i] ?? '')) return true;
    const run = words.slice(i, i + GROUPS);
    if (run.length === GROUPS && run.every((w) => GROUP.test(w)) && readsAsCode(run.join(''))) {
      return true;
    }
  }
  return false;
}
