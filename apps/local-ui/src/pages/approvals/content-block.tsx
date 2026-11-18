// SEC-CARD-FULLTEXT (08 §1 "What the card shows"; 11 §5, §6.2.1; I-5): the exact content an approval
// is about, decoded by the app (never the AI's description of it).
//
// - The full text as plain React text in a `pre` with dir="auto" (each line takes its own
//   direction); the server already replaced bidi and control characters with visible markers, and
//   the client checked it again (client.ts), so nothing here is markup or can reorder the card.
// - No silent truncation: a text longer than CONTENT_PREVIEW_POINTS code points or
//   CONTENT_PREVIEW_LINES lines is shown collapsed with its length ("1,240 characters · show all to
//   approve"); the owner shows it once before Approve is enabled (the card asks `needsExpand`).
// - Each file: name, size, type. Check codes (>= 80 bits) are labelled "Check code"; the other side
//   can compare them.
import type { ReactElement } from 'react';
import { inertText, type ApprovalContent } from '@4thtech-io/types/ui-contract/approval-content';
import { APPROVAL_STRINGS as S, fmt } from './strings.js';

/** A text up to this many code points and lines is shown whole at once. */
export const CONTENT_PREVIEW_POINTS = 600;
export const CONTENT_PREVIEW_LINES = 12;

const count = (n: number): string => n.toLocaleString('en-US');

/** Whether the content is longer than the visible block, so Approve waits for "Show all". */
export function needsExpand(content: ApprovalContent | undefined): boolean {
  if (content === undefined) return false;
  const points = Array.from(content.text);
  return (
    points.length > CONTENT_PREVIEW_POINTS ||
    content.text.split('\n').length > CONTENT_PREVIEW_LINES
  );
}

/** The collapsed preview: the first lines and code points, marked as cut. */
function preview(text: string): string {
  const lines = text.split('\n').slice(0, CONTENT_PREVIEW_LINES).join('\n');
  const points = Array.from(lines);
  const head =
    points.length > CONTENT_PREVIEW_POINTS
      ? points.slice(0, CONTENT_PREVIEW_POINTS).join('')
      : lines;
  return `${head}…`;
}

export function ContentBlock({
  content,
  expanded,
  onExpand,
}: {
  content: ApprovalContent;
  expanded: boolean;
  onExpand: () => void;
}): ReactElement {
  const long = needsExpand(content);
  const open = !long || expanded;
  // Inert once more where it is drawn (idempotent): whatever path the item took, no bidi or
  // control character reaches the DOM (I-5).
  const text = inertText(content.text);
  return (
    <section className="al-content" aria-label={content.label}>
      <p className="al-content-label">{content.label}</p>
      <pre className="al-content-text" dir="auto" data-content-text="">
        {open ? text : preview(text)}
      </pre>
      <p className="al-content-length al-muted">
        {long && !expanded
          ? fmt(S.showAllToApprove, { count: count(content.length) })
          : fmt(S.contentLength, { count: count(content.length) })}
      </p>
      {long && !expanded ? (
        <button type="button" className="al-btn al-btn-ghost al-btn-sm" onClick={onExpand}>
          {S.showAll}
        </button>
      ) : null}
      {content.files.length > 0 ? (
        <ul className="al-content-files">
          {content.files.map((f, i) => (
            <li key={i}>
              <span className="al-content-file" dir="auto">
                {inertText(f.name).replace(/[\n\t]/g, ' ')}
              </span>
              <span className="al-muted">{` · ${f.size} · ${f.type}`}</span>
              <span className="al-check">
                <span className="al-check-label">{S.checkCode}</span>{' '}
                <code className="al-mono">{f.checkCode}</code>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {content.checkCode === undefined ? null : (
        <p className="al-check">
          <span className="al-check-label">{S.checkCode}</span>{' '}
          <code className="al-mono">{content.checkCode}</code>
        </p>
      )}
      <p className="al-field-hint">{S.checkCodeHint}</p>
    </section>
  );
}

/** The card's notice when the content could not be shown: it is never approved (fail closed). */
export function ContentMissing(): ReactElement {
  return (
    <p className="al-content-missing" role="alert">
      {S.contentMissing}
    </p>
  );
}
