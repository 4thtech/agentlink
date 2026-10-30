// W4-WIZARD (W4 UX v2 layer 1; artboard A4): the Home card "Get started · n of 3 done", one of the
// three ways back into Get started (with Help → Get started and Cmd+K). Exported for Home (U3) to
// place; this unit owns it. Every tick comes from a real read (setup-state.ts), never from a click;
// the card hides itself once all three are done, or when the person hides it (remembered in this
// browser: hiding is a preference, not setup state). An unanswered read shows nothing.
import { Icon } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { INTERIM_PEOPLE_PATH } from '../../nav.js';
import {
  readSetupState,
  startProgress,
  type CardStep,
  type Progress,
  type SetupState,
} from './setup-state.js';
import { CARD as T } from './strings.js';
import './start.css';

export const CARD_HIDDEN_KEY = 'agentlink.getStarted.hidden';

function hiddenHere(): boolean {
  try {
    return localStorage.getItem(CARD_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function hideHere(): void {
  try {
    localStorage.setItem(CARD_HIDDEN_KEY, '1');
  } catch {
    // Not remembered: hidden until the page loads again.
  }
}

/** Where each step's link goes: Get started for the first, People for the other two (U4). */
export function stepHref(step: CardStep): string {
  return step.id === 'connect' ? '/start/app' : INTERIM_PEOPLE_PATH;
}

function stepWords(step: CardStep): string {
  if (step.id === 'connect') return T.connect;
  if (step.id === 'invite') return T.invite;
  return T.check(step.name ?? null);
}

export interface GetStartedCardProps {
  /** Test seam: the real state. Default: the app's own reads. */
  readonly read?: () => Promise<SetupState>;
}

export function GetStartedCard({
  read = readSetupState,
}: GetStartedCardProps): ReactElement | null {
  const [hidden, setHidden] = useState(hiddenHere);
  const [progress, setProgress] = useState<Progress | undefined>(undefined);
  useEffect(() => {
    if (hidden) return undefined;
    let live = true;
    void read().then(
      (state) => {
        if (live) setProgress(startProgress(state));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [read, hidden]);
  if (hidden || progress === undefined || progress.complete || progress.unknown) return null;
  const next = progress.steps.find((s) => !s.done);
  return (
    <section className="st-card al-reveal" aria-labelledby="st-card-h">
      <div className="st-card-head">
        <h2 id="st-card-h" className="st-eyebrow">
          {T.title(progress.done, progress.total)}
        </h2>
        <button
          type="button"
          className="st-card-hide"
          aria-label={T.hide}
          onClick={() => {
            hideHere();
            setHidden(true);
          }}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="st-card-bar" aria-hidden="true">
        {progress.steps.map((s) => (
          <span
            key={s.id}
            className="st-seg"
            data-state={s.done ? 'done' : s === next ? 'current' : 'todo'}
          />
        ))}
      </div>
      <ul className="st-card-steps">
        {progress.steps.map((s) =>
          s.done ? (
            <li key={s.id}>
              <Icon name="check" size={14} strokeWidth={2.5} className="st-ok" />
              <span className="al-sr-only">Done: </span>
              {stepWords(s)}
            </li>
          ) : (
            <li key={s.id}>
              <a href={stepHref(s)}>
                {stepWords(s)}
                <Icon name="chevron-right" size={14} />
              </a>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
