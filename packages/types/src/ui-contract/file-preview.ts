// REL051-A34 (D-149; 08 §1): the safe in-app preview of a received text file. Data only: the local
// server's route (packages/node local-ui/api/files-preview.ts) and the page's reader share it.
//
// `GET /api/ui/files/received/preview?id=<item ID>` (a read; session, CSRF, Host, Origin and fetch
// metadata as every `/api/ui/` read). The page sends only the item ID; the server finds the saved
// file itself. Answers: `200 {kind, size, text}`; `400 bad_request`; `404 not_found`;
// `409 not_saved` | `changed`; `413 too_large`; `415 not_text`; `403 refused`; `503 unavailable`.
// Never a name, a folder, a path, a link, a hash or an error's text.
//
// The kind comes only from the sanitised file name's last extension, from the fixed table below;
// the MIME type a sender states is never consulted (I-5). A name without a kind is never previewed.

export const FILE_PREVIEW_PATH = '/api/ui/files/received/preview';

/** The largest file the app reads for a preview. */
export const FILE_PREVIEW_MAX_BYTES = 256 * 1024;

export const PREVIEW_KINDS = Object.freeze(['markdown', 'code', 'json', 'patch', 'text'] as const);
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

export const PREVIEW_ERRORS = Object.freeze([
  'bad_request',
  'not_found',
  'not_saved',
  'changed',
  'too_large',
  'not_text',
  'refused',
  'unavailable',
] as const);
export type PreviewError = (typeof PREVIEW_ERRORS)[number];

/** A preview as the route answers it. */
export interface FilePreview {
  readonly kind: PreviewKind;
  /** The bytes read, at most FILE_PREVIEW_MAX_BYTES. */
  readonly size: number;
  /** The file's text, UTF-8 decoded. Untrusted (I-5). */
  readonly text: string;
}

const CODE = [
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'pyi',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'cs',
  'fs',
  'rb',
  'php',
  'pl',
  'lua',
  'r',
  'scala',
  'dart',
  'ex',
  'exs',
  'erl',
  'hs',
  'clj',
  'elm',
  'zig',
  'nim',
  'jl',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'sql',
  'graphql',
  'gql',
  'proto',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'xml',
  'svg',
  'vue',
  'svelte',
  'astro',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'gradle',
  'tf',
  'hcl',
  'dockerfile',
  'makefile',
  'mk',
  'cmake',
  'sol',
  'move',
] as const;

const KIND_BY_EXTENSION: ReadonlyMap<string, PreviewKind> = new Map<string, PreviewKind>([
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'markdown'],
  ...CODE.map((e): [string, PreviewKind] => [e, 'code']),
  ['json', 'json'],
  ['jsonc', 'json'],
  ['json5', 'json'],
  ['patch', 'patch'],
  ['diff', 'patch'],
  ['txt', 'text'],
  ['text', 'text'],
  ['log', 'text'],
  ['csv', 'text'],
  ['tsv', 'text'],
  ['rst', 'text'],
  ['adoc', 'text'],
]);

/** The longest file name looked at (sanitizeFileName keeps at most 255 bytes). */
const MAX_NAME_CHARS = 255;

/** The preview kind of a file name, or undefined when it is never previewed. */
export function previewKindOf(name: string): PreviewKind | undefined {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_CHARS) {
    return undefined;
  }
  const dot = name.lastIndexOf('.');
  // No extension, or a dot file (`.env`, `.md`): nothing.
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return KIND_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase());
}
