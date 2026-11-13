// REL051-A34 (D-149; 08 §1; I-5): the in-repo Markdown and code renderer for a received text file.
// Another party wrote every byte, so this builds React elements from a small, fixed subset and
// nothing else; React escapes every string. No dependency, no HTML parser, no raw markup injection.
//
// Blocks: ATX and setext headings, paragraphs, fenced code, bullet and numbered lists, block quotes,
// pipe tables and rules. Inline: emphasis, strong, strikethrough, code spans, links, images, and
// autolinks / bare web addresses. Everything else is text, raw HTML included.
//
// Safety rules:
// - Hidden and direction characters are removed first (cleanText), as everywhere else (11 §5.2).
// - A link is never an anchor and never navigates: its text, then an inert chip with the domain. A
//   web address (http, https) can only be copied, by an explicit click; any other scheme
//   (javascript:, data:, file:, vbscript:, mailto: …) shows "Link removed" and is not kept anywhere.
// - An image is never loaded: an inert chip with its alt text and domain, never the address.
// - Nesting of quotes and lists is capped (MAX_DEPTH); deeper content is shown as plain text.
// - Every inline search remembers what it found, and no address or label is longer than a fixed
//   bound, so a run of delimiters is linear, not quadratic.
// - Output is bounded and progressive (IR-REL051-A34-1): one hard cap covers the whole document
//   (MARKDOWN_TOTAL drawn elements: blocks, rows and cells, list items, formatted pieces; past it
//   the rest is plain text under a short note). The document is parsed once, split into top-level
//   pieces of bounded cost (long lists and tables are split into runs of items and rows; one item,
//   quote, row or paragraph costs at most MARKDOWN_PIECE_MAX), and drawn a slice at a time: the
//   first slice at once, the others in later tasks (MARKDOWN_SLICE elements each), so the page stays
//   responsive and closing the reader stops the drawing.
// - Document headings start at h3 (the reader's own title is the dialog's h2).
import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Icon } from './brand.js';
import { cleanText, cx } from './util.js';

/** The most characters rendered (the preview cap is 256 KB). */
const MAX_CHARS = 300_000;
/** The deepest a quote or list nests; deeper content is plain text. */
export const MARKDOWN_MAX_DEPTH = 6;
/** The deepest emphasis nests inside emphasis or a link. */
const MAX_INLINE_DEPTH = 4;
const MAX_TABLE_COLUMNS = 32;
const MAX_TABLE_ROWS = 2_000;
const MAX_URL_CHARS = 2_048;
/** The most formatted pieces in one paragraph or cell; the rest is plain text. */
const MAX_INLINE_NODES = 1_000;
/** The longest link text read as a link; longer is text. */
const MAX_LABEL_CHARS = 4_096;
/** The hard cap on drawn elements for one document; past it the rest is plain text. */
export const MARKDOWN_TOTAL = 30_000;
/** About how many elements one slice draws (the first one at once, the others in later tasks). */
export const MARKDOWN_SLICE = 600;
/** The most one top-level piece (a list item, quote, table row or paragraph) may draw. */
export const MARKDOWN_PIECE_MAX = 1_200;
/** The most numbered lines SafeCode draws; the rest is plain text. */
export const CODE_MAX_LINES = 1_500;
const COPIED_MS = 1_600;

export interface MarkdownLabels {
  readonly copy: string;
  readonly copied: string;
  /** "Copy link: {url}" (the chip's accessible name). */
  readonly copyLink: string;
  /** The chip's tooltip prefix: "Link not opened". */
  readonly linkNotOpened: string;
  /** A link with an address that is not a web address. */
  readonly linkRemoved: string;
  /** An image that is never loaded. */
  readonly imageNotLoaded: string;
  /** A code block without a language. */
  readonly code: string;
  /** The note before the part past the output budget. */
  readonly rest: string;
}

export const MARKDOWN_LABELS: MarkdownLabels = Object.freeze({
  copy: 'Copy',
  copied: 'Copied',
  copyLink: 'Copy link',
  linkNotOpened: 'Link not opened',
  linkRemoved: 'Link removed',
  imageNotLoaded: 'Image not loaded',
  code: 'Code',
  rest: 'The rest of this file is shown as plain text.',
});

/**
 * The same characters util.ts cleanText removes from multi-line text (controls but tab and line
 * feed, zero-width, bidi marks, embeddings, overrides and isolates, word joiner, BOM, tag
 * characters), in one pass: a 256 KB file is cleaned in a few milliseconds.
 */
const HIDDEN_MULTILINE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

function cleanDocument(text: string): string {
  return String(text)
    .slice(0, MAX_CHARS * 2)
    .replace(HIDDEN_MULTILINE, '')
    .slice(0, MAX_CHARS);
}

/** What is left of an output budget. */
interface Budget {
  left: number;
}

/** A budget of at most `max` taken from `parent`; `settle` charges the parent what was used. */
function sub(parent: Budget, max: number): { readonly budget: Budget; settle: () => void } {
  const budget = { left: Math.max(0, Math.min(parent.left, max)) };
  const start = budget.left;
  return {
    budget,
    settle: () => {
      parent.left -= start - budget.left;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Blocks

type Align = 'left' | 'center' | 'right' | undefined;
type Cells = readonly (readonly Inline[])[];
type Block =
  | { readonly t: 'p'; readonly nodes: readonly Inline[] }
  | { readonly t: 'h'; readonly level: number; readonly nodes: readonly Inline[] }
  | { readonly t: 'code'; readonly lang: string; readonly text: string }
  | { readonly t: 'quote'; readonly children: readonly Block[] }
  | {
      readonly t: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly Block[])[];
      /** REL051-R2C (R2-CLASS-07): per item, a task-list box (`[ ]` / `[x]`), else undefined. */
      readonly tasks?: readonly (boolean | undefined)[];
      /** A later run of the same list (split for drawing). */
      readonly cont?: true;
    }
  | {
      readonly t: 'table';
      readonly head: Cells;
      readonly align: readonly Align[];
      readonly rows: readonly Cells[];
      /** A later run of the same table's rows (split for drawing): no head row. */
      readonly cont?: true;
    }
  | { readonly t: 'hr' }
  /** Past the output budget: the remaining lines as plain text. */
  | { readonly t: 'rest'; readonly text: string };

/** One top-level piece and what it draws. */
interface Piece {
  readonly block: Block;
  readonly cost: number;
}

/** Inline formatting of `text`, charged to `budget` (plain text once it is spent). */
function inl(text: string, budget: Budget): Inline[] {
  if (budget.left <= 0) return text === '' ? [] : [{ t: 'text', text }];
  const meter = sub(budget, MAX_INLINE_NODES);
  const nodes = parseInline(text, 0, false, meter.budget);
  meter.settle();
  return nodes;
}

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( *)([-*+]|[0-9]{1,9}[.)])([ \t]+|$)/;
/** REL051-R2C (R2-CLASS-07): a task-list item's box at the start of a bullet item. */
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
const SETEXT_1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_2 = /^ {0,3}-+[ \t]*$/;

const isBlank = (line: string): boolean => line.trim().length === 0;
const indentOf = (line: string): number => {
  let n = 0;
  while (n < line.length && line[n] === ' ') n += 1;
  return n;
};

function isRule(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || indentOf(line) > 3) return false;
  const c = t[0];
  if (c !== '-' && c !== '*' && c !== '_') return false;
  let count = 0;
  for (const ch of t) {
    if (ch === c) count += 1;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return count >= 3;
}

/** Splits a table row on unescaped pipes, without the outer ones. */
function cells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i] as string;
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (ch === '|') {
      out.push(cur.trim());
      if (out.length > MAX_TABLE_COLUMNS) break;
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (out.length <= MAX_TABLE_COLUMNS) out.push(cur.trim());
  return out.slice(0, MAX_TABLE_COLUMNS);
}

const DELIMITER_CELL = /^:?-+:?$/;
function delimiterRow(line: string): Align[] | undefined {
  if (!line.includes('-')) return undefined;
  const parts = cells(line);
  if (parts.length === 0) return undefined;
  const align: Align[] = [];
  for (const p of parts) {
    if (!DELIMITER_CELL.test(p)) return undefined;
    const left = p.startsWith(':');
    const right = p.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : undefined);
  }
  return align;
}

/** True when the line starts a block that ends a paragraph. */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || isRule(line) || LIST.test(line)
  );
}

function headingText(line: string, hashes: number, skip: number): string {
  let text = line.slice(skip).trimEnd();
  // A closing run of #, when it stands alone or follows a space.
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end === 0) return '';
  if (end < text.length && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
    text = text.slice(0, end).trimEnd();
  }
  void hashes;
  return text;
}

function parseBlocks(lines: readonly string[], depth: number, budget: Budget): Block[] {
  return parseLevel(lines, depth, budget, undefined);
}

/**
 * The blocks of `lines`. At the top level (`pieces` given) every block is also pushed as a piece
 * with its cost; long lists and tables are split into runs of at most MARKDOWN_SLICE, and one item,
 * quote or row draws at most MARKDOWN_PIECE_MAX.
 */
function parseLevel(
  lines: readonly string[],
  depth: number,
  budget: Budget,
  pieces: Piece[] | undefined,
): Block[] {
  const out: Block[] = [];
  const top = pieces !== undefined;
  let mark = budget.left;
  const push = (block: Block): void => {
    out.push(block);
    if (pieces !== undefined) {
      pieces.push({ block, cost: Math.max(1, mark - budget.left) });
      mark = budget.left;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    mark = budget.left;
    if (budget.left <= 0) {
      push({ t: 'rest', text: lines.slice(i).join('\n') });
      break;
    }

    const fence = FENCE.exec(line);
    if (fence !== null && !(fence[2]?.startsWith('`') === true && fence[3]?.includes('`'))) {
      const indent = fence[1]?.length ?? 0;
      const marker = fence[2] as string;
      const lang = (fence[3] ?? '').trim().split(/\s/, 1)[0]?.slice(0, 24) ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i] as string;
        const close = FENCE.exec(l);
        if (
          close !== null &&
          close[2]?.[0] === marker[0] &&
          (close[2]?.length ?? 0) >= marker.length &&
          (close[3] ?? '').trim() === ''
        ) {
          i += 1;
          break;
        }
        body.push(l.slice(Math.min(indent, indentOf(l))));
        i += 1;
      }
      budget.left -= 10;
      push({ t: 'code', lang, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      budget.left -= 1;
      push({ t: 'h', level, nodes: inl(headingText(line, level, heading[0].length), budget) });
      i += 1;
      continue;
    }

    if (isRule(line)) {
      budget.left -= 1;
      push({ t: 'hr' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        inner.push((lines[i] as string).replace(QUOTE, ''));
        i += 1;
      }
      budget.left -= 1;
      if (depth >= MARKDOWN_MAX_DEPTH) {
        push({ t: 'p', nodes: [{ t: 'text', text: inner.join('\n') }] });
      } else {
        const part = sub(budget, top ? MARKDOWN_PIECE_MAX : Infinity);
        const children = parseBlocks(inner, depth + 1, part.budget);
        part.settle();
        push({ t: 'quote', children });
      }
      continue;
    }

    const list = LIST.exec(line);
    if (list !== null && indentOf(line) <= 3) {
      const ordered = /[0-9]/.test(list[2] ?? '');
      const kind = ordered ? (list[2] ?? '').slice(-1) : (list[2] ?? '');
      const start = ordered ? Math.min(Number.parseInt(list[2] ?? '1', 10), 1e9) : 1;
      let items: Block[][] = [];
      let tasks: (boolean | undefined)[] = [];
      let first = start;
      let runs = 0;
      const taskPart = (): { tasks?: (boolean | undefined)[] } =>
        tasks.some((x) => x !== undefined) ? { tasks } : {};
      const flushRun = (): void => {
        if (items.length === 0) return;
        push({
          t: 'list',
          ordered,
          start: first,
          items,
          ...taskPart(),
          ...(runs > 0 ? { cont: true } : {}),
        });
        first += items.length;
        items = [];
        tasks = [];
        runs += 1;
      };
      budget.left -= 1;
      while (i < lines.length) {
        // Past the budget the list ends here; the next pass shows the rest as text.
        if (budget.left <= 0) break;
        const head = LIST.exec(lines[i] as string);
        if (head === null || indentOf(lines[i] as string) > 3) break;
        const headKind = /[0-9]/.test(head[2] ?? '') ? (head[2] ?? '').slice(-1) : head[2];
        if (headKind !== kind) break;
        const spaces = (head[3] ?? '').length;
        const offset =
          (head[1]?.length ?? 0) +
          (head[2]?.length ?? 0) +
          (spaces > 4 || spaces === 0 ? 1 : spaces);
        const body: string[] = [(lines[i] as string).slice(head[0].length)];
        i += 1;
        while (i < lines.length) {
          const l = lines[i] as string;
          if (isBlank(l)) {
            // A blank line stays in the item only when the next text is indented under it.
            let j = i + 1;
            while (j < lines.length && isBlank(lines[j] as string)) j += 1;
            if (j < lines.length && indentOf(lines[j] as string) >= offset) {
              for (; i < j; i += 1) body.push('');
              continue;
            }
            break;
          }
          if (indentOf(l) >= offset) {
            body.push(l.slice(offset));
            i += 1;
            continue;
          }
          // A lazy continuation of the item's paragraph.
          if (!startsBlock(l) && !isBlank(body[body.length - 1] ?? '')) {
            body.push(l.trimStart());
            i += 1;
            continue;
          }
          break;
        }
        budget.left -= 1;
        const box = ordered ? null : TASK.exec(body[0] ?? '');
        if (box === null) tasks.push(undefined);
        else {
          tasks.push(box[1] !== ' ');
          body[0] = (body[0] ?? '').slice(box[0].length);
        }
        const part = sub(budget, top ? MARKDOWN_PIECE_MAX : Infinity);
        items.push(
          depth >= MARKDOWN_MAX_DEPTH
            ? [{ t: 'p', nodes: [{ t: 'text', text: body.join('\n') }] }]
            : parseBlocks(body, depth + 1, part.budget),
        );
        part.settle();
        if (top && mark - budget.left >= MARKDOWN_SLICE) flushRun();
        // A blank line between items ends the list unless another item follows.
        let j = i;
        while (j < lines.length && isBlank(lines[j] as string)) j += 1;
        if (j < lines.length && LIST.test(lines[j] as string)) i = j;
      }
      if (top) flushRun();
      else if (items.length > 0) push({ t: 'list', ordered, start, items, ...taskPart() });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length) {
      const align = delimiterRow(lines[i + 1] as string);
      if (align !== undefined) {
        const headText = cells(line);
        if (headText.length === align.length) {
          budget.left -= 1;
          const row = (texts: readonly string[]): Inline[][] => {
            budget.left -= 1;
            const part = sub(budget, top ? MARKDOWN_PIECE_MAX : Infinity);
            const out2 = texts.map((c) => {
              part.budget.left -= 1;
              return inl(c, part.budget);
            });
            part.settle();
            return out2;
          };
          const head = row(headText);
          let rows: Cells[] = [];
          let runs = 0;
          const flushRun = (): void => {
            if (runs > 0 && rows.length === 0) return;
            push({ t: 'table', head, align, rows, ...(runs > 0 ? { cont: true } : {}) });
            rows = [];
            runs += 1;
          };
          let count = 0;
          i += 2;
          while (i < lines.length) {
            const l = lines[i] as string;
            if (isBlank(l) || !l.includes('|') || startsBlock(l)) break;
            // Past the row cap or the budget the table ends; the next pass shows the rest.
            if (count >= MAX_TABLE_ROWS || budget.left <= 0) break;
            rows.push(row(cells(l).slice(0, head.length)));
            count += 1;
            i += 1;
            if (top && mark - budget.left >= MARKDOWN_SLICE) flushRun();
          }
          if (top) flushRun();
          else push({ t: 'table', head, align, rows });
          continue;
        }
      }
    }

    // A paragraph, or a setext heading.
    const para: string[] = [line.trim()];
    i += 1;
    let setext = 0;
    while (i < lines.length) {
      const l = lines[i] as string;
      if (isBlank(l)) break;
      if (SETEXT_1.test(l)) {
        setext = 1;
        i += 1;
        break;
      }
      if (SETEXT_2.test(l)) {
        setext = 2;
        i += 1;
        break;
      }
      if (startsBlock(l)) break;
      para.push(l.trim());
      i += 1;
    }
    budget.left -= 1;
    const nodes = inl(para.join('\n'), budget);
    push(setext === 0 ? { t: 'p', nodes } : { t: 'h', level: setext, nodes });
  }
  return out;
}

/** The document as top-level pieces with their costs, within MARKDOWN_TOTAL. */
function parseDocument(text: string): readonly Piece[] {
  const pieces: Piece[] = [];
  parseLevel(cleanDocument(text).split('\n'), 0, { left: MARKDOWN_TOTAL }, pieces);
  return pieces;
}

/** The number of pieces the next slice draws, from `from` (at least one). */
function sliceEnd(pieces: readonly Piece[], from: number): number {
  let cost = 0;
  let end = from;
  while (
    end < pieces.length &&
    (end === from || cost + (pieces[end]?.cost ?? 0) <= MARKDOWN_SLICE)
  ) {
    cost += pieces[end]?.cost ?? 0;
    end += 1;
  }
  return end;
}

// ---------------------------------------------------------------------------------------------
// Inline

const PUNCT = /[!-/:-@[-`{-~]/;
const isSpace = (ch: string | undefined): boolean =>
  ch === undefined || ch === ' ' || ch === '\t' || ch === '\n';
const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

type Inline =
  | { readonly t: 'text'; readonly text: string }
  | { readonly t: 'code'; readonly text: string }
  | { readonly t: 'em' | 'strong' | 'del'; readonly children: readonly Inline[] }
  | { readonly t: 'link'; readonly url: string; readonly children: readonly Inline[] }
  | { readonly t: 'image'; readonly url: string; readonly alt: string }
  | { readonly t: 'br' };

interface Memo {
  readonly codeFail: Set<number>;
  readonly delimFail: Set<string>;
  /** The last search for each closing character: where it started and what it found. */
  readonly seen: Map<string, { readonly from: number; readonly at: number }>;
}

/**
 * The first `ch` at or after `from`. A search from inside an earlier search's range reuses its
 * answer (the first one at or after the earlier start is also the first after any later start up
 * to it), so repeated openers with one far closer stay linear.
 */
function seek(m: Memo, text: string, ch: string, from: number): number {
  const last = m.seen.get(ch);
  if (last !== undefined && from >= last.from && (last.at === -1 || from <= last.at)) {
    return last.at;
  }
  const at = text.indexOf(ch, from);
  m.seen.set(ch, { from, at });
  return at;
}

const TRAILING_CHARS: ReadonlySet<string> = new Set(['.', ',', ';', ':', '!', '?', ')', ']']);

/** The end of the run of `ch` starting at `i`. */
function runEnd(text: string, i: number, ch: string): number {
  let j = i;
  while (j < text.length && text[j] === ch) j += 1;
  return j;
}

/** The position of a closing run of exactly `n` backticks after `from`, or -1. */
function closingTicks(text: string, from: number, n: number): number {
  let j = text.indexOf('`', from);
  while (j !== -1) {
    const end = runEnd(text, j, '`');
    if (end - j === n) return j;
    j = text.indexOf('`', end);
  }
  return -1;
}

/** A closing delimiter after `from` that follows a non-space character, or -1. */
function closingDelim(text: string, from: number, delim: string): number {
  let j = text.indexOf(delim, from);
  while (j !== -1) {
    const prev = text[j - 1];
    const next = text[j + delim.length];
    const ok =
      j > from &&
      !isSpace(prev) &&
      // `_` does not close inside a word; a longer run is not this delimiter's end.
      !(delim[0] === '_' && isWordChar(next)) &&
      next !== delim[0];
    if (ok) return j;
    j = text.indexOf(delim, j + 1);
  }
  return -1;
}

function linkTarget(raw: string): string {
  let t = raw.trim();
  if (t.startsWith('<')) {
    const close = t.indexOf('>');
    t = close === -1 ? t.slice(1) : t.slice(1, close);
  } else {
    const space = t.search(/\s/);
    if (space !== -1) t = t.slice(0, space);
  }
  return t.slice(0, MAX_URL_CHARS);
}

/** Characters that end a bare web address (quotes and angle brackets around it stay text). */
const URL_STOP: ReadonlySet<string> = new Set(['<', '>', '"', "'", '`']);

function parseInline(
  text: string,
  depth: number,
  inLink: boolean,
  meter: Budget,
  memo?: Memo,
): Inline[] {
  const m: Memo = memo ?? { codeFail: new Set(), delimFail: new Set(), seen: new Map() };
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf.length > 0) out.push({ t: 'text', text: buf });
    buf = '';
  };

  const nested = (inner: string): Inline[] =>
    depth >= MAX_INLINE_DEPTH
      ? [{ t: 'text', text: inner }]
      : parseInline(inner, depth + 1, inLink, meter);

  let i = 0;
  while (i < text.length) {
    if (meter.left <= 0) {
      buf += text.slice(i);
      break;
    }
    const ch = text[i] as string;

    if (ch === '\\' && i + 1 < text.length && PUNCT.test(text[i + 1] as string)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '\n') {
      buf += ' ';
      i += 1;
      continue;
    }

    if (ch === '`') {
      const end = runEnd(text, i, '`');
      const n = end - i;
      if (!m.codeFail.has(n)) {
        const close = closingTicks(text, end, n);
        if (close !== -1) {
          flush();
          let code = text.slice(end, close).replace(/\n/g, ' ');
          if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) {
            code = code.slice(1, -1);
          }
          out.push({ t: 'code', text: code });
          meter.left -= 1;
          i = close + n;
          continue;
        }
        m.codeFail.add(n);
      }
      buf += text.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const end = runEnd(text, i, ch);
      const n = end - i;
      const delim = ch === '~' ? (n === 2 ? '~~' : '') : n === 1 ? ch : n === 2 ? ch + ch : '';
      const opens =
        delim !== '' &&
        !isSpace(text[end]) &&
        !(ch === '_' && isWordChar(text[i - 1])) &&
        !m.delimFail.has(delim);
      if (opens) {
        const close = closingDelim(text, end, delim);
        if (close !== -1) {
          flush();
          const t = ch === '~' ? 'del' : n === 2 ? 'strong' : 'em';
          meter.left -= 1;
          out.push({ t, children: nested(text.slice(end, close)) });
          i = close + delim.length;
          continue;
        }
        m.delimFail.add(delim);
      }
      buf += text.slice(i, end);
      i = end;
      continue;
    }

    const image = ch === '!' && text[i + 1] === '[';
    if (ch === '[' || image) {
      const open = image ? i + 1 : i;
      const close = seek(m, text, ']', open + 1);
      if (close !== -1 && close - open <= MAX_LABEL_CHARS && text[close + 1] === '(') {
        const paren = seek(m, text, ')', close + 2);
        if (paren !== -1 && paren - close <= MAX_URL_CHARS + 2) {
          const label = text.slice(open + 1, close);
          const url = linkTarget(text.slice(close + 2, paren));
          flush();
          meter.left -= image ? 5 : 6;
          if (image) out.push({ t: 'image', url, alt: label.slice(0, 200) });
          else if (inLink) out.push({ t: 'text', text: label });
          else
            out.push({
              t: 'link',
              url,
              children:
                depth >= MAX_INLINE_DEPTH
                  ? [{ t: 'text', text: label }]
                  : parseInline(label, depth + 1, true, meter),
            });
          i = paren + 1;
          continue;
        }
      }
    }

    if (ch === '<' && /^<(https?:\/\/|mailto:)/i.test(text.slice(i, i + 10))) {
      const close = seek(m, text, '>', i + 1);
      if (close !== -1 && close - i <= MAX_URL_CHARS + 1) {
        const url = text.slice(i + 1, close);
        if (!/\s/.test(url) && !inLink) {
          flush();
          meter.left -= 6;
          out.push({ t: 'link', url: url.slice(0, MAX_URL_CHARS), children: [] });
          i = close + 1;
          continue;
        }
      }
    }

    if (
      (ch === 'h' || ch === 'H') &&
      !inLink &&
      !isWordChar(text[i - 1]) &&
      /^https?:\/\//i.test(text.slice(i, i + 8))
    ) {
      // At most MAX_URL_CHARS: anything after it is ordinary text.
      const stop = Math.min(text.length, i + MAX_URL_CHARS);
      let end = i;
      while (end < stop && !isSpace(text[end]) && !URL_STOP.has(text[end] as string)) end += 1;
      // Trailing punctuation stays text: a backwards walk, linear in the address.
      while (end > i && TRAILING_CHARS.has(text[end - 1] as string)) end -= 1;
      if (end - i > 8) {
        flush();
        meter.left -= 6;
        out.push({ t: 'link', url: text.slice(i, end), children: [] });
        i = end;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rendering

type LinkKind =
  | { readonly kind: 'web'; readonly url: string; readonly domain: string }
  | {
      readonly kind: 'other';
    };

function classify(url: string): LinkKind {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const domain = cleanText(parsed.hostname, 253);
      if (domain.length > 0)
        return { kind: 'web', url: cleanText(parsed.href, MAX_URL_CHARS), domain };
    }
  } catch {
    // Not an absolute address: nothing to copy.
  }
  return { kind: 'other' };
}

function useCopy(): [state: 'idle' | 'copied' | 'failed', copy: (text: string) => void] {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => setState('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = (text: string): void => {
    try {
      const clip = (globalThis.navigator as Navigator | undefined)?.clipboard;
      if (clip === undefined) {
        setState('failed');
        return;
      }
      void clip.writeText(text).then(
        () => setState('copied'),
        () => setState('failed'),
      );
    } catch {
      setState('failed');
    }
  };
  return [state, copy];
}

function LinkChip({
  url,
  labels,
}: {
  readonly url: string;
  readonly labels: MarkdownLabels;
}): ReactElement {
  const target = classify(url);
  const [state, copy] = useCopy();
  if (target.kind !== 'web') {
    return (
      <span className="al-inert-link al-md-chip" data-link="removed">
        <Icon name="eye-off" size={12} />
        {labels.linkRemoved}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="al-inert-link al-md-chip"
      data-link="web"
      title={`${labels.linkNotOpened}: ${target.url}`}
      aria-label={`${labels.copyLink}: ${target.url}`}
      onClick={() => copy(target.url)}
    >
      <Icon name={state === 'copied' ? 'check' : 'eye-off'} size={12} />
      {state === 'copied' ? labels.copied : target.domain}
    </button>
  );
}

function ImageChip({
  url,
  alt,
  labels,
}: {
  readonly url: string;
  readonly alt: string;
  readonly labels: MarkdownLabels;
}): ReactElement {
  const target = classify(url);
  const where = target.kind === 'web' ? target.domain : '';
  const name = [labels.imageNotLoaded, alt.trim(), where].filter((p) => p.length > 0).join(' · ');
  return (
    <span className="al-inert-link al-md-chip al-md-image" role="img" aria-label={name}>
      <Icon name="eye-off" size={12} />
      {name}
    </span>
  );
}

function renderInline(nodes: readonly Inline[], labels: MarkdownLabels): ReactNode[] {
  return nodes.map((n, k) => {
    switch (n.t) {
      case 'text':
        return n.text;
      case 'br':
        return <br key={k} />;
      case 'code':
        return (
          <code key={k} className="al-md-icode">
            {n.text}
          </code>
        );
      case 'em':
        return <em key={k}>{renderInline(n.children, labels)}</em>;
      case 'strong':
        return <strong key={k}>{renderInline(n.children, labels)}</strong>;
      case 'del':
        return <del key={k}>{renderInline(n.children, labels)}</del>;
      case 'image':
        return <ImageChip key={k} url={n.url} alt={n.alt} labels={labels} />;
      case 'link':
        return (
          <span key={k} className="al-md-link">
            {n.children.length === 0 ? null : (
              <span className="al-md-link-text">{renderInline(n.children, labels)}</span>
            )}
            <LinkChip url={n.url} labels={labels} />
          </span>
        );
      default:
        return null;
    }
  });
}

function CopyButton({
  text,
  labels,
  className,
}: {
  readonly text: string;
  readonly labels: MarkdownLabels;
  readonly className?: string;
}): ReactElement {
  const [state, copy] = useCopy();
  return (
    <button
      type="button"
      className={cx('al-btn', 'al-btn-ghost', 'al-btn-sm', className)}
      onClick={() => copy(text)}
    >
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={13} />
      <span>{state === 'copied' ? labels.copied : labels.copy}</span>
    </button>
  );
}

const HEADINGS = ['h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const;

function renderBlocks(blocks: readonly Block[], labels: MarkdownLabels): ReactNode[] {
  return blocks.map((b, k) => renderBlock(b, k, labels));
}

const alignClass = (a: Align): string | undefined => (a === undefined ? undefined : `al-md-${a}`);

function renderBlock(b: Block, k: number, labels: MarkdownLabels): ReactNode {
  switch (b.t) {
    case 'p':
      return <p key={k}>{renderInline(b.nodes, labels)}</p>;
    case 'h': {
      const Tag = HEADINGS[Math.min(Math.max(b.level, 1), 6) - 1] ?? 'h6';
      return (
        <Tag key={k} className={`al-md-h al-md-h${String(b.level)}`}>
          {renderInline(b.nodes, labels)}
        </Tag>
      );
    }
    case 'hr':
      return <hr key={k} />;
    case 'code':
      return (
        <div key={k} className="al-md-code">
          <div className="al-md-code-head">
            <span className="al-text-label">{b.lang === '' ? labels.code : b.lang}</span>
            <CopyButton text={b.text} labels={labels} />
          </div>
          <pre tabIndex={0}>
            <code>{b.text}</code>
          </pre>
        </div>
      );
    case 'quote':
      return <blockquote key={k}>{renderBlocks(b.children, labels)}</blockquote>;
    case 'list': {
      const items = b.items.map((item, j) => {
        const lead = item[0];
        const task = b.tasks?.[j];
        return (
          <li key={j} {...(task === undefined ? {} : { className: 'al-md-task' })}>
            {task === undefined ? null : (
              // Read only, and no form element (the inert output has none): a box the reader shows,
              // never changes.
              <span
                className="al-md-box"
                role="checkbox"
                aria-checked={task}
                aria-disabled="true"
                aria-readonly="true"
                data-checked={task ? 'true' : 'false'}
              >
                {task ? '\u2611' : '\u2610'}
              </span>
            )}
            {item.length === 1 && lead?.t === 'p'
              ? renderInline(lead.nodes, labels)
              : lead?.t === 'p'
                ? [
                    <span key="first">{renderInline(lead.nodes, labels)}</span>,
                    ...renderBlocks(item.slice(1), labels),
                  ]
                : renderBlocks(item, labels)}
          </li>
        );
      });
      const cls = b.cont === true ? 'al-md-cont' : undefined;
      return b.ordered ? (
        <ol key={k} className={cls} {...(b.start === 1 ? {} : { start: b.start })}>
          {items}
        </ol>
      ) : (
        <ul key={k} className={cls}>
          {items}
        </ul>
      );
    }
    case 'table':
      return (
        <div key={k} className={cx('al-md-table', b.cont === true && 'al-md-cont')} tabIndex={0}>
          <table>
            {b.cont === true ? null : (
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} className={alignClass(b.align[j])}>
                      {renderInline(c, labels)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, x) => (
                    <td key={x} className={alignClass(b.align[x])}>
                      {renderInline(c, labels)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rest':
      return (
        <p key={k} className="al-md-rest">
          <span className="al-md-note">{labels.rest}</span>
          {b.text}
        </p>
      );
    default:
      return null;
  }
}

/** One top-level piece; drawn once (a later slice does not draw it again). */
const PieceView = memo(function PieceView({
  block,
  labels,
}: {
  readonly block: Block;
  readonly labels: MarkdownLabels;
}): ReactNode {
  return renderBlock(block, 0, labels);
});

/** The text as the renderers show it (hidden and direction characters removed): Copy uses it. */
export function shownText(text: string): string {
  return cleanDocument(text);
}

export interface SafeMarkdownProps {
  /** The file's text. Untrusted (I-5). */
  readonly text: string;
  readonly labels?: Partial<MarkdownLabels>;
  readonly className?: string;
}

/** Runs `next` in a later task: when the browser is idle, or after a short timeout. */
function later(next: () => void): () => void {
  const w = globalThis as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function' && typeof w.cancelIdleCallback === 'function') {
    const id = w.requestIdleCallback(next, { timeout: 50 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = setTimeout(next, 0);
  return () => clearTimeout(id);
}

/**
 * Received Markdown, rendered from a safe subset (see the file header): the first slice at once,
 * the rest in later tasks, stopped when the component goes away (the reader closed).
 */
export function SafeMarkdown({ text, labels, className }: SafeMarkdownProps): ReactElement {
  const l = useMemo<MarkdownLabels>(() => ({ ...MARKDOWN_LABELS, ...labels }), [labels]);
  const pieces = useMemo(() => parseDocument(text), [text]);
  const [drawn, setDrawn] = useState(() => ({ pieces, count: sliceEnd(pieces, 0) }));
  // A new text starts again from its first slice.
  const state = drawn.pieces === pieces ? drawn : { pieces, count: sliceEnd(pieces, 0) };
  if (state !== drawn) setDrawn(state);
  const busy = state.count < pieces.length;
  useEffect(() => {
    if (!busy) return undefined;
    return later(() =>
      setDrawn((d) => (d.pieces === pieces ? { pieces, count: sliceEnd(pieces, d.count) } : d)),
    );
  }, [busy, pieces, state.count]);
  return (
    <div className={cx('al-md', className)} aria-busy={busy}>
      {pieces.slice(0, state.count).map((piece, k) => (
        <PieceView key={k} block={piece.block} labels={l} />
      ))}
    </div>
  );
}

export type CodeKind = 'code' | 'json' | 'patch' | 'text';

function diffOf(line: string): string | undefined {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return undefined;
}

export interface SafeCodeProps {
  readonly text: string;
  readonly kind: CodeKind;
  readonly className?: string;
  /** The accessible name of the scrollable block. */
  readonly label?: string;
  /** The note before the lines past CODE_MAX_LINES. */
  readonly restLabel?: string;
}

/**
 * Received code, JSON, a patch or plain text, with line numbers. The numbers are one text column
 * beside the code (not one element per line), so any length draws a handful of elements; a patch
 * colours its first CODE_MAX_LINES lines, one element each, and shows the rest as plain text.
 */
export function SafeCode({
  text,
  kind,
  className,
  label,
  restLabel = MARKDOWN_LABELS.rest,
}: SafeCodeProps): ReactElement {
  const all = cleanDocument(text).split('\n');
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  const numbers = all.map((_, n) => String(n + 1)).join('\n');
  let body: ReactNode;
  if (kind === 'patch') {
    const lines = all.slice(0, CODE_MAX_LINES);
    const rest = all.length > CODE_MAX_LINES ? all.slice(CODE_MAX_LINES).join('\n') : undefined;
    body = (
      <>
        {lines.map((line, n) => {
          const diff = diffOf(line);
          return (
            <Fragment key={n}>
              <span
                className="al-code-line"
                data-line={String(n + 1)}
                {...(diff === undefined ? {} : { 'data-diff': diff })}
              >
                {line}
              </span>
              {n < lines.length - 1 || rest !== undefined ? '\n' : null}
            </Fragment>
          );
        })}
        {rest === undefined ? null : (
          <span className="al-code-rest">
            <span className="al-md-note">{restLabel}</span>
            {rest}
          </span>
        )}
      </>
    );
  } else {
    body = all.join('\n');
  }
  return (
    <div
      className={cx('al-code-view', className)}
      data-kind={kind}
      tabIndex={0}
      {...(label === undefined ? {} : { role: 'group', 'aria-label': label })}
    >
      <pre className="al-code-gutter" aria-hidden="true" data-lines={String(all.length)}>
        {numbers}
      </pre>
      <pre className="al-code-text">
        <code>{body}</code>
      </pre>
    </div>
  );
}
