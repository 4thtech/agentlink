// W4-PEOPLE-INVITE: the Invite screen (prototype v23 A5, "Invite from Home"): a way back Home, the
// title and one line, the invite panel, "See what they'll see" (a still preview of the friend's
// screen, A6) and Done. Rendered in place by People (`/contacts?invite`) until Home takes it.
// W4-WIRE-2 (Decision 52 (3)): a small "Have an invite link? Paste it" accepts an invite someone sent
// you (paste-invite.tsx), in place of the old Add contact sheet.
import { Button } from '@4thtech-io/ui';
import { useId, useState, type ReactElement } from 'react';
import { createInviteApi, type InviteApi } from '../contacts/invite-api.js';
import { FingerprintIcon } from './icons.js';
import { InvitePanel, type InvitePanelProps } from './invite-panel.js';
import { useOwnName } from './own-name.js';
import { PasteInvite, type PasteInviteProps } from './paste-invite.js';
import { INVITE_STRINGS as S, PASTE_STRINGS as P, invitesYou, letterOf } from './strings.js';
import './invite.css';

export interface InviteScreenProps extends InvitePanelProps {
  /** Your name as the friend sees it in the preview; by default the open agent's name. */
  readonly sender?: string;
  readonly onDone: () => void;
  /** Where the back link goes (Home by default). */
  readonly backHref?: string;
  /** W4-WIRE-2: "Paste it": the passkey, and what follows an accepted invite. */
  readonly paste?: Omit<PasteInviteProps, 'invites'>;
}

/** A still picture of the friend's screen: not interactive, read as one figure. */
export function TheirView({ sender }: { sender: string }): ReactElement {
  const who = sender === '' ? 'Your agent' : sender;
  return (
    <figure className="inv-theirs al-reveal" aria-label={S.theirsLabel}>
      <div className="inv-friend-card">
        <div className="inv-friend-who">
          <span className="inv-avatar inv-avatar--me" aria-hidden="true">
            {letterOf(who)}
          </span>
          <span className="inv-badge al-text-caption">{S.nameBySender}</span>
        </div>
        <p className="inv-friend-title">{invitesYou(who)}</p>
        <p className="al-text-body-sm al-muted">{S.acceptBody(who)}</p>
        <span className="inv-fake-primary" aria-hidden="true">
          <FingerprintIcon />
          Accept with Touch ID
        </span>
        <p className="al-text-caption al-muted inv-center">{S.noAgentLinkYet}</p>
      </div>
    </figure>
  );
}

export interface PasteScreenProps extends Omit<PasteInviteProps, 'onOpen' | 'startOpen'> {
  readonly onDone: () => void;
  readonly backHref?: string;
}

/**
 * W4-WIRE-2 (IR-W4-WIRE-2X-1): "Have an invite link? Paste it" on its own: the field at once and no
 * invite panel, so accepting someone's invite never makes a link of yours.
 */
export function PasteScreen({ onDone, backHref = '/', ...paste }: PasteScreenProps): ReactElement {
  return (
    <div className="inv-screen al-reveal">
      <a className="inv-back" href={backHref}>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
        {S.back}
      </a>
      <div className="inv-head">
        <h1 className="inv-title">{P.title}</h1>
        <p className="inv-intro al-muted">{P.intro}</p>
      </div>
      <PasteInvite {...paste} startOpen />
      <div className="inv-foot">
        <span />
        <Button size="lg" className="al-press" onClick={onDone}>
          {S.done}
        </Button>
      </div>
    </div>
  );
}

export function InviteScreen({
  sender: givenSender,
  onDone,
  backHref = '/',
  paste,
  invites: givenInvites,
  ...panel
}: InviteScreenProps): ReactElement {
  const sender = useOwnName(givenSender);
  // One client for the panel and Paste it (the page's own same-origin server).
  const [invites] = useState<InviteApi>(() => givenInvites ?? createInviteApi());
  const [theirs, setTheirs] = useState(false);
  const theirsId = useId();
  return (
    <div className="inv-screen al-reveal">
      <a className="inv-back" href={backHref}>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
        {S.back}
      </a>
      <div className="inv-head">
        <h1 className="inv-title">{S.title}</h1>
        <p className="inv-intro al-muted">{S.intro}</p>
      </div>
      <InvitePanel {...panel} invites={invites} />
      <PasteInvite invites={invites} {...paste} />
      <div className="inv-foot">
        <button
          type="button"
          className="inv-link-button"
          aria-expanded={theirs}
          aria-controls={theirsId}
          onClick={() => setTheirs((on) => !on)}
        >
          {theirs ? S.hideTheirs : S.seeTheirs}
        </button>
        <Button size="lg" className="al-press" onClick={onDone}>
          {S.done}
        </Button>
      </div>
      <div id={theirsId}>{theirs ? <TheirView sender={sender} /> : null}</div>
    </div>
  );
}
