// The Start here card on Home (UX2-g; B-11 §27.2, §27.3). Presentational: the model comes from
// useStartHere (shared by the shell through StartHereContext).
//
// One primary button in the whole card, on the next step; later steps show a hollow ring and no
// button; done steps show a check and muted text. No close, hide, snooze or menu, and no step can
// be ticked by hand. Every value is React text (I-5).
import { CopyPrompt, Icon, Skeleton } from '@4thtech-io/ui';
import type { ReactElement, ReactNode } from 'react';
import { CONTACTS_STRINGS } from '../contacts/strings.js';
import { FIRST_RUN, type Platform } from '../first-run/strings.js';
import type { StartHereModel } from './start-here-context.js';
import type { StartView, StepId, StepView } from './start-here.js';
import { START_STRINGS as T, startProgress, startWaiting } from './strings.js';

const PLATFORM_WORD: Readonly<Record<Platform, string>> = {
  mac: FIRST_RUN.useTouchId,
  windows: FIRST_RUN.useWindowsHello,
  other: FIRST_RUN.usePasskey,
};
const TITLE: Readonly<Record<StepId, string>> = {
  protect: T.protect,
  invite: T.invite,
  check: T.check,
  send: T.send,
  kit: T.kit,
};
const STATE_WORD = {
  done: T.stateDone,
  next: T.stateNext,
  waiting: '',
  later: T.stateLater,
} as const;

function Mark({ state }: { state: StepView['state'] }): ReactElement {
  return (
    <span className="hm-start-mark" data-mark={state} aria-hidden="true">
      {state === 'done' ? <Icon name="check" size={16} className="hm-start-check" /> : null}
    </span>
  );
}

function Detail({
  step,
  view,
  platform,
}: {
  step: StepView;
  view: StartView;
  platform: Platform;
}): ReactNode {
  const next = step.state === 'next';
  switch (step.id) {
    case 'protect':
      return next ? (
        <>
          <p className="al-text-body-sm al-muted">{T.protectBody}</p>
          <a className="al-btn al-btn-primary hm-start-action" href="/first-run">
            {PLATFORM_WORD[platform]}
          </a>
        </>
      ) : null;
    case 'invite':
      // Until the Add contact sheet lands (UX2-d1, UX2-d2) this points to the invite instructions
      // that exist today: ask your AI to create one.
      return next ? (
        <>
          <p className="al-text-body-sm al-muted">{T.inviteBody}</p>
          <CopyPrompt prompt={CONTACTS_STRINGS.emptyPrompt} />
        </>
      ) : null;
    case 'check':
      if (step.state === 'waiting') {
        return <p className="al-text-body-sm al-muted">{startWaiting(step.name ?? null)}</p>;
      }
      return step.state === 'later' && step.compare === true ? (
        <a className="al-btn al-btn-secondary al-btn-sm hm-start-action" href="/settings/contacts">
          {T.compare}
        </a>
      ) : null;
    case 'send':
      return next ? (
        <>
          <p className="al-text-body-sm al-muted">{T.sendBody}</p>
          <CopyPrompt prompt={view.helloPrompt} />
        </>
      ) : null;
    case 'kit':
      return next ? (
        <>
          <p className="al-text-body-sm al-muted">{T.kitBody}</p>
          <a className="al-btn al-btn-primary hm-start-action" href="/settings/backup">
            {T.kitAction}
          </a>
        </>
      ) : null;
  }
}

export function StartHere({
  model,
  platform,
}: {
  model: StartHereModel;
  platform: Platform;
}): ReactElement {
  const { phase, view } = model;
  let card: ReactElement | null = null;
  if (phase === 'loading') {
    card = (
      <section className="hm-start is-loading" data-start-here data-loading="true">
        <Skeleton loading lines={5} label={T.loading} />
      </section>
    );
  } else if (view !== null && (phase === 'shown' || phase === 'allset' || phase === 'leaving')) {
    const fresh = new Set(model.fresh ?? []);
    card = (
      <section
        className={`hm-start${phase === 'leaving' ? ' is-leaving' : ''}`}
        data-start-here
        data-phase={phase}
        aria-labelledby="hm-start-title"
      >
        <header className="hm-start-head">
          <h2 id="hm-start-title" className="hm-start-title al-text-code">
            {T.title}
          </h2>
          <span key={view.doneCount} className="hm-start-count al-text-code" data-start-count>
            {startProgress(view.doneCount, view.total)}
          </span>
        </header>
        <div
          className="hm-start-bar"
          role="progressbar"
          aria-label={T.progressLabel}
          aria-valuemin={0}
          aria-valuemax={view.total}
          aria-valuenow={view.doneCount}
          aria-valuetext={startProgress(view.doneCount, view.total)}
        >
          <span className="hm-start-fill" data-n={view.doneCount} />
        </div>
        {phase === 'shown' ? (
          <ol className="hm-start-steps">
            {view.steps.map((step) => (
              <li
                key={step.id}
                className={`hm-start-step${fresh.has(step.id) ? ' is-fresh' : ''}`}
                data-step={step.id}
                data-state={step.state}
                aria-current={step.state === 'next' ? 'step' : undefined}
              >
                <Mark state={step.state} />
                <div className="hm-start-text">
                  <p className="hm-start-name al-text-body">
                    {TITLE[step.id]}
                    {step.id === 'check' ? (
                      <span className="hm-start-rec al-muted"> {T.recommended}</span>
                    ) : null}
                    {STATE_WORD[step.state] === '' ? null : (
                      <span className="al-visually-hidden">. {STATE_WORD[step.state]}</span>
                    )}
                  </p>
                  <Detail step={step} view={view} platform={platform} />
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="hm-start-allset al-text-title-3">
            <Icon name="check" size={20} className="hm-start-check" />
            {T.allSet}
          </p>
        )}
      </section>
    );
  }
  return (
    <>
      <div className="al-visually-hidden" role="status" aria-live="polite" data-start-live>
        {model.announce}
      </div>
      {card}
    </>
  );
}
