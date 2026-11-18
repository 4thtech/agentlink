// SEC-CARD-FULLTEXT (08 §1 "What the card shows"; 11 §5, §6.2.1; 04 §2.5.3 "Prompt text"; I-5): the
// approval card's exact-content block, as types and pure helpers shared by apps/cli (the source that
// builds it from the stored action), packages/node (the server that checks it) and apps/local-ui
// (the page that renders it).
//
// - `inertText`: the full message text as plain, inert text. Line breaks and tabs stay; every other
//   control, format (bidi, zero-width), separator, private-use, surrogate or unassigned character is
//   replaced by a visible marker such as `[U+202E]`, so nothing can reorder or hide what the owner
//   reads. Never cut: the card shows every character (no silent truncation).
// - `checkCode`: a short code for a SHA-256 value (the envelope hash, a file's plaintextSha256):
//   the first 80 bits in Crockford base32, 16 characters in four groups. Stable and the same on
//   both sides, so the recipient can compare it later.
// - `presencePromptDetail`: the one-line "for Ana, $0.10" the server adds to the OS presence prompt
//   (Touch ID reason), from the card's who and cost only.
import { refusedCategory15 } from '../unicode.js';

/** The bits a check code carries (D3: at least 80, never a short code as a decision field). */
export const CHECK_CODE_BITS = 80;
/** The characters of a check code, without the group spaces. */
export const CHECK_CODE_CHARS = CHECK_CODE_BITS / 5;
/** Crockford base32 (no I, L, O, U): easy to read aloud and compare. */
export const CHECK_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A check code as shown: four groups of four, single spaces. */
export const CHECK_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}( [0-9A-HJKMNP-TV-Z]{4}){3}$/;

/** The presence prompt detail is at most this many code points. */
export const PRESENCE_DETAIL_MAX = 64;
/** The contact name inside the presence prompt detail is cut to this many code points. */
export const PRESENCE_NAME_MAX = 32;

const HASH = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * The check code of a SHA-256 value (64 hex, optionally `0x`): its first 80 bits in Crockford
 * base32, as "XXXX XXXX XXXX XXXX". Throws on anything else (never a code for a malformed value).
 */
export function checkCode(hashHex: string): string {
  if (typeof hashHex !== 'string' || !HASH.test(hashHex)) {
    throw new TypeError('checkCode: expected a 32-byte hex hash');
  }
  const hex = hashHex
    .replace(/^0x/, '')
    .toLowerCase()
    .slice(0, CHECK_CODE_BITS / 4);
  let bits = BigInt(`0x${hex}`);
  let out = '';
  for (let i = 0; i < CHECK_CODE_CHARS; i += 1) {
    out = CHECK_CODE_ALPHABET[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out.replace(/(.{4})(?=.)/g, '$1 ');
}

const marker = (cp: number): string => `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`;

/**
 * The full text as plain, inert text: CRLF and CR become LF; LF and TAB stay; every other character
 * of a refused category (Cc, Cf incl. bidi and zero-width, Zl, Zp, Co, Cs, Cn) becomes a visible
 * `[U+XXXX]` marker. Nothing is removed or cut.
 */
export function inertText(text: string): string {
  if (typeof text !== 'string') return '';
  let out = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x0a || cp === 0x09) out += ch;
    else out += refusedCategory15(cp) === null ? ch : marker(cp);
  }
  return out;
}

/** Whether `text` is already inert: no refused character except LF and TAB. */
export function isInertText(text: string): boolean {
  if (typeof text !== 'string') return false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp !== 0x0a && cp !== 0x09 && refusedCategory15(cp) !== null) return false;
  }
  return true;
}

/** The length the card states: code points of the original text. */
export function textLength(text: string): number {
  return typeof text === 'string' ? Array.from(text).length : 0;
}

/** One line: refused characters dropped, any whitespace run one space, trimmed. */
function oneLine(text: string): string {
  let plain = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (/\s/u.test(ch)) plain += ' ';
    else if (refusedCategory15(cp) === null) plain += ch;
  }
  return plain.replace(/ +/g, ' ').trim();
}

const cutPoints = (text: string, max: number): string => {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
};

const COST = /^\$\d{1,9}(\.\d{2})?$/;

/**
 * The presence prompt detail, "for Ana, $0.10" (or "for Ana, free"), built from the card's who and
 * cost only (never AI text beyond the 06 §2.1 name). The name is cut to PRESENCE_NAME_MAX code
 * points; a cost that is not an exact dollar amount reads "free" only when it is "Free", else it
 * is left out. Empty when there is nothing to say.
 */
export function presencePromptDetail(who: string, cost: string): string {
  const name = cutPoints(oneLine(typeof who === 'string' ? who : ''), PRESENCE_NAME_MAX);
  const price =
    typeof cost === 'string' ? (COST.test(cost) ? cost : cost === 'Free' ? 'free' : '') : '';
  const parts = [name, price].filter((p) => p !== '');
  if (parts.length === 0) return '';
  return cutPoints(`for ${parts.join(', ')}`, PRESENCE_DETAIL_MAX);
}

/** One file of the content block (all display strings, from the stored payload). */
export interface ApprovalContentFile {
  readonly name: string;
  /** "12 KB". */
  readonly size: string;
  /** "PDF document", or the media type. */
  readonly type: string;
  /** checkCode(plaintextSha256). */
  readonly checkCode: string;
}

/**
 * The exact content a request is about, decoded by the app from the stored, digest-bound action
 * (or the stored envelope its hash names), never from what the AI wrote about it.
 */
export interface ApprovalContent {
  /** Fixed text: "Exactly what will be sent", "The message this proof is for", … */
  readonly label: string;
  /** inertText of the full text. */
  readonly text: string;
  /** textLength of the original text. */
  readonly length: number;
  /** checkCode of the envelope hash, when there is an envelope. */
  readonly checkCode?: string;
  readonly files: readonly ApprovalContentFile[];
}

/** Longest content text the server passes to the page (UTF-16 units). */
export const APPROVAL_CONTENT_MAX = 262_144;
/** Most files on one card (the payload's own cap is lower). */
export const APPROVAL_CONTENT_FILES_MAX = 64;
