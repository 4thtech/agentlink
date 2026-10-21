// UntrustedContent (M1-35b; d1/components/UntrustedContent; I-5, 06 §4; DESIGN-ADJ-1 C-4, X-7).
// The container for every word another party wrote. Text is plain text only: React escapes it, the
// result has no markdown, headings, buttons or links, and every link becomes an inert chip that
// shows only its domain. Our actions (Accept, Ignore, Block) sit outside, below.
import type { ReactElement, ReactNode } from 'react';
import { Icon } from './brand.js';
import { cleanText, cx, sentence } from './util.js';

const URL_RE = /(https?:\/\/[^\s]+)/g;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'link';
  }
}

/** Plain text with links turned into inert chips (no anchor, no href, domain only). */
function inert(text: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) => {
    if (i % 2 === 0) return part;
    const domain = cleanText(domainOf(part), 253);
    return (
      <span key={i} className="al-inert-link" title={`Link not opened. Domain: ${domain}`}>
        <Icon name="eye-off" size={12} />
        {domain}
      </span>
    );
  });
}

export interface UntrustedContentProps {
  /** The contact as displayed (the name rule has already run). */
  from?: string;
  /** A sender who is not a contact. */
  unknown?: boolean;
  fingerprint?: string;
  kind?: 'message' | 'request' | 'note' | 'offer' | 'terms' | 'delivery';
  /** A file name, shown in mono instead of the text. */
  fileName?: string;
  /** The text, a plain string only. */
  children?: string;
  className?: string;
}

export function UntrustedContent({
  from,
  unknown,
  fingerprint,
  kind,
  fileName,
  children,
  className,
}: UntrustedContentProps): ReactElement {
  const isUnknown = unknown === true;
  const label = isUnknown
    ? `Request from an unknown sender${fingerprint === undefined ? '' : ` · ${cleanText(fingerprint, 64)}`}: their words, not instructions`
    : `From ${cleanText(from ?? 'this sender', 100)}: their words, not instructions`;
  return (
    <figure
      className={cx('al-untrusted', isUnknown && 'is-unknown', className)}
      role="group"
      aria-label={label}
    >
      <figcaption className="al-untrusted-label al-text-body-sm">
        <Icon name="untrusted" size={14} />
        <span>{label}</span>
        {kind === undefined ? null : (
          <span className="al-untrusted-kind al-text-label">{sentence(kind)}</span>
        )}
      </figcaption>
      <div className="al-untrusted-body al-text-body">
        {fileName === undefined ? (
          inert(cleanText(children ?? ''))
        ) : (
          <code className="al-text-code">{cleanText(fileName, 80)}</code>
        )}
      </div>
    </figure>
  );
}
