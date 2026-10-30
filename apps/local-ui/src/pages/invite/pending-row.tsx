// W4-PEOPLE-INVITE: one open invite in the People list (prototype v23 A4, A10; W4-INVITES-LIST).
// Exported for Home (U3). A dashed letter, the name (or "Someone"), "Waiting for … · link works N
// more days" and Cancel invite; once cancelled, "Invite cancelled. The link no longer works." stays
// in place. Under the hood: the invite's ID and its exact expiry. Never a link: a lost link is
// cancelled and a new one made. The name is the owner's own label, rendered as text.
import { Button, useHood } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import type { OpenInvite } from '../contacts/invite-api.js';
import { INVITE_STRINGS as S, letterOf, waitingLine } from './strings.js';
import './invite.css';

const DAY_MS = 86_400_000;

/** What Cancel came to: the row says so, the page drops it ('gone'), or it stays with a line. */
export type CancelResult = 'cancelled' | 'gone' | 'failed';

export interface PendingInviteRowProps {
  readonly invite: OpenInvite;
  /** Unix milliseconds. */
  readonly now: number;
  readonly onCancel: (inviteId: string) => Promise<CancelResult>;
  /** Already cancelled in this visit (the page keeps the row after the server dropped it). */
  readonly cancelled?: boolean;
  /** Briefly marks a row that just arrived (colour only). */
  readonly highlight?: boolean;
}

const exact = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function PendingInviteRow({
  invite,
  now,
  onCancel,
  cancelled: givenCancelled = false,
  highlight = false,
}: PendingInviteRowProps): ReactElement {
  const hood = useHood();
  const [state, setState] = useState<'open' | 'busy' | 'cancelled' | 'failed'>(
    givenCancelled ? 'cancelled' : 'open',
  );
  const done = givenCancelled || state === 'cancelled';
  const days = Math.max(0, Math.ceil((invite.expiresAt - now) / DAY_MS));
  const name = invite.name ?? S.someone;

  const cancel = (): void => {
    if (state === 'busy') return;
    setState('busy');
    void onCancel(invite.inviteId).then(
      (outcome) => setState(outcome === 'failed' ? 'failed' : 'cancelled'),
      () => setState('failed'),
    );
  };

  return (
    <li className={`inv-pending${highlight ? ' is-new' : ''}${done ? ' is-done' : ''}`}>
      <span className="inv-pending-letter" aria-hidden="true">
        {letterOf(name)}
      </span>
      <span className="inv-pending-main">
        <span className="inv-pending-name">{name}</span>
        <span className="al-text-body-sm al-muted">
          {done ? S.cancelled : waitingLine(invite.name, days)}
        </span>
        {hood ? (
          <span className="inv-mono al-text-caption al-muted">
            {invite.inviteId} · {S.expires.toLowerCase()} {exact(invite.expiresAt)}
          </span>
        ) : null}
        {state === 'failed' ? (
          <span className="al-text-body-sm inv-error" role="alert">
            {S.cantCancel}
          </span>
        ) : null}
      </span>
      {done ? null : (
        <Button size="sm" className="al-press" disabled={state === 'busy'} onClick={cancel}>
          {state === 'busy' ? S.cancelling : S.cancelInvite}
        </Button>
      )}
    </li>
  );
}
