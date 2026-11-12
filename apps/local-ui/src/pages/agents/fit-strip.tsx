// WP-I1 (spec §2.1, §4): the "how it fits" strip on My IDs: AI app -> ID -> people. It shows until the
// owner hides it, and always while there is exactly one ID with no people yet. The hiding is a
// preference in this browser (try/catch; no storage means it shows again), not setup state.
import { Icon } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import type { AgentRow } from './data.js';
import { AGENTS_STRINGS as S } from './strings.js';

export const FIT_STRIP_HIDDEN_KEY = 'agentlink.idsFit.hidden';

function hiddenHere(): boolean {
  try {
    return localStorage.getItem(FIT_STRIP_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Always shown while one ID has no people (the owner has nothing else to look at yet). */
export function fitStripForced(rows: readonly AgentRow[]): boolean {
  return rows.length === 1 && (rows[0]?.contacts ?? 0) === 0;
}

export function FitStrip({ rows }: { rows: readonly AgentRow[] }): ReactElement | null {
  const [hidden, setHidden] = useState(hiddenHere);
  const forced = fitStripForced(rows);
  if (hidden && !forced) return null;
  const hide = (): void => {
    try {
      localStorage.setItem(FIT_STRIP_HIDDEN_KEY, '1');
    } catch {
      // Not remembered: hidden until the page loads again.
    }
    setHidden(true);
  };
  return (
    <aside className="ag-fit" aria-label={S.fitLabel}>
      <div className="ag-fit-box">
        <Icon name="ai-app" size={20} />
        <span className="ag-fit-text">
          <strong className="al-text-body-sm">{S.fitApp}</strong>
          <span className="al-text-body-sm al-muted">{S.fitAppBody}</span>
        </span>
      </div>
      <span className="ag-fit-arrow al-text-caption al-muted" aria-hidden="true">
        {S.fitUses}
      </span>
      <div className="ag-fit-box is-id">
        <Icon name="agent" size={20} />
        <span className="ag-fit-text">
          <strong className="al-text-body-sm">{S.fitId}</strong>
          <span className="al-text-body-sm al-muted">{S.fitIdBody}</span>
        </span>
      </div>
      <span className="ag-fit-arrow al-text-caption al-muted" aria-hidden="true">
        {S.fitTalks}
      </span>
      <div className="ag-fit-box">
        <Icon name="users" size={20} />
        <span className="ag-fit-text">
          <strong className="al-text-body-sm">{S.fitPeople}</strong>
          <span className="al-text-body-sm al-muted">{S.fitPeopleBody}</span>
        </span>
      </div>
      {forced ? null : (
        <button type="button" className="ag-fit-hide" aria-label={S.fitHide} onClick={hide}>
          <Icon name="x" size={16} />
        </button>
      )}
    </aside>
  );
}
