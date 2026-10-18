// M1-15: the file-name sanitiser for downloads (04 §4 "Downloads", §7 "Malicious files / symlink
// tricks"). A file name travels inside the envelope from another party, so it is untrusted (I-5):
// it may hold path separators (`../../.ssh/authorized_keys`), control characters, bidi overrides
// that disguise the extension (`invoice\u202Efdp.exe`), a hidden-file dot, an NTFS stream colon or a
// Windows device name (`CON`, `nul.txt`). The result is a single, visible path segment that is safe
// to create inside the inbox folder on macOS, Linux and Windows. The inbox write itself (realpath,
// no overwrite, no symlink follow) is `@4thtech-io/node`'s `createInboxFile`.
//
// Pure code, no I/O, no Node built-in.

/** Used when nothing usable is left of the name. */
export const FALLBACK_FILE_NAME = 'file';
/** Longest sanitised name, in UTF-8 bytes (the common file-system limit is 255). */
export const MAX_FILE_NAME_BYTES = 255;

// C0 and C1 controls, DEL; Unicode format and bidi controls (ALM, LRM, RLM, LRE..RLO, LRI..PDI,
// zero-width characters, word joiner and invisible operators, BOM, interlinear annotations,
// soft hyphen, Mongolian vowel separator and variation selectors); line and paragraph separators
// (U+2028, U+2029); variation selectors (U+FE00-U+FE0F, U+E0100-U+E01EF); tag characters
// (U+E0000-U+E007F); lone surrogates; noncharacters U+FFFE and U+FFFF.
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\ufff9-\ufffb\ufffe\uffff\u2028\u2029\u{e0000}-\u{e007f}]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu;
/**
 * Variation selectors (U+180B-U+180D, U+FE00-U+FE0F, U+E0100-U+E01EF) attach to the previous
 * character, so a regex character class cannot list them (no-misleading-character-class).
 */
function isVariationSelector(cp: number): boolean {
  return (
    (cp >= 0x180b && cp <= 0x180d) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/** Characters Windows refuses in names, plus look-alike slashes that read as a path. */
const UNSAFE = /[<>:"|?*\u2044\u2215\u29f8\uff0f\uff3c]/g;
/**
 * Windows reserved device names, with or without an extension and with spaces before it (`CON`,
 * `com1.txt`, `LPT¹`, `CON .txt`): Windows ignores those spaces and opens the device.
 */
const RESERVED =
  /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|(?:com|lpt)[0-9\u00b9\u00b2\u00b3])\s*(?:\.|$)/i;

function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Cuts `text` to at most `bytes` UTF-8 bytes on a code-point boundary. */
function truncateUtf8(text: string, bytes: number): string {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const size = utf8Length(ch);
    if (used + size > bytes) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * Turns an untrusted file name into a single safe path segment:
 * - only the last segment after `/` or `\` is kept (directories are stripped);
 * - Unicode is NFC-normalised; control, format and bidi characters are removed;
 * - characters Windows refuses (`<>:"|?*`) and look-alike slashes become `_`;
 * - leading dots and spaces are removed (no hidden files, no `..`), trailing dots and spaces too
 *   (Windows drops them silently, which would change the name);
 * - a Windows device name (`CON`, `nul.txt`, `nul .txt`, `COM1`, `LPT¹`) gets a `_` prefix;
 * - the result is at most 255 UTF-8 bytes, keeping a short extension;
 * - an empty result becomes `file`.
 * Non-strings become `file`.
 */
export function sanitizeFileName(raw: unknown): string {
  if (typeof raw !== 'string') return FALLBACK_FILE_NAME;
  // Remove invisible characters before splitting, so `..\u200b/` cannot hide a separator.
  let name = [...raw.normalize('NFC').replace(INVISIBLE, '')]
    .filter((ch) => !isVariationSelector(ch.codePointAt(0) as number))
    .join('');
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash !== -1) name = name.slice(slash + 1);
  name = name.replace(UNSAFE, '_');
  name = name.replace(/^[.\s]+/u, '').replace(/[.\s]+$/u, '');
  if (RESERVED.test(name)) name = `_${name}`;
  if (utf8Length(name) > MAX_FILE_NAME_BYTES) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    const stem = extension === '' ? name : name.slice(0, dot);
    name = truncateUtf8(stem, MAX_FILE_NAME_BYTES - utf8Length(extension)) + extension;
    name = name.replace(/[.\s]+$/u, '');
  }
  return name === '' ? FALLBACK_FILE_NAME : name;
}

/**
 * `name` with ` (n)` before its extension, within MAX_FILE_NAME_BYTES (the stem is cut on a
 * code-point boundary), for a save that must not overwrite (M1-7f). `n` 0 returns `name`.
 */
export function withNameSuffix(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && name.length - dot <= 16;
  const stem = hasExt ? name.slice(0, dot) : name;
  const tail = ` (${String(n)})${hasExt ? name.slice(dot) : ''}`;
  const room = MAX_FILE_NAME_BYTES - utf8Length(tail);
  return `${truncateUtf8(stem, room).replace(/\s+$/u, '')}${tail}`;
}
