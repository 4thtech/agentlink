// Pick your AI app (U3-g; b11 §28.2): the first real decision, on its own screen. A radio list of the
// AI apps found on this computer (a local look at the fixed config paths; nothing is sent), the first
// preselected, "I'll choose later" last. Nothing is written here: the choice only suggests the agent's
// name on the next screen and decides whether "Connect your AI app" follows.
import { Button, Skeleton } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import { useTitleFocus } from '../welcome/index.js';
import type { DetectedApp } from './apps-api.js';
import { PICK as T } from './strings.js';
import './first-run.css';

/** The app's first letter on a sunken square. Generic, no logos; the name always sits next to it. */
export function AppMark({ name }: { readonly name: string }): ReactElement {
  return (
    <span className="fr-mark al-text-caption" aria-hidden="true">
      {[...name][0]?.toUpperCase() ?? ''}
    </span>
  );
}

/** What the app look found: still looking, the apps, or no answer (a plain line, Continue stays). */
export type PickList =
  | { readonly k: 'loading' }
  | { readonly k: 'ok'; readonly apps: readonly DetectedApp[] }
  | { readonly k: 'unavailable' };

export interface PickAppProps {
  readonly list: PickList;
  /** The chosen app's id, or 'later'. */
  readonly choice: string;
  readonly onChoose: (choice: string) => void;
  readonly onContinue: () => void;
  readonly onBack: () => void;
}

export function PickApp({
  list,
  choice,
  onChoose,
  onContinue,
  onBack,
}: PickAppProps): ReactElement {
  const title = useTitleFocus<HTMLHeadingElement>();
  const loading = list.k === 'loading';
  return (
    <section className="fr-card" aria-labelledby="fr-pick-h">
      <h1 id="fr-pick-h" ref={title} tabIndex={-1} className="al-text-title-1">
        {T.title}
      </h1>
      {list.k === 'loading' ? (
        <Skeleton loading label={T.loading} lines={3} />
      ) : list.k === 'unavailable' ? (
        <p className="al-text-body al-muted" role="status">
          {T.lookFailed}
        </p>
      ) : list.apps.length === 0 ? (
        <p className="al-text-body al-muted" role="status">
          {T.none}
        </p>
      ) : (
        <div className="fr-apps" role="radiogroup" aria-labelledby="fr-pick-h">
          {list.apps.map((app) => (
            <label key={app.id} className="fr-app">
              <input
                type="radio"
                name="ai-app"
                value={app.id}
                checked={choice === app.id}
                onChange={() => onChoose(app.id)}
              />
              <AppMark name={app.name} />
              <span className="fr-app-name al-text-body">{app.name}</span>
              <span className="fr-app-state al-text-caption">{T.found}</span>
            </label>
          ))}
          <label className="fr-app">
            <input
              type="radio"
              name="ai-app"
              value="later"
              checked={choice === 'later'}
              onChange={() => onChoose('later')}
            />
            <span className="fr-app-name al-text-body">{T.later}</span>
          </label>
        </div>
      )}
      <div className="fr-actions">
        <Button variant="primary" size="lg" disabled={loading} onClick={onContinue}>
          {T.next}
        </Button>
        <Button variant="ghost" size="sm" onClick={onBack}>
          {T.back}
        </Button>
      </div>
    </section>
  );
}
