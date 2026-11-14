// WIN-BROKEN-ID (04 §2.5 "An ID whose key is missing"; 11 §5): an ID whose key is missing from this
// computer is never a dead end. Home names it in one notice, styled as the "wasn't fully removed"
// notice beside it (finish-remove.tsx, PageNotice), with three choices:
// - Restore from backup: the restore-in-app flow (D-147, /restore/kit).
// - Remove from this computer: the IDs page's Remove sheet in its set-aside mode (sheets.tsx: the
//   typed name and the owner's presence; the folder is moved aside, nothing is retired or sent).
// - Continue without it: the notice goes for this visit; the ID stays marked "Can't be opened here"
//   and the other IDs keep working.
// The row comes from the shared live read (api/live.ts); labels are text only (I-5).
import { Button, PageNotice } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import type { AgentRow } from './data.js';
import { AGENTS_STRINGS as S } from './strings.js';
import './agents.css';

/** The restore-in-app flow's first step (D-147). */
export const RESTORE_HREF = '/restore/kit';

export function BrokenIdNotice({
  row,
  onRemove,
  onContinue,
}: {
  readonly row: AgentRow;
  readonly onRemove: (row: AgentRow) => void;
  readonly onContinue: (row: AgentRow) => void;
}): ReactElement {
  return (
    <div data-broken-id={row.name}>
      <PageNotice
        tone="warning"
        title={S.brokenTitle(row.label)}
        actions={
          <>
            <a className="al-btn al-btn-primary al-btn-sm al-press" href={RESTORE_HREF}>
              {S.restoreFromBackup}
            </a>
            <Button size="sm" variant="secondary" onClick={() => onRemove(row)}>
              {S.removeFromComputer}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onContinue(row)}>
              {S.continueWithout}
            </Button>
          </>
        }
      >
        {S.brokenBody}
      </PageNotice>
    </div>
  );
}
