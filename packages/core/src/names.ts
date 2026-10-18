// The contact-name rule (06 §2.1, D-53; I-5). A name another party chose, or any name an agent wrote,
// is untrusted. Outside the untrusted block it is shown only as an owner-set alias or as the output of
// restrictName, always quoted and followed by its identity label (11 §5.2). No label is ever derived
// from a name.
//
// restrictName, exactly per 06 §2.1:
// - NFKC (folds fullwidth, mathematical and other compatibility forms), then every character outside
//   [\p{L}\p{N} .'-] removed (control, format, bidi and zero-width characters, newlines, `:` `<` `>`
//   `/` `(` `)` `[` `]` `"` and the rest), runs of spaces collapsed, trimmed, at most 32 code points.
// - The fallback "Contact" plus the short owner fingerprint replaces it when nothing is left, when it
//   mixes scripts or uses characters beyond the UTS #39 "moderately restrictive" profile, or when it
//   contains, case-insensitively, a word reserved for system labels.
//
// UTS #39 here, without a data dependency: the scripts are the Unicode Script property (regex
// property escapes, built into every runtime), restricted to the UTS #39 Recommended scripts, and
// combined per the "moderately restrictive" level. Letters of Latin, Greek and Cyrillic blocks whose
// identifier status is not Allowed (technical and phonetic letters such as the clicks U+01C0..U+01C3,
// IPA and the phonetic extensions) are refused by range. Residual: a whole-script confusable (a name
// written entirely in Cyrillic letters that look Latin) passes; it is a single script, which the
// profile allows, and it is still labelled self-declared.
import {
  RESERVED_NAME_WORDS,
  RESTRICTED_NAME_FALLBACK,
  RESTRICTED_NAME_MAX_CODE_POINTS,
  type ContactDisplayName,
  type RestrictedName,
} from '@agentlink/types';

/** UTS #39 Table 5, Recommended scripts. */
const RECOMMENDED_SCRIPTS = [
  'Arabic',
  'Armenian',
  'Bengali',
  'Bopomofo',
  'Cyrillic',
  'Devanagari',
  'Ethiopic',
  'Georgian',
  'Greek',
  'Gujarati',
  'Gurmukhi',
  'Han',
  'Hangul',
  'Hebrew',
  'Hiragana',
  'Kannada',
  'Katakana',
  'Khmer',
  'Lao',
  'Latin',
  'Malayalam',
  'Myanmar',
  'Oriya',
  'Sinhala',
  'Tamil',
  'Telugu',
  'Thaana',
  'Thai',
  'Tibetan',
] as const;
type Script = (typeof RECOMMENDED_SCRIPTS)[number];

const SCRIPT_TESTS: readonly (readonly [Script, RegExp])[] = RECOMMENDED_SCRIPTS.map(
  (s) => [s, new RegExp(`^\\p{Script=${s}}$`, 'u')] as const,
);
const COMMON = /^[\p{Script=Common}\p{Script=Inherited}]$/u;

/**
 * Letters whose UTS #39 identifier status is not Allowed (Technical, Obsolete, Uncommon use) in the
 * Latin and Cyrillic ranges an attacker reaches for: the click letters U+01C0..U+01C3 (look-alikes
 * of `|` and `!`), IPA Extensions and spacing modifier letters, the phonetic extensions, Latin
 * Extended-C, -D and -E, and Cyrillic Extended-A, -B and -C.
 */
const NOT_ALLOWED =
  /[\u01C0-\u01C3\u0250-\u02FF\u1D00-\u1DBF\u2C60-\u2C7F\uA720-\uA7FF\uAB30-\uAB6F\u1C80-\u1C8F\uA640-\uA69F\u2DE0-\u2DFF]/u;

const DISALLOWED_CHARS = /[^\p{L}\p{N} .'-]/gu;

const squeeze = (s: string): string => s.replace(/[ .'-]/g, '');
const RESERVED = RESERVED_NAME_WORDS.map((w) => w.toLowerCase());
const RESERVED_SQUEEZED = RESERVED.map(squeeze);

function scriptOf(ch: string): Script | 'common' | 'other' {
  if (COMMON.test(ch)) return 'common';
  for (const [script, test] of SCRIPT_TESTS) if (test.test(ch)) return script;
  return 'other';
}

/** The UTS #39 "moderately restrictive" level over the scripts used. */
function moderatelyRestrictive(scripts: ReadonlySet<Script>): boolean {
  if (scripts.size <= 1) return true;
  const within = (allowed: readonly Script[]): boolean =>
    [...scripts].every((s) => allowed.includes(s));
  if (within(['Latin', 'Han', 'Hiragana', 'Katakana'])) return true;
  if (within(['Latin', 'Han', 'Bopomofo'])) return true;
  if (within(['Latin', 'Han', 'Hangul'])) return true;
  if (scripts.size === 2 && scripts.has('Latin')) {
    return !scripts.has('Cyrillic') && !scripts.has('Greek');
  }
  return false;
}

/**
 * The restricted form of an untrusted name (06 §2.1). `ownerFingerprintShort` is the contact's short
 * owner fingerprint (04 §2.9), used by the fallback.
 */
export function restrictName(name: unknown, ownerFingerprintShort: string): RestrictedName {
  const fallback = `${RESTRICTED_NAME_FALLBACK} ${ownerFingerprintShort}` as RestrictedName;
  if (typeof name !== 'string') return fallback;
  let text: string;
  try {
    text = name.normalize('NFKC');
  } catch {
    return fallback;
  }
  text = text.replace(DISALLOWED_CHARS, '').replace(/ +/g, ' ').trim();
  text = [...text].slice(0, RESTRICTED_NAME_MAX_CODE_POINTS).join('').trim();
  if (text === '') return fallback;
  const scripts = new Set<Script>();
  for (const ch of text) {
    if (NOT_ALLOWED.test(ch)) return fallback;
    const script = scriptOf(ch);
    if (script === 'other') return fallback;
    if (script !== 'common') scripts.add(script);
  }
  if (!moderatelyRestrictive(scripts)) return fallback;
  const lower = text.toLowerCase();
  const squeezed = squeeze(lower);
  if (
    RESERVED.some((w) => lower.includes(w)) ||
    RESERVED_SQUEEZED.some((w) => squeezed.includes(w))
  ) {
    return fallback;
  }
  return text as RestrictedName;
}

/** A shown name: quoted, followed by its identity label, e.g. `“Marko Novak” (self-declared)`. */
/**
 * True when `alias` is already its own restricted form (M1-9za, 06 §2.1 rule 1): an owner alias that
 * `restrictName` would leave unchanged, so it has no label word, control, bidi, zero-width or
 * confusable character, no mixed scripts, no extra spaces and at most 32 code points. The fallback
 * fingerprint `·` can never appear in a restricted name, so the fallback never equals an alias.
 */
export function isRestrictedAlias(alias: unknown): alias is string {
  return typeof alias === 'string' && alias !== '' && restrictName(alias, '\u00b7') === alias;
}

export function renderContactName(display: ContactDisplayName): string {
  return `“${display.name}” (${display.label})`;
}
