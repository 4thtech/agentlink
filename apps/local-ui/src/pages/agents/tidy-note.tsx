// U3-h: the calm "Tidy up" note on Home (b11 §29.7), above the Start here card, never inside it.
// Shown only when at least one agent serves no AI app and has no contacts, the Agents page has not
// been opened, and the note was not dismissed. Neutral tone: nothing needs you.
import { Button, PageNotice } from '@4thtech-io/ui';
import { useMemo, useState, type ReactElement } from 'react';
import { navigate } from '../../router.js';
import type { AgentsApi } from './api.js';
import { AGENTS_PATH, tidyCandidates } from './data.js';
import { AGENTS_STRINGS as S } from './strings.js';
import { agentsOpened, dismissTidy, tidyDismissed } from './tidy.js';
import { listOf, useAgents } from './use-agents.js';
import './agents.css';

export function TidyNote({ api }: { api?: AgentsApi } = {}): ReactElement | null {
  const { state } = useAgents(api, () => undefined);
  const [hidden, setHidden] = useState(() => tidyDismissed() || agentsOpened());
  const list = listOf(state);
  const count = useMemo(() => tidyCandidates(list?.agents ?? []).length, [list]);
  if (hidden || list === undefined || !list.switchable || count === 0) return null;
  return (
    <PageNotice
      tone="neutral"
      icon="sliders-horizontal"
      title={S.tidyNote(count)}
      className="ag-tidy"
      actions={
        <Button size="sm" variant="secondary" onClick={() => navigate(AGENTS_PATH)}>
          {S.tidyUp}
        </Button>
      }
      onDismiss={() => {
        dismissTidy();
        setHidden(true);
      }}
      dismissLabel={S.notNow}
    >
      <p>{S.tidyHint}</p>
    </PageNotice>
  );
}
