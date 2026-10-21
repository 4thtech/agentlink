// M1-13b / M1-13d: the I-5 checks, written independently of the product's wrapper (06 §4).
//
// A tool result is split into what is OURS and what is UNTRUSTED:
// - text: every `<untrusted_content ...>` element (its opening line through its own closing line)
//   is untrusted; every other line is ours (the `[AgentLink]` header line, summaries, the footer);
// - structuredContent: the values under an `untrusted` key and a `block` key are untrusted; every
//   other value is ours. Spec-listed exceptions (a sanitised file name in `agentlink_fetch_file`'s
//   `name` and `savedTo`, 06 §2.3) are passed in explicitly by the caller.
//
// Then: inbound bytes appear only on the untrusted side; each element is well formed (one opening
// line with exactly the four attributes, one closing line, nothing that reads as a nested tag);
// nothing anywhere carries a control, bidi or zero-width character.
import { expect } from 'vitest';
import type { McpResult } from './harness.js';

export const OPEN_LINE =
  /^<untrusted_content source="agentlink" from="([^"<>]*)" envelope="([^"<>]*)" type="([^"<>]*)">$/;
export const CLOSE_LINE = '</untrusted_content>';

// Control (except LF), format (bidi, zero-width, BOM, soft hyphen), line and paragraph separators.
const INVISIBLE = /(?!\n)[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Letters a reader takes for the Latin letters of the tag name (a test-side subset). */
const LOOK_ALIKE: Readonly<Record<string, string>> = {
  '\u0430': 'a',
  '\u0441': 'c',
  '\u0435': 'e',
  '\u0456': 'i',
  '\u043e': 'o',
  '\u0440': 'p',
  '\u0455': 's',
  '\u0442': 't',
  '\u0443': 'y',
  '\u043f': 'n', // Cyrillic
  '\u03b1': 'a',
  '\u03b5': 'e',
  '\u03b9': 'i',
  '\u03bf': 'o',
  '\u03c1': 'p',
  '\u03c4': 't',
  '\u03c5': 'u',
  '\u03bd': 'v',
  '\u03b7': 'n', // Greek
};
const ANGLE =
  /[<\uff1c\ufe64\u2039\u3008\u2329\u27e8\u276e\u02c2\u1438\u29fc\u227a\u276c\u2770\u16b2\u300a\u00ab]/gu;
const SLASH = /[/\uff0f\u2215\u2044\u29f8\u2571\\\u29f5]/gu;

/** A folded form for spotting tag look-alikes: NFKC, no marks, lower case, look-alike letters. */
export function fold(text: string): string {
  return Array.from(text.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC').toLowerCase())
    .map((ch) => LOOK_ALIKE[ch] ?? ch)
    .join('')
    .replace(ANGLE, '<')
    .replace(SLASH, '/');
}

/** True when the text holds something a reader could take for an untrusted_content tag. */
export function hasTag(text: string): boolean {
  return /<\s*\/?\s*untrusted[^\p{L}\p{N}]{0,8}content/u.test(fold(text));
}

export interface Split {
  readonly ours: string;
  readonly blocks: readonly { from: string; envelope: string; type: string; content: string }[];
}

/** Splits a text result into our lines and the untrusted elements; fails on a malformed element. */
export function splitText(text: string, where: string): Split {
  const ours: string[] = [];
  const blocks: { from: string; envelope: string; type: string; content: string }[] = [];
  let open: { from: string; envelope: string; type: string; lines: string[] } | undefined;
  for (const line of text.split('\n')) {
    if (open === undefined) {
      if (line.startsWith('<untrusted_content')) {
        const m = OPEN_LINE.exec(line);
        expect(m, `${where}: opening line has exactly the four escaped attributes`).not.toBeNull();
        open = { from: m![1]!, envelope: m![2]!, type: m![3]!, lines: [] };
      } else {
        ours.push(line);
      }
    } else if (line === CLOSE_LINE) {
      blocks.push({ ...open, content: open.lines.join('\n') });
      open = undefined;
    } else {
      open.lines.push(line);
    }
  }
  expect(open, `${where}: every untrusted element is closed`).toBeUndefined();
  for (const block of blocks) {
    expect(hasTag(block.content), `${where}: no tag look-alike inside an element`).toBe(false);
    for (const attr of [block.from, block.envelope, block.type]) {
      expect(attr.length <= 128 * 6, `${where}: attribute cut`).toBe(true);
    }
  }
  expect(hasTag(ours.join('\n')), `${where}: no stray tag in our own text`).toBe(false);
  return { ours: ours.join('\n'), blocks };
}

/** Collects every string of a structured result, split into ours and untrusted. */
export function splitStructured(
  value: unknown,
  exempt: readonly string[] = [],
): { ours: string[]; untrusted: string[]; blocks: string[] } {
  const ours: string[] = [];
  const untrusted: string[] = [];
  const blocks: string[] = [];
  const walk = (v: unknown, side: 'ours' | 'untrusted', key: string | undefined): void => {
    if (typeof v === 'string') {
      if (key === 'block' && side === 'ours') blocks.push(v);
      (side === 'ours' ? ours : untrusted).push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item, side, key);
    } else if (v !== null && typeof v === 'object') {
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        const inner = side === 'untrusted' || k === 'untrusted' ? 'untrusted' : side;
        if (side === 'untrusted') untrusted.push(k);
        else ours.push(k);
        if (k === 'block' && inner === 'ours') {
          walk(item, 'ours', 'block');
        } else {
          walk(item, inner, k);
        }
      }
    }
  };
  walk(value, 'ours', undefined);
  // `block` values are wrapped elements: they count as untrusted, after their own check below.
  const oursClean = ours.filter((s) => !blocks.includes(s) && !exempt.includes(s));
  return { ours: oursClean, untrusted, blocks };
}

export interface CheckOptions {
  /** Values a spec section puts at the top level although they derive from inbound text. */
  readonly exempt?: readonly string[];
}

/**
 * The I-5 check of one tool result against a list of inbound needles (markers and characteristic
 * fragments of the hostile content): none appears in our text or our structured values; every
 * element and every `block` is well formed; no invisible character anywhere.
 */
export function expectContained(
  result: McpResult,
  needles: readonly string[],
  options: CheckOptions = {},
): Split {
  const where = `${result.tool} ${JSON.stringify(result.args).slice(0, 80)}`;
  const split = splitText(result.text, `${where} text`);
  const structured = splitStructured(result.structured, options.exempt ?? []);
  for (const block of structured.blocks) splitText(block, `${where} structured block`);
  const ours = [split.ours, ...structured.ours].join('\n');
  for (const needle of needles) {
    expect(ours.includes(needle), `${where}: inbound "${needle}" outside the untrusted block`).toBe(
      false,
    );
  }
  expect(INVISIBLE.test(result.text), `${where}: invisible character in text`).toBe(false);
  for (const value of [...structured.ours, ...structured.untrusted, ...structured.blocks]) {
    expect(INVISIBLE.test(value), `${where}: invisible character in structuredContent`).toBe(false);
  }
  for (const value of structured.untrusted) {
    expect(hasTag(value), `${where}: tag look-alike in an untrusted value`).toBe(false);
  }
  return split;
}

/** True when the needle reached the model, but only inside an untrusted element. */
export function deliveredWrapped(result: McpResult, needle: string): boolean {
  const split = splitText(result.text, result.tool);
  return split.blocks.some((b) => b.content.includes(needle) || b.from.includes(needle));
}

/** Summaries, `nextStep`, errors: the fields of ours a model reads first (D-55). */
export function oursFields(result: McpResult): string {
  const s = result.structured;
  return [s['summary'], s['nextStep'], s['message'], s['code'], result.isError ? result.text : '']
    .map((v) => (typeof v === 'string' ? v : ''))
    .join('\n');
}
