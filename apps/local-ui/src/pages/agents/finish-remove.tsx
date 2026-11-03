// W8-S4 (F16, F21; 04 §2.5 "Finishing a removal"; 11 §5.8 "Unfinished removal"): Finish removing
// from Home and the ID switcher. An ID whose removal stopped part-way is never shown as a usable ID
// there: one line "{label} wasn't fully removed" with Finish removing, which opens the same Remove
// sheet the IDs page uses, in its finish mode (no typed name; export first; presence still asked).
// The row comes from the shared live read (api/live.ts); labels are text only (I-5).
import { Banner, Button } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import type { OwnerClient } from '../contacts/owner.js';
import type { AgentsApi } from './api.js';
import type { AgentRow } from './data.js';
import { RemoveSheet } from './sheets.js';
import { AGENTS_STRINGS as S } from './strings.js';
import { announceAgentsChanged } from './use-agents.js';
// The Remove sheet's own layout (it also opens on Home and in the switcher).
import './agents.css';

/** One half-removed ID on Home: its line and Finish removing (the Home banner, as its other notes). */
export function UnfinishedRemoval({
  row,
  onFinish,
}: {
  readonly row: AgentRow;
  readonly onFinish: (row: AgentRow) => void;
}): ReactElement {
  return (
    <div data-unfinished={row.name}>
      <Banner tone="warning">
        {S.notFullyRemoved(row.label)}{' '}
        <Button size="sm" onClick={() => onFinish(row)}>
          {S.finishRemoving}
        </Button>
      </Banner>
    </div>
  );
}

/** The Remove sheet in finish mode for `row`; the live read follows once it changes anything. */
export function FinishRemoveSheet({
  row,
  api,
  owner,
  onClose,
}: {
  readonly row: AgentRow;
  readonly api: AgentsApi;
  readonly owner: OwnerClient;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <RemoveSheet
      key={row.name}
      row={row}
      api={api}
      owner={owner}
      onClose={onClose}
      onChanged={announceAgentsChanged}
      onRemoved={onClose}
      onAgentChanged={() => {
        announceAgentsChanged();
        onClose();
      }}
    />
  );
}
