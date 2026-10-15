// The untrusted-content wrapper (06 §4, I-5; M1-9c). Every value another party chose (and every
// value our own agent wrote, which inbound content can steer, 06 §2.1) reaches the model only inside
// one `<untrusted_content>` element, in the text result and in `structuredContent`.
//
// - Content: control, bidi and zero-width (format) characters are removed, CR LF becomes LF, a tab a
//   space, and every opening or closing `untrusted_content` tag is escaped (its `<` becomes `&lt;`),
//   whatever its case, spacing or look-alike characters (fullwidth, mathematical, Cyrillic or Greek
//   letters, other angle brackets and slashes, combining marks, separators).
// - Attributes (`from`, `envelope`, `type`): the same characters removed, line breaks made spaces,
//   cut to 128 code points, then `&`, `"`, `<` and `>` escaped (the cut comes first, so no escape is
//   ever split).
// - The header line and the footer are ours: the header carries names under the 06 §2.1 rule only,
//   and the footer is the fixed UNTRUSTED_FOOTER (strings/index.ts), which copy never changes.
import { UNTRUSTED_FOOTER } from './strings/index.js';

/** Attribute values are cut to this many code points (06 §4). */
export const UNTRUSTED_ATTRIBUTE_MAX = 128;

// C0 except LF (CR and TAB are mapped first), DEL, C1; format characters (bidi controls, zero-width
// characters, soft hyphen, BOM, …); line and paragraph separators.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Removes control (except LF), bidi, zero-width and other format characters (06 §4). */
export function removeInvisible(text: string): string {
  return text
    .replace(LONE_SURROGATE, '\ufffd')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(INVISIBLE, (ch) => (ch === '\n' ? ch : ''));
}

// ---- Tag look-alikes ----------------------------------------------------------------------------

/** Characters a reader may take for `<`. */
const LESS_THAN = new Set([
  '<',
  '\uff1c', // fullwidth
  '\ufe64', // small
  '\u2039', // single left angle quotation mark
  '\u3008', // CJK left angle bracket
  '\u2329', // left-pointing angle bracket
  '\u27e8', // mathematical left angle bracket
  '\u276e', // heavy left-pointing angle quotation mark ornament
  '\u02c2', // modifier letter left arrowhead
  '\u1438', // Canadian syllabics pa
  '\u29fc', // left-pointing curved angle bracket
  '\u227a', // precedes
]);

/** Characters a reader may take for `/`. */
const SLASH = new Set(['/', '\uff0f', '\u2215', '\u2044', '\u29f8', '\u2571', '\\', '\u29f5']);

/** Letters that look like the Latin letters of the tag name (after lower-casing). */
const CONFUSABLE: Readonly<Record<string, string>> = {
  // Cyrillic
  '\u0430': 'a',
  '\u0441': 'c',
  '\u0501': 'd',
  '\u0435': 'e',
  '\u0456': 'i',
  '\u043e': 'o',
  '\u0440': 'p',
  '\u0433': 'r',
  '\u0455': 's',
  '\u0442': 't',
  '\u0443': 'y',
  '\u0445': 'x',
  // Greek
  '\u03b1': 'a',
  '\u03f2': 'c',
  '\u03b5': 'e',
  '\u03b9': 'i',
  '\u03bf': 'o',
  '\u03c1': 'p',
  '\u03c4': 't',
  '\u03c5': 'u',
  '\u03bd': 'v',
  '\u03b7': 'n',
  // Armenian
  '\u0578': 'n',
  '\u057d': 'u',
  // Latin extensions
  '\u0131': 'i',
  '\u027e': 'r',
  '\u0280': 'r',
  '\u1d1b': 't',
  '\u1d1c': 'u',
  '\u0274': 'n',
  '\ua731': 's',
  '\u1d07': 'e',
  '\u1d05': 'd',
  '\u1d04': 'c',
  '\u1d0f': 'o',
};

/** A code point folded for tag matching: compatibility form, no marks, lower case, look-alikes. */
function fold(cp: string): string {
  if (LESS_THAN.has(cp)) return '<';
  if (SLASH.has(cp)) return '/';
  let out = '';
  for (const ch of cp.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()) {
    if (LESS_THAN.has(ch)) out += '<';
    else if (SLASH.has(ch)) out += '/';
    else out += CONFUSABLE[ch] ?? ch;
  }
  return out;
}

// After folding: `<`, optional `/`, the tag name with any separators between its two words.
const TAG = /<\s*\/?\s*untrusted[\s_\-.\u00b7\u2010-\u2015\u2212]*content/gu;

/** Escapes every opening or closing `untrusted_content` tag, including look-alike forms. */
function escapeTags(text: string): string {
  const points = Array.from(text);
  let folded = '';
  const owner: number[] = []; // folded offset → index in `points`
  points.forEach((cp, index) => {
    const f = fold(cp);
    folded += f;
    for (let k = 0; k < f.length; k += 1) owner.push(index);
  });
  const escape = new Set<number>();
  for (const match of folded.matchAll(TAG)) escape.add(owner[match.index]!);
  if (escape.size === 0) return text;
  return points.map((cp, index) => (escape.has(index) ? '&lt;' : cp)).join('');
}

/** Content for inside the block (06 §4): invisible characters removed, tag look-alikes escaped. */
export function sanitizeUntrustedText(text: string): string {
  return escapeTags(removeInvisible(text));
}

/** An attribute value (06 §4): one line, at most 128 code points, then `& " < >` escaped. */
export function escapeAttribute(value: string): string {
  const oneLine = removeInvisible(value).replace(/\n/g, ' ');
  return Array.from(oneLine)
    .slice(0, UNTRUSTED_ATTRIBUTE_MAX)
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * A structured untrusted value with every string leaf and every object key sanitized as content
 * (06 §2.2, IR-M1-9j-1 F07). Objects come back with a null prototype, so a `__proto__` key stays an
 * ordinary key. Values that are not JSON (functions, symbols, undefined) are dropped.
 */
export function sanitizeUntrustedValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeUntrustedText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeUntrustedValue(item) ?? null);
  if (typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const clean = sanitizeUntrustedValue(item);
      if (clean !== undefined) out[sanitizeUntrustedText(key)] = clean;
    }
    return out;
  }
  return undefined;
}

export interface UntrustedBlockInput {
  /** Our header text (names under the 06 §2.1 rule only); shown after "[AgentLink] ". */
  readonly header: string;
  /** The sender's self-declared name (or `you`, `unknown sender`). Escaped here. */
  readonly from: string;
  readonly envelope: string;
  readonly type: string;
  /** The content as shown: sanitized here. */
  readonly content: string;
}

/** One item's block (06 §4): the header line and the `<untrusted_content>` element. */
export function untrustedBlock(input: UntrustedBlockInput): string {
  const header = removeInvisible(input.header).replace(/\n/g, ' ');
  const attrs =
    `source="agentlink" from="${escapeAttribute(input.from)}" ` +
    `envelope="${escapeAttribute(input.envelope)}" type="${escapeAttribute(input.type)}"`;
  return [
    `[AgentLink] ${header}`,
    `<untrusted_content ${attrs}>`,
    sanitizeUntrustedText(input.content),
    '</untrusted_content>',
  ].join('\n');
}

/** The text result for one or more blocks: each block in order, then the footer once (06 §4). */
export function untrustedText(blocks: readonly string[]): string {
  return `${blocks.join('\n')}\n${UNTRUSTED_FOOTER}`;
}
