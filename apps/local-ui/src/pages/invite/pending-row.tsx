// W4-PEOPLE-INVITE: one open invite in the People list (prototype v23 A4, A10; W4-INVITES-LIST).
// Exported for Home (U3). A dashed letter, the name (or "Someone"), "Waiting for … · link works N
// more days" and Cancel invite; once cancelled, "Invite cancelled. The link no longer works." stays
// in place. Under the hood: the invite's ID and its exact expiry. The name is the owner's own label,
// rendered as text. REL051-B2 (owner test, 13 Nov): Copy link and Show link get the invite's kept
// link from this app on a click (invite-link-actions.tsx); the list itself never carries a link.
import { Button, useHood } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import type { ConnectingRow, LinkOutcome, OpenInvite } from '../contacts/invite-api.js';
import { cancelProminent, connectingLine, useConnectingView } from './connecting-stage.js';
import { InviteLinkButtons, InviteLinkReveal, useInviteLink } from './invite-link-actions.js';
import {
  FEEDBACK_STRINGS as F,
  INVITE_STRINGS as S,
  letterOf,
  linkLabel,
  waitingLine,
} from './strings.js';
import './invite.css';

const DAY_MS = 86_400_000;

/** What Cancel came to: the row says so, the page drops it ('gone'), or it stays with a line. */
export type CancelResult = 'cancelled' | 'gone' | 'failed';

export interface PendingInviteRowProps {
  readonly invite: OpenInvite;
  /** Unix milliseconds. */
  readonly now: number;
  readonly onCancel: (inviteId: string) => Promise<CancelResult>;
  /** REL051-B2: reads the invite's kept link (Copy link, Show link); absent: no link actions. */
  readonly onLink?: (inviteId: string) => Promise<LinkOutcome>;
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
  onLink,
  cancelled: givenCancelled = false,
  highlight = false,
}: PendingInviteRowProps): ReactElement {
  const hood = useHood();
  const link = useInviteLink(invite.inviteId, onLink);
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
        {done || onLink === undefined ? null : (
          <InviteLinkReveal link={link} label={linkLabel(invite.name ?? '')} />
        )}
      </span>
      {done ? null : (
        <span className="inv-pending-actions">
          {onLink === undefined ? null : <InviteLinkButtons link={link} />}
          <Button
            size="sm"
            variant="ghost"
            className="al-press"
            disabled={state === 'busy'}
            onClick={cancel}
          >
            {state === 'busy' ? S.cancelling : S.cancelInvite}
          </Button>
        </span>
      )}
    </li>
  );
}

/**
 * W5-INVITE-FEEDBACK: one accept of this agent that waits for the inviter's answer (from the server,
 * so it survives a reload). REL051-CF1 (R1-CLASS-01, -06): the line follows how long it has waited
 * (connecting-stage.ts): "Connecting to {name}…", then a "still waiting, you can close this" hint,
 * then "No answer … ask {name} for a new one". Every row has Cancel (REL051-B1's server route), so a
 * row that will never finish (a used or cancelled invite) can always be removed; a blocked person
 * also gets Unblock. The name is text only (I-5).
 */
export function ConnectingInviteRow({
  row,
  blocked = row.blocked === true,
  onUnblock,
  onCancel,
}: {
  readonly row: ConnectingRow;
  /** The person is blocked here (the server says so, or the page found them blocked). */
  readonly blocked?: boolean;
  /** Unblocks the person (or opens them where Unblock lives); absent when not possible here. */
  readonly onUnblock?: () => void;
  /**
   * REL051-B1 (N2): Cancel, through the server (`POST /api/ui/invites/connecting/cancel`). The row
   * leaves once the server dropped the accept ('cancelled' or 'gone'); absent, no Cancel is shown.
   */
  readonly onCancel?: () => Promise<CancelResult>;
}): ReactElement {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const view = useConnectingView(blocked ? { ...row, blocked: true } : row);
  const shown = view.row;
  const now = view.now;
  if (hidden) return <></>;
  return (
    <li className="inv-pending inv-connecting" data-blocked={blocked ? 'true' : undefined}>
      <span className="inv-pending-letter" aria-hidden="true">
        {letterOf(row.name)}
      </span>
      <span className="inv-pending-main">
        <span className="inv-pending-name">{row.name}</span>
        <span className="al-text-body-sm al-muted">{connectingLine(shown, now)}</span>
        {failed ? (
          <span role="alert" className="al-text-body-sm">
            {F.cancelConnectingFailed}
          </span>
        ) : null}
      </span>
      {blocked || onCancel !== undefined ? (
        <span className="inv-pending-actions">
          {blocked && onUnblock !== undefined ? (
            <Button size="sm" onClick={onUnblock}>
              {F.unblockAction}
            </Button>
          ) : null}
          {onCancel === undefined ? null : (
            <Button
              size="sm"
              variant={cancelProminent(shown, now) ? 'secondary' : 'ghost'}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setFailed(false);
                void onCancel().then(
                  (result) => {
                    setBusy(false);
                    if (result === 'failed') setFailed(true);
                    else setHidden(true);
                  },
                  () => {
                    setBusy(false);
                    setFailed(true);
                  },
                );
              }}
            >
              {F.cancelConnecting}
            </Button>
          )}
        </span>
      ) : null}
    </li>
  );
}
