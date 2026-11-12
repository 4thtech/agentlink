// File types by extension (REL051-A12; 06 §2.2, §2.3; 04 §3.4, §4).
//
// - Sender: `mimeForName` labels a file from a fixed table, so a Markdown plan travels as
//   `text/markdown` instead of `application/octet-stream`. The payload's `mime` field is unchanged.
// - Receiver: `fileKindOf` derives the kind from the file name alone. The sender's `mime` is never
//   trusted for anything: a `.bin` labelled `text/markdown` is still `other`.
// - `textOfFile`: the bytes as text only when they are at most FILE_TEXT_MAX_BYTES, valid UTF-8 and
//   free of NUL bytes. The caller checks the hashes first.
// Pure: no I/O. Only ASCII extensions of at most 12 letters or digits are recognised, so look-alike
// letters, bidi or control characters never map to a text kind.

export const FILE_KINDS = ['markdown', 'text', 'code', 'json', 'patch', 'image', 'other'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** A received text file up to this many bytes is returned as text by `agentlink_fetch_file`. */
export const FILE_TEXT_MAX_BYTES = 65_536;

/** Labels for people and AIs (11 §5: plain words). */
export const FILE_KIND_LABELS: Readonly<Record<FileKind, string>> = Object.freeze({
  markdown: 'Markdown',
  text: 'Text',
  code: 'Code',
  json: 'JSON',
  patch: 'Patch',
  image: 'Image',
  other: 'File',
});

const OCTET_STREAM = 'application/octet-stream';

interface TypeEntry {
  readonly kind: FileKind;
  readonly mime: string;
}

const entry = (kind: FileKind, mime: string): TypeEntry => Object.freeze({ kind, mime });

const CODE_EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh',
  'fish', 'sql', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro', 'yaml',
  'yml', 'toml', 'ini', 'xml', 'graphql', 'gql', 'proto', 'sol', 'lua', 'r', 'dart', 'scala',
  'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'pl', 'zig', 'nim', 'tf', 'gradle', 'cmake',
] as const; // prettier-ignore

/** The fixed table: lower-case extension → kind and the MIME type a sender labels it with. */
const BY_EXTENSION: ReadonlyMap<string, TypeEntry> = new Map<string, TypeEntry>([
  ['md', entry('markdown', 'text/markdown')],
  ['markdown', entry('markdown', 'text/markdown')],
  ['mdx', entry('markdown', 'text/markdown')],
  ['txt', entry('text', 'text/plain')],
  ['text', entry('text', 'text/plain')],
  ['log', entry('text', 'text/plain')],
  ['csv', entry('text', 'text/csv')],
  ['tsv', entry('text', 'text/tab-separated-values')],
  ['rst', entry('text', 'text/plain')],
  ['adoc', entry('text', 'text/plain')],
  ['json', entry('json', 'application/json')],
  ['jsonl', entry('json', 'application/json')],
  ['ndjson', entry('json', 'application/json')],
  ['patch', entry('patch', 'text/x-diff')],
  ['diff', entry('patch', 'text/x-diff')],
  ['png', entry('image', 'image/png')],
  ['jpg', entry('image', 'image/jpeg')],
  ['jpeg', entry('image', 'image/jpeg')],
  ['webp', entry('image', 'image/webp')],
  ['gif', entry('image', 'image/gif')],
  ['pdf', entry('other', 'application/pdf')],
  ...CODE_EXTENSIONS.map((ext) => [ext, entry('code', 'text/plain')] as const),
]);

/** Whole names (lower case) of well-known extensionless text files. */
const BY_NAME: ReadonlyMap<string, TypeEntry> = new Map<string, TypeEntry>([
  ['makefile', entry('code', 'text/plain')],
  ['dockerfile', entry('code', 'text/plain')],
  ['readme', entry('text', 'text/plain')],
  ['license', entry('text', 'text/plain')],
]);

/** The receiver's `.download` (04 §4.1) is not part of the type. */
const DOWNLOAD_SUFFIX = '.download';
const EXTENSION = /^[a-z0-9]{1,12}$/;

function typeOf(name: unknown): TypeEntry | undefined {
  if (typeof name !== 'string') return undefined;
  // The last path segment only; a name never steers anything through a path.
  let base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  if (base.toLowerCase().endsWith(DOWNLOAD_SUFFIX) && base.length > DOWNLOAD_SUFFIX.length) {
    base = base.slice(0, -DOWNLOAD_SUFFIX.length);
  }
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return BY_NAME.get(base.toLowerCase());
  const ext = base.slice(dot + 1);
  // ASCII only, compared after an ASCII-only lower-casing (no Unicode case folding).
  const lower = ext.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (!EXTENSION.test(lower)) return undefined;
  return BY_EXTENSION.get(lower);
}

/** The MIME type a sender labels a file with (fixed table; `application/octet-stream` otherwise). */
export function mimeForName(name: string): string {
  return typeOf(name)?.mime ?? OCTET_STREAM;
}

/** The kind of a file, from its name only (never from the sender's MIME type). */
export function fileKindOf(name: string): FileKind {
  return typeOf(name)?.kind ?? 'other';
}

/** True for the kinds whose content is text: markdown, text, code, json and patch. */
export function isTextKind(kind: FileKind): boolean {
  return kind !== 'image' && kind !== 'other';
}

/** The runtime's TextDecoder (every supported runtime has one; this package has no DOM types). */
const Utf8Decoder = (
  globalThis as unknown as {
    readonly TextDecoder: new (
      label: string,
      options: { readonly fatal: boolean },
    ) => { decode(bytes: Uint8Array): string };
  }
).TextDecoder;

/**
 * The bytes as text when they are at most FILE_TEXT_MAX_BYTES, valid UTF-8 and contain no NUL;
 * otherwise undefined. A leading byte order mark is dropped.
 */
export function textOfFile(bytes: Uint8Array): string | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length > FILE_TEXT_MAX_BYTES) return undefined;
  if (bytes.includes(0)) return undefined;
  try {
    return new Utf8Decoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
