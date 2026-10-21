// Small helpers shared by the components (M1-35b).

/** Join the truthy class names. */
export function cx(...names: ReadonlyArray<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

// Code point ranges that have no place in a name, a file name or a line of another party's text
// (11 §5.2, 04 §4): C0 and C1 controls, zero-width characters, the bidi marks, embeddings and
// overrides, word joiner and isolates, and the byte order mark. Listed as numbers so this file holds
// none of those characters itself.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
  // Unicode tag characters: invisible, and used to smuggle text past a reader.
  [0xe0000, 0xe007f],
];

function isUnsafe(codePoint: number): boolean {
  return UNSAFE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/** Remove control, bidi and zero-width characters, then cut to `max` characters.
 * With `multiline`, tab and line feed stay (message body text). */
export function cleanText(text: string, max = 10_000, multiline = false): string {
  let out = '';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    // Message bodies keep line breaks and tabs; names, file names and labels do not.
    if (multiline && (cp === 0x09 || cp === 0x0a)) out += ch;
    else if (!isUnsafe(cp)) out += ch;
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/** A lower-case key in sentence case ("not-confirmed" becomes "Not confirmed"). */
export function sentence(key: string): string {
  const text = key.replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
