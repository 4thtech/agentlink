// W4-SETTINGS-ADVANCED (I-5): a name or a state as plain, bounded text for the live stream and the
// diagnostics report. A name can carry control and bidi characters; they are removed, not escaped.
const MAX_TEXT = 200;
/** Control characters, and the bidi marks, embeddings, overrides and isolates (written as escapes). */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;

/** A name as plain, bounded text. */
export function cleanLine(text: string): string {
  return text.replace(UNSAFE, '').slice(0, MAX_TEXT);
}
