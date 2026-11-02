// W7-ID-B1 (improvement b; D-144): "An ID is your AI app's identity on AgentLink…", a small dismissible
// card. Shown on first run (the Confirm and Name screens); the empty IDs page imports it from here.
// Styled from the Get started card (`st-card`); hiding is a preference in this browser, not setup
// state (the same way the Get started card is hidden).
import { Icon } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import { ID_EXPLAINER as T } from './strings.js';
import './start.css';

export const ID_EXPLAINER_HIDDEN_KEY = 'agentlink.idExplainer.hidden';

function hiddenHere(): boolean {
  try {
    return localStorage.getItem(ID_EXPLAINER_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function hideHere(): void {
  try {
    localStorage.setItem(ID_EXPLAINER_HIDDEN_KEY, '1');
  } catch {
    // Not remembered: hidden until the page loads again.
  }
}

export function IdExplainerCard(): ReactElement | null {
  const [hidden, setHidden] = useState(hiddenHere);
  if (hidden) return null;
  return (
    <aside className="st-card st-explainer" aria-labelledby="st-explainer-h">
      <div className="st-card-head">
        <h2 id="st-explainer-h" className="st-eyebrow">
          {T.title}
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
      <p className="al-text-body-sm al-muted">{T.body}</p>
    </aside>
  );
}
