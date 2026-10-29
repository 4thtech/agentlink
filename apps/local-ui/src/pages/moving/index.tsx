// The moving-row mark (U3-map-2; b11 §32.1, §32.3, §32.5): a 12 px dash with the word "Sending" or
// "Receiving" on a row that has a stream now. It shows direction and a word only: no name, file name,
// text or link, and no hover preview. The dash travels once (1.2 s) by `stroke-dashoffset`; under
// reduced motion it is a static arrowhead and the word "now".
import { useReducedMotion } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import type { Moving } from './data.js';
import './moving.css';
import { MOVING_STRINGS as S } from './strings.js';

export { useMoving } from './use-moving.js';
export { useFileMarks, type FileMarker } from './use-file-marks.js';
export * from './data.js';
export { MOVING_STRINGS } from './strings.js';

export function MovingMark({ moving }: { readonly moving: Moving }): ReactElement {
  const reduced = useReducedMotion();
  const out = moving.direction === 'out';
  const word = out ? S.sending : S.receiving;
  const run = moving.animate && !reduced;
  return (
    <span
      className="mv-mark al-text-body-sm"
      data-direction={moving.direction}
      role="status"
      aria-label={`${word}…`}
    >
      <svg
        className="mv-glyph"
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden="true"
        focusable="false"
      >
        <path className="mv-line" d="M1 6h8" />
        {run ? (
          <path className="mv-dash mv-run" d={out ? 'M1 6h8' : 'M9 6H1'} pathLength="10" />
        ) : null}
        <path className="mv-head" d={out ? 'M7 3l3 3-3 3' : 'M5 3L2 6l3 3'} />
      </svg>
      <span className="mv-word">{reduced ? `${word} ${S.now}` : word}</span>
    </span>
  );
}
