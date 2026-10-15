// A minimal TOML writer for Codex's `[mcp_servers.agentlink]` table (D-73 (7): shown as a diff and
// written after confirmation, never through `codex mcp add`; a tested in-repo writer instead of a new
// dependency). It does not parse TOML values. It scans the file's statements well enough to
//
// - refuse a file that is clearly not TOML (an unterminated string or bracket, a line that is neither
//   a table header nor `key = value`, a header that does not close): `malformed`, nothing written;
// - learn every table header and key path, so an existing `agentlink` entry is never duplicated or
//   changed (a duplicate table would make Codex refuse its whole config);
// - append the new table at the end of the file, so no existing line changes.
//
// A file that assigns `mcp_servers` as a whole value (an inline table) cannot be extended by a table
// without a duplicate definition: `unsupported_format`.
import { HarnessError } from './errors.js';

export type TomlEdit =
  | { readonly status: 'change'; readonly text: string }
  /** The table is already there, exactly as AgentLink would write it. Nothing to do. */
  | { readonly status: 'present' }
  /** An `agentlink` MCP entry exists in another form. It is the user's: left as it is. */
  | { readonly status: 'conflict' };

type Key = readonly string[];

interface Scan {
  /** The full key path of every table header (`table`) and every assigned key (`key`). */
  readonly paths: readonly { readonly path: Key; readonly kind: 'table' | 'key' }[];
}

const BARE = /[A-Za-z0-9_-]/;
const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t';

class Scanner {
  private pos = 0;
  readonly paths: { path: Key; kind: 'table' | 'key' }[] = [];
  private table: Key = [];

  constructor(private readonly src: string) {}

  private fail(): never {
    throw new HarnessError('malformed');
  }

  private peek(offset = 0): string {
    return this.src.charAt(this.pos + offset);
  }

  private done(): boolean {
    return this.pos >= this.src.length;
  }

  private skipInline(): void {
    while (!this.done() && (isSpace(this.peek()) || this.peek() === '\r')) this.pos += 1;
  }

  private skipComment(): void {
    if (this.peek() === '#') while (!this.done() && this.peek() !== '\n') this.pos += 1;
  }

  /** The rest of a statement line: optional comment, then a line end or the end of the file. */
  private endOfLine(): void {
    this.skipInline();
    this.skipComment();
    if (!this.done()) {
      if (this.peek() !== '\n') this.fail();
      this.pos += 1;
    }
  }

  private quoted(quote: '"' | "'"): string {
    this.pos += 1;
    let out = '';
    while (!this.done()) {
      const ch = this.peek();
      if (ch === '\n') this.fail();
      this.pos += 1;
      if (ch === quote) return out;
      if (quote === '"' && ch === '\\') {
        out += this.escape();
      } else {
        out += ch;
      }
    }
    return this.fail();
  }

  /** One escape of a basic string, decoded, so a key written with \\u006c escapes equals its plain form. */
  private escape(): string {
    const ch = this.peek();
    this.pos += 1;
    const simple: Record<string, string> = {
      b: '\b',
      t: '\t',
      n: '\n',
      f: '\f',
      r: '\r',
      e: '\u001b',
      '"': '"',
      '\\': '\\',
    };
    const plain = simple[ch];
    if (plain !== undefined) return plain;
    const width = ch === 'x' ? 2 : ch === 'u' ? 4 : ch === 'U' ? 8 : 0;
    const hex = this.src.slice(this.pos, this.pos + width);
    if (width === 0 || !new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) return this.fail();
    const point = Number.parseInt(hex, 16);
    // Surrogates and values above U+10FFFF are not scalar values.
    if ((point >= 0xd800 && point <= 0xdfff) || point > 0x10ffff) return this.fail();
    this.pos += width;
    return String.fromCodePoint(point);
  }

  private keyPart(): string {
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.quoted(ch);
    const start = this.pos;
    while (!this.done() && BARE.test(this.peek())) this.pos += 1;
    if (this.pos === start) this.fail();
    return this.src.slice(start, this.pos);
  }

  private dottedKey(): string[] {
    const parts: string[] = [this.keyPart()];
    for (;;) {
      this.skipInline();
      if (this.peek() !== '.') return parts;
      this.pos += 1;
      this.skipInline();
      parts.push(this.keyPart());
    }
  }

  /** A value runs to the end of its line, unless a string, array or inline table spans lines. */
  private value(): void {
    let depth = 0;
    let seen = false;
    while (!this.done()) {
      const ch = this.peek();
      if (ch === '\n') {
        if (depth === 0) break;
        this.pos += 1;
        continue;
      }
      if (ch === '#') {
        this.skipComment();
        continue;
      }
      if (ch === '"' || ch === "'") {
        seen = true;
        if (this.src.startsWith(ch.repeat(3), this.pos)) this.multiline(ch);
        else this.quoted(ch);
        continue;
      }
      if (ch === '[' || ch === '{') depth += 1;
      else if (ch === ']' || ch === '}') {
        depth -= 1;
        if (depth < 0) this.fail();
      }
      if (!isSpace(ch) && ch !== '\r') seen = true;
      this.pos += 1;
    }
    if (depth !== 0 || !seen) this.fail();
  }

  private multiline(quote: string): void {
    const fence = quote.repeat(3);
    this.pos += 3;
    while (!this.done()) {
      if (quote === '"' && this.peek() === '\\') {
        this.pos += 2;
        continue;
      }
      if (this.src.startsWith(fence, this.pos)) {
        this.pos += 3;
        // Up to two further quote marks belong to the string.
        while (this.peek() === quote) this.pos += 1;
        return;
      }
      this.pos += 1;
    }
    this.fail();
  }

  run(): Scan {
    while (!this.done()) {
      this.skipInline();
      const ch = this.peek();
      if (ch === '\n') {
        this.pos += 1;
      } else if (ch === '#') {
        this.skipComment();
      } else if (ch === '[') {
        this.header();
      } else if (this.done()) {
        break;
      } else {
        const key = this.dottedKey();
        this.skipInline();
        if (this.peek() !== '=') this.fail();
        this.pos += 1;
        this.value();
        this.paths.push({ path: [...this.table, ...key], kind: 'key' });
        this.endOfLine();
      }
    }
    return { paths: this.paths };
  }

  private header(): void {
    const array = this.peek(1) === '[';
    this.pos += array ? 2 : 1;
    this.skipInline();
    const key = this.dottedKey();
    this.skipInline();
    for (let i = 0; i < (array ? 2 : 1); i += 1) {
      if (this.peek() !== ']') this.fail();
      this.pos += 1;
    }
    this.table = key;
    this.paths.push({ path: key, kind: 'table' });
    this.endOfLine();
  }
}

/** Scans `text` as described above; throws `malformed` when it is not TOML-shaped. */
export function scanToml(text: string): Scan {
  return new Scanner(text.startsWith('﻿') ? text.slice(1) : text).run();
}

/** The table AgentLink adds, one line per key (the same layout `codex mcp add` writes). */
export function agentlinkTable(command: string, args: readonly string[]): string[] {
  const quote = (value: string): string => JSON.stringify(value);
  return [
    '[mcp_servers.agentlink]',
    `command = ${quote(command)}`,
    `args = [${args.map(quote).join(', ')}]`,
  ];
}

/**
 * The new text of Codex's config with `[mcp_servers.agentlink]` appended. `text` is undefined when
 * the file does not exist yet. The line ending of the file (LF or CRLF) is kept.
 */
export function addTomlMcpServer(text: string | undefined, table: readonly string[]): TomlEdit {
  const eol = text !== undefined && text.includes('\r\n') ? '\r\n' : '\n';
  const block = table.map((line) => `${line}${eol}`).join('');
  if (text === undefined || text === '') return { status: 'change', text: block };

  for (const { path, kind } of scanToml(text).paths) {
    if (path[0] !== 'mcp_servers') continue;
    // `mcp_servers = { … }` assigns the whole table; a second table definition would be a duplicate.
    if (path.length === 1 && kind === 'key') throw new HarnessError('unsupported_format');
    if (path[1] === 'agentlink') {
      const ours = table.join('\n');
      return text.replaceAll('\r\n', '\n').includes(ours)
        ? { status: 'present' }
        : { status: 'conflict' };
    }
  }
  const separator = text.endsWith('\n') ? eol : `${eol}${eol}`;
  return { status: 'change', text: `${text}${separator}${block}` };
}
