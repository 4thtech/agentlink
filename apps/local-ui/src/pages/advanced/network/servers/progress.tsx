// NET-UI-B (C6, C7; D-158): after a change, "Telling your contacts… N of M" from the card-update
// outbox rows (`GET /api/ui/network/progress`), then "Done". A contact's name is the name rule's
// text from the route; it renders as plain text (I-5). Nothing here lists a contact's host or key.
import { ProgressBar, StatusChip } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import type { Progress } from './api.js';
import { dayText, timeText } from './messages.js';
import { SERVERS_STRINGS as S } from './strings.js';

export function ProgressCard({
  progress: p,
  ownCount,
}: {
  readonly progress: Progress;
  /** How many servers this ID uses itself now. */
  readonly ownCount: number;
}): ReactElement {
  const until = p.leavingUntil === null ? undefined : dayText(p.leavingUntil);
  const working = p.waiting > 0;
  const plain = working || p.total === 0;
  return (
    <section
      className="nw-card"
      aria-label={S.changedTitle}
      data-servers-progress={working ? 'working' : 'done'}
    >
      <div className="nw-head">
        <div>
          <h3 className="al-text-title-3">{plain ? S.changedTitle : S.allHave(p.total)}</h3>
          <p className="al-text-body-sm al-muted">
            {plain ? S.changedAt(timeText(p.changedAt)) : S.nowUse(ownCount, until)}
          </p>
        </div>
        {working ? null : <StatusChip status="approved">{S.doneChip}</StatusChip>}
      </div>
      {working ? (
        <>
          <ProgressBar label={S.telling(p.sent, p.total)} value={p.sent} max={p.total} />
          <p className="al-text-body-sm al-muted">{S.restWait}</p>
          {until === undefined ? null : <p className="al-text-body-sm">{S.oldUntil(until)}</p>}
          <ul className="nw-contacts" aria-label={S.telling(p.sent, p.total)}>
            {p.items.map((c, i) => (
              <li key={`${String(i)}-${c.name}`} className="nw-contact">
                <div className="nw-head">
                  <span className="al-text-body">{c.name}</span>
                  <StatusChip status={c.state === 'sent' ? 'sent' : 'waiting-to-post'}>
                    {c.state === 'sent' ? S.sent : S.waiting}
                  </StatusChip>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
