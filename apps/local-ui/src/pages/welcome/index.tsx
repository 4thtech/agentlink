// Welcome (U3-g; b11 §28.1): the first thing a new person sees. One sentence, one button, a quiet link
// to the public docs. No account, no email, no choices. Shown only while no owner exists (the first-run
// page decides); it asks the server for nothing.
import { Button, Mark } from '@4thtech-io/ui';
import { useEffect, useRef, type ReactElement, type RefObject } from 'react';
import { WELCOME as T } from '../first-run/strings.js';
import './welcome.css';

/** Focus moves to the screen's title when the screen opens (b11 §28.4 accessibility). */
export function useTitleFocus<T extends HTMLElement>(screen = ''): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [screen]);
  return ref;
}

export function WelcomeScreen({
  onStart,
  restoreHref = '/restore/kit',
}: {
  readonly onStart: () => void;
  /** D-147: the quiet link for a person who has a recovery kit. */
  readonly restoreHref?: string;
}): ReactElement {
  const title = useTitleFocus<HTMLHeadingElement>();
  return (
    <section className="wl-wrap" aria-labelledby="wl-h">
      <Mark size={48} title="" />
      <h1 id="wl-h" ref={title} tabIndex={-1} className="al-text-title-1">
        {T.title}
      </h1>
      <div className="wl-actions">
        <Button variant="primary" size="lg" onClick={onStart}>
          {T.start}
        </Button>
        {/* The public docs: a new tab, no referrer, nothing sent. */}
        <a
          className="wl-link al-text-body-sm"
          href={T.whatHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          {T.what}
        </a>
        <a className="wl-link al-text-body-sm" href={restoreHref} data-restore-link="">
          {T.restore}
        </a>
      </div>
    </section>
  );
}
