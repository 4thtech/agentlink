// M1-9zd: does a command line carry something shaped like a generated owner code? A UX guard only
// (04 §2.5, §2.8; G-1, D-67): it catches an owner code typed as part of a command, which the shell
// keeps in its history, and lets the dispatcher stop before anything runs. It is a shape check, not
// a secret check: nothing is unlocked or compared, and the argument is never stored or printed.
//
// The shape is 04 §2.8 `password` kind 1, read the same way: ASCII only, spaces and dashes ignored,
// upper case, `0`/`1`/`8` read as `O`/`I`/`B`, then exactly 24 characters of `A–Z2–7`.
import { isAgentName } from './agent-name.js';

const CODE_LENGTH = 24;
const GROUP = /^[A-Za-z0-9]{4}$/;
const DASHED_GROUPS = /^[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){5}$/;
const BASE32 = /^[A-Z2-7]+$/;

/** The kind 1 reading of `text`, or undefined when it is not 24 base32 characters after it. */
function kind1Shape(text: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- step 1: refuse any byte outside ASCII.
  if (!/^[\x00-\x7f]*$/.test(text)) return undefined;
  const read = text
    .replace(/[ -]/g, '')
    .toUpperCase()
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/8/g, 'B');
  return read.length === CODE_LENGTH && BASE32.test(read) ? read : undefined;
}

/**
 * One word that reads as an owner code. A whole valid local agent name (lower case, 06 §6) is not
 * one, unless it is written in the code's own six dashed groups: agent names are typed on purpose.
 */
function wordIsCode(word: string): boolean {
  if (kind1Shape(word) === undefined) return false;
  return !isAgentName(word) || DASHED_GROUPS.test(word);
}

/** The value part of `--option=value`, or the word itself. */
const valueOf = (word: string): string => {
  const eq = word.startsWith('--') ? word.indexOf('=') : -1;
  return eq === -1 ? word : word.slice(eq + 1);
};

/**
 * True when any argument, or six consecutive four-character arguments (a code typed with spaces,
 * which the shell splits into six words), reads as a generated owner code.
 */
export function looksLikeOwnerCode(argv: readonly string[]): boolean {
  const words = argv.map(valueOf);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? '';
    if (wordIsCode(word)) return true;
    const run = words.slice(i, i + CODE_LENGTH / 4);
    if (run.length === CODE_LENGTH / 4 && run.every((w) => GROUP.test(w))) {
      if (kind1Shape(run.join('')) !== undefined) return true;
    }
  }
  return false;
}
