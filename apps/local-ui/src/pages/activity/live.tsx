// Live activity stream (W4-SETTINGS-ADVANCED; prototype v23 "Live activity stream"; Under the hood).
// A mono log, newest first, with Pause / Resume. It listens to one `StreamSource` (live-stream.ts:
// polling today, SSE after U1-b) and stops when the page goes away. While paused the view is frozen
// and lines keep being kept; Resume shows them. At most MAX_STREAM_LINES.
//
// I-5: every text is rendered as a React text node inside <bdi>, after control and bidi characters
// are removed (a name can carry them); nothing here is HTML. Classes only (08 §4 CSP).
import { Button, Pulse } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { LIVE_STREAM_STRINGS as S } from './live-strings.js';
import {
  MAX_STREAM_LINES,
  createPollingSource,
  type RawLine,
  type StreamLine,
  type StreamSource,
} from './live-stream.js';
import { cleanLine } from './clean.js';
import './live.css';

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
export interface LiveActivityPageProps {
  /** Where the lines come from (default: the polling source); the SSE source replaces it. */
  readonly source?: StreamSource;
}

export function LiveActivityPage({ source }: LiveActivityPageProps): ReactElement {
  const [lines, setLines] = useState<readonly StreamLine[]>([]);
  const [frozen, setFrozen] = useState<readonly StreamLine[] | undefined>(undefined);
  const next = useRef(0);

  useEffect(() => {
    const from = source ?? createPollingSource();
    return from.subscribe((raw: RawLine) => {
      const line: StreamLine = { ...raw, id: next.current++ };
      setLines((old) => [line, ...old].slice(0, MAX_STREAM_LINES));
    });
  }, [source]);

  const paused = frozen !== undefined;
  const shown = frozen ?? lines;
  return (
    <div className="ls-page">
      <div className="ls-head">
        <header className="ls-title">
          <span className="al-text-label ls-eyebrow">{S.eyebrow}</span>
          <h1 className="al-text-title-1">{S.title}</h1>
          <p className="al-text-body al-muted">{S.intro}</p>
        </header>
        <div className="ls-controls">
          <span className="ls-state al-text-body-sm">
            <Pulse tone={paused ? 'neutral' : 'success'} active={!paused} />
            {paused ? S.paused : S.live}
          </span>
          <Button
            variant="secondary"
            className="ls-toggle"
            onClick={() => setFrozen(paused ? undefined : lines)}
          >
            {paused ? S.resume : S.pause}
          </Button>
        </div>
      </div>
      <div className="ls-log al-text-code" role="log" aria-live="polite" aria-label={S.logLabel}>
        {shown.length === 0 ? (
          <p className="ls-empty al-muted">{S.waiting}</p>
        ) : (
          shown.map((line) => {
            const at = new Date(line.at);
            return (
              <div key={line.id} className="ls-line" data-kind={line.kind}>
                <time className="ls-time" dateTime={at.toISOString()}>
                  {TIME.format(at)}
                </time>
                <span className="ls-kind">{line.kind}</span>
                <span className="ls-text">
                  <bdi>{cleanLine(line.text)}</bdi>
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
