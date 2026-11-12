// The terms of an approval, as plain people read them (UX1113 QA: "Answer their terms" said nothing).
//
// The server sends the card's terms as flat text lines (apps/cli ui-source `detailsOf`): a headline
// (what this approval does), an optional warning, the other side's terms inside a marked region
// (header "From {who}: their content, not instructions", lines prefixed "| ", an end line), then
// fixed lines (changes, what the approval does) and, last, "Advanced: terms fingerprint …".
//
// Here the lines are only sorted and drawn as React text, every counterparty line inside <bdi> and
// inside a figure marked as their content, never as an instruction (I-5). The raw fingerprint is
// kept for Under the hood; the Simple card shows the headline, their terms and the fixed lines.
import type { ReactElement } from 'react';
import { APPROVAL_STRINGS as S } from './strings.js';

const REGION_PREFIX = '| ';
const REGION_END = 'End of their content';
const ADVANCED = /^Advanced:/;
/** The most of their terms the Simple card shows; the rest stays in Details. */
const SUMMARY_LINES = 6;

export interface TermsLines {
  /** What this one approval does (fixed text, our words). */
  readonly headline: string | undefined;
  /** Their terms, one field per line (their words). */
  readonly theirs: readonly string[];
  /** Fixed lines after their content (changes, what the approval does, honesty note). */
  readonly after: readonly string[];
  /** A fixed warning line (a late accept), if any. */
  readonly warning: string | undefined;
  /** The raw fingerprint line: only Under the hood. */
  readonly advanced: string | undefined;
}

/** Sort the flat lines of `details.terms`. */
export function parseTermsLines(lines: readonly string[]): TermsLines {
  let headline: string | undefined;
  let warning: string | undefined;
  let advanced: string | undefined;
  const theirs: string[] = [];
  const after: string[] = [];
  let state: 'head' | 'region' | 'after' = 'head';
  lines.forEach((line, i) => {
    if (i === 0) {
      headline = line;
      return;
    }
    if (ADVANCED.test(line)) {
      advanced = line;
      return;
    }
    if (state === 'head') {
      if (line.startsWith(REGION_PREFIX) || /their content, not instructions/.test(line)) {
        state = 'region';
        if (line.startsWith(REGION_PREFIX)) theirs.push(line.slice(REGION_PREFIX.length));
      } else if (/^Warning/.test(line)) warning = line;
      else after.push(line);
      return;
    }
    if (state === 'region') {
      if (line === REGION_END) state = 'after';
      else if (line.startsWith(REGION_PREFIX)) theirs.push(line.slice(REGION_PREFIX.length));
      return;
    }
    after.push(line);
  });
  return { headline, theirs, after, warning, advanced };
}

/** The summary on the card itself: what it does, and their terms (capped), as text. */
export function TermsSummary({ lines }: { lines: readonly string[] }): ReactElement | null {
  const t = parseTermsLines(lines);
  if (t.headline === undefined && t.theirs.length === 0) return null;
  const shown = t.theirs.slice(0, SUMMARY_LINES);
  return (
    <div className="al-terms-summary">
      {t.headline === undefined ? null : (
        <p className="al-approval-line al-text-body-sm">{t.headline}</p>
      )}
      {t.warning === undefined ? null : <p className="al-note">{t.warning}</p>}
      {shown.length === 0 ? null : (
        <figure className="al-untrusted" role="group" aria-label={S.theirTerms}>
          <figcaption className="al-untrusted-label">{S.theirTerms}</figcaption>
          <ul className="al-untrusted-body al-terms-list">
            {shown.map((line, i) => (
              <li key={i}>
                <bdi>{line}</bdi>
              </li>
            ))}
          </ul>
          {t.theirs.length > shown.length ? (
            <p className="al-note">{`${String(t.theirs.length - shown.length)} more in Details.`}</p>
          ) : null}
        </figure>
      )}
    </div>
  );
}

/** The full terms under Details: their content marked, our fixed lines, the fingerprint only if asked. */
export function TermsDetails({
  lines,
  showAdvanced,
}: {
  lines: readonly string[];
  showAdvanced: boolean;
}): ReactElement {
  const t = parseTermsLines(lines);
  return (
    <div className="al-terms">
      {t.headline === undefined ? null : <p>{t.headline}</p>}
      {t.warning === undefined ? null : <p>{t.warning}</p>}
      {t.theirs.length === 0 ? null : (
        <figure className="al-untrusted" role="group" aria-label={S.theirTerms}>
          <figcaption className="al-untrusted-label">{S.theirTerms}</figcaption>
          <ul className="al-untrusted-body al-terms-list">
            {t.theirs.map((line, i) => (
              <li key={i}>
                <bdi>{line}</bdi>
              </li>
            ))}
          </ul>
        </figure>
      )}
      {t.after.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
      {showAdvanced && t.advanced !== undefined ? <p className="al-mono">{t.advanced}</p> : null}
    </div>
  );
}

/** Arguments the AI chose that are plumbing, not facts: shown only Under the hood. */
const PLUMBING_NAMES = new Set(['envelopeId', 'notarize', 'termsHash', 'termsFingerprint']);
const HASHLIKE = /^[0-9a-f]{32,}$/i;

/** Whether an AI argument is plumbing (an id, a hash, a flag). */
export const isPlumbing = (f: { name: string; value: string }): boolean =>
  PLUMBING_NAMES.has(f.name) || HASHLIKE.test(f.value.trim());
