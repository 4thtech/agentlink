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
// - Every inline search remembers a failed search, so a run of delimiters is linear, not quadratic.
// - Document headings start at h3 (the reader's own title is the dialog's h2).
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
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
}

export const MARKDOWN_LABELS: MarkdownLabels = Object.freeze({
  copy: 'Copy',
  copied: 'Copied',
  copyLink: 'Copy link',
  linkNotOpened: 'Link not opened',
  linkRemoved: 'Link removed',
  imageNotLoaded: 'Image not loaded',
  code: 'Code',
});

// ---------------------------------------------------------------------------------------------
// Blocks

type Align = 'left' | 'center' | 'right' | undefined;
type Block =
  | { readonly t: 'p'; readonly text: string }
  | { readonly t: 'h'; readonly level: number; readonly text: string }
  | { readonly t: 'code'; readonly lang: string; readonly text: string }
  | { readonly t: 'quote'; readonly children: readonly Block[] }
  | {
      readonly t: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly Block[])[];
    }
  | {
      readonly t: 'table';
      readonly head: readonly string[];
      readonly align: readonly Align[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly t: 'hr' };

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( *)([-*+]|[0-9]{1,9}[.)])([ \t]+|$)/;
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

function parseBlocks(lines: readonly string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i += 1;
      continue;
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
      out.push({ t: 'code', lang, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      out.push({ t: 'h', level, text: headingText(line, level, heading[0].length) });
      i += 1;
      continue;
    }

    if (isRule(line)) {
      out.push({ t: 'hr' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        inner.push((lines[i] as string).replace(QUOTE, ''));
        i += 1;
      }
      if (depth >= MARKDOWN_MAX_DEPTH) out.push({ t: 'p', text: inner.join('\n') });
      else out.push({ t: 'quote', children: parseBlocks(inner, depth + 1) });
      continue;
    }

    const list = LIST.exec(line);
    if (list !== null && indentOf(line) <= 3) {
      const ordered = /[0-9]/.test(list[2] ?? '');
      const kind = ordered ? (list[2] ?? '').slice(-1) : (list[2] ?? '');
      const start = ordered ? Math.min(Number.parseInt(list[2] ?? '1', 10), 1e9) : 1;
      const items: Block[][] = [];
      while (i < lines.length) {
        const first = LIST.exec(lines[i] as string);
        if (first === null || indentOf(lines[i] as string) > 3) break;
        const firstKind = /[0-9]/.test(first[2] ?? '') ? (first[2] ?? '').slice(-1) : first[2];
        if (firstKind !== kind) break;
        const spaces = (first[3] ?? '').length;
        const offset =
          (first[1]?.length ?? 0) +
          (first[2]?.length ?? 0) +
          (spaces > 4 || spaces === 0 ? 1 : spaces);
        const body: string[] = [(lines[i] as string).slice(first[0].length)];
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
        items.push(
          depth >= MARKDOWN_MAX_DEPTH
            ? [{ t: 'p', text: body.join('\n') }]
            : parseBlocks(body, depth + 1),
        );
        // A blank line between items ends the list unless another item follows.
        let j = i;
        while (j < lines.length && isBlank(lines[j] as string)) j += 1;
        if (j < lines.length && LIST.test(lines[j] as string)) i = j;
      }
      out.push({ t: 'list', ordered, start, items });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length) {
      const align = delimiterRow(lines[i + 1] as string);
      if (align !== undefined) {
        const head = cells(line);
        if (head.length === align.length) {
          const rows: string[][] = [];
          i += 2;
          while (i < lines.length) {
            const l = lines[i] as string;
            if (isBlank(l) || !l.includes('|') || startsBlock(l)) break;
            if (rows.length < MAX_TABLE_ROWS) rows.push(cells(l));
            i += 1;
          }
          out.push({ t: 'table', head, align, rows });
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
    const text = para.join('\n');
    out.push(setext === 0 ? { t: 'p', text } : { t: 'h', level: setext, text });
  }
  return out;
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
  bracketFail: boolean;
  parenFail: boolean;
  angleFail: boolean;
}

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

const TRAILING = /[.,;:!?)\]]+$/;
/** Characters that end a bare web address (quotes and angle brackets around it stay text). */
const URL_STOP: ReadonlySet<string> = new Set(['<', '>', '"', "'", '`']);

function parseInline(text: string, depth: number, inLink: boolean, memo?: Memo): Inline[] {
  const m: Memo = memo ?? {
    codeFail: new Set(),
    delimFail: new Set(),
    bracketFail: false,
    parenFail: false,
    angleFail: false,
  };
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf.length > 0) out.push({ t: 'text', text: buf });
    buf = '';
  };
  const nested = (inner: string): Inline[] =>
    depth >= MAX_INLINE_DEPTH
      ? [{ t: 'text', text: inner }]
      : parseInline(inner, depth + 1, inLink);

  let i = 0;
  while (i < text.length) {
    if (out.length >= MAX_INLINE_NODES) {
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
    if ((ch === '[' || image) && !m.bracketFail) {
      const open = image ? i + 1 : i;
      const close = text.indexOf(']', open + 1);
      if (close === -1) {
        m.bracketFail = true;
      } else if (text[close + 1] === '(' && !m.parenFail) {
        const paren = text.indexOf(')', close + 2);
        if (paren === -1) {
          m.parenFail = true;
        } else {
          const label = text.slice(open + 1, close);
          const url = linkTarget(text.slice(close + 2, paren));
          flush();
          if (image) out.push({ t: 'image', url, alt: label.slice(0, 200) });
          else if (inLink) out.push({ t: 'text', text: label });
          else
            out.push({
              t: 'link',
              url,
              children:
                depth >= MAX_INLINE_DEPTH
                  ? [{ t: 'text', text: label }]
                  : parseInline(label, depth + 1, true),
            });
          i = paren + 1;
          continue;
        }
      }
    }

    if (ch === '<' && !m.angleFail && /^<(https?:\/\/|mailto:)/i.test(text.slice(i, i + 10))) {
      const close = text.indexOf('>', i + 1);
      if (close === -1) {
        m.angleFail = true;
      } else {
        const url = text.slice(i + 1, close);
        if (!/\s/.test(url) && !inLink) {
          flush();
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
      let end = i;
      while (end < text.length && !isSpace(text[end]) && !URL_STOP.has(text[end] as string))
        end += 1;
      let url = text.slice(i, end);
      const trail = TRAILING.exec(url);
      if (trail !== null) url = url.slice(0, url.length - trail[0].length);
      if (url.length > 8) {
        flush();
        out.push({ t: 'link', url: url.slice(0, MAX_URL_CHARS), children: [] });
        i += url.length;
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

function inline(text: string, labels: MarkdownLabels): ReactNode[] {
  return renderInline(parseInline(text, 0, false), labels);
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
  return blocks.map((b, k) => {
    switch (b.t) {
      case 'p':
        return <p key={k}>{inline(b.text, labels)}</p>;
      case 'h': {
        const Tag = HEADINGS[Math.min(Math.max(b.level, 1), 6) - 1] ?? 'h6';
        return (
          <Tag key={k} className={`al-md-h al-md-h${String(b.level)}`}>
            {inline(b.text, labels)}
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
        const items = b.items.map((item, j) => (
          <li key={j}>
            {item.length === 1 && item[0]?.t === 'p'
              ? inline(item[0].text, labels)
              : item.length > 0 && item[0]?.t === 'p'
                ? [
                    <span key="first">{inline(item[0].text, labels)}</span>,
                    ...renderBlocks(item.slice(1), labels),
                  ]
                : renderBlocks(item, labels)}
          </li>
        ));
        return b.ordered ? (
          <ol key={k} {...(b.start === 1 ? {} : { start: b.start })}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case 'table': {
        const alignClass = (a: Align): string | undefined =>
          a === undefined ? undefined : `al-md-${a}`;
        return (
          <div key={k} className="al-md-table" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} className={alignClass(b.align[j])}>
                      {inline(c, labels)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {b.head.map((_, x) => (
                      <td key={x} className={alignClass(b.align[x])}>
                        {inline(r[x] ?? '', labels)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      default:
        return null;
    }
  });
}

export interface SafeMarkdownProps {
  /** The file's text. Untrusted (I-5). */
  readonly text: string;
  readonly labels?: Partial<MarkdownLabels>;
  readonly className?: string;
}

/** Received Markdown, rendered from a safe subset (see the file header). */
export function SafeMarkdown({ text, labels, className }: SafeMarkdownProps): ReactElement {
  const l: MarkdownLabels = { ...MARKDOWN_LABELS, ...labels };
  const clean = cleanText(text, MAX_CHARS, true);
  const blocks = parseBlocks(clean.split('\n'), 0);
  return <div className={cx('al-md', className)}>{renderBlocks(blocks, l)}</div>;
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
}

/** Received code, JSON, a patch or plain text: each line as text, with its number. */
export function SafeCode({ text, kind, className, label }: SafeCodeProps): ReactElement {
  const lines = cleanText(text, MAX_CHARS, true).split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const width = String(lines.length).length;
  return (
    <pre
      className={cx('al-code-view', className)}
      data-kind={kind}
      data-gutter={String(Math.min(Math.max(width, 2), 6))}
      tabIndex={0}
      {...(label === undefined ? {} : { 'aria-label': label })}
    >
      <code>
        {lines.map((line, n) => {
          const diff = kind === 'patch' ? diffOf(line) : undefined;
          return (
            <span key={n}>
              <span
                className="al-code-line"
                data-line={String(n + 1)}
                {...(diff === undefined ? {} : { 'data-diff': diff })}
              >
                {line}
              </span>
              {n < lines.length - 1 ? '\n' : null}
            </span>
          );
        })}
      </code>
    </pre>
  );
}
