// W4-WIRE-2 (owner Decision 52 (3)): "Have an invite link? Paste it", the Invite screen's small
// secondary way to accept an invite someone sent you. It replaces the old Add contact sheet.
//
// - The pasted text is untrusted (I-5). Only the AgentLink invite forms go on: the short link
//   `https://agentlink.4thtech.io/i#2.<43>` and the long link `https://agentlink.4thtech.io/i#<payload>`
//   (alone, without `https://`, or inside the message the inviter's app wrote). Anything else is
//   refused here, with no request. Nothing is ever navigated to or opened: the link goes only to this
//   same-origin server, through the existing accept path (`POST /api/ui/invites/check`, then the
//   owner route `POST /api/ui/invites/accept`), which resolves short links and keeps its SSRF rules.
// - Checked: the friend's card (as the join screen draws it), "{name} invites you to connect your
//   AIs", the short owner fingerprint and the date it works until, and one Accept with Touch ID (or
//   the backup code). The inviter's name is React text under the name rule; the link is never in an
//   attribute, the address, the title, a log or an error.
// - Accepted: the page shows the Connected moment once the new contact arrives (People).
import { Button, InlineError, ProgressBar, TextArea, formatContactName } from '@4thtech-io/ui';
import { useId, useState, type FormEvent, type ReactElement } from 'react';
import type { CheckedInvite, InviteApi, InviteRefusal } from '../contacts/invite-api.js';
import { passkeyProof, type PasskeyInfo, type PresenceProof } from '../contacts/owner.js';
import { PresencePrompt } from '../contacts/presence-prompt.js';
import { CONTACTS_STRINGS as C, waitSeconds } from '../contacts/strings.js';
import { detectPlatform } from '../first-run/passkey.js';
import type { Platform } from '../first-run/strings.js';
import { JOIN_STRINGS as J } from '../join/strings.js';
import { FingerprintIcon } from './icons.js';
import { INVITE_STRINGS as S, PASTE_STRINGS as P, invitesYou, letterOf } from './strings.js';

/** The canonical invite link prefix (core INVITE_LINK_PREFIX). */
const PREFIX = 'https://agentlink.4thtech.io/i#';
const BARE = 'agentlink.4thtech.io/i#';
/** Short link (04 §3.6.2): `2.` and the 43-character secret. */
const SHORT = /^2\.[A-Za-z0-9_-]{43}$/;
/** Long link (04 §3.6): strict base64url, at most the codec's payload bound. */
const PAYLOAD = /^[A-Za-z0-9_-]{1,21846}$/;
/** More pasted text than any message with one link in it: refused unread. */
const MAX_TEXT = 32_768;
/** Punctuation a sentence or a quote may put around a link. */
const EDGE = /^[("'<[{“‘]+|[)"'>\]}.,;:!?”’]+$/g;

/**
 * The one AgentLink invite link in pasted text, as `https://agentlink.4thtech.io/i#<code>`, or
 * undefined. Every other text, another host or scheme, a look-alike host or two different links, is
 * refused (fail closed); the server checks the link again.
 */
export function inviteLinkOf(text: string): string | undefined {
  if (text.length > MAX_TEXT) return undefined;
  const found = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(EDGE, '');
    const rest = token.startsWith(PREFIX)
      ? token.slice(PREFIX.length)
      : token.startsWith(BARE)
        ? token.slice(BARE.length)
        : undefined;
    if (rest === undefined) continue;
    if (!SHORT.test(rest) && !PAYLOAD.test(rest)) return undefined;
    found.add(rest);
  }
  if (found.size !== 1) return undefined;
  const [code] = found;
  return `${PREFIX}${code ?? ''}`;
}

const REFUSED: Readonly<Record<InviteRefusal, string>> = {
  expired: P.expired,
  own: P.own,
  damaged: P.damaged,
  cant_use: P.cantUse,
  unavailable: P.unavailable,
};

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export interface PasteInviteProps {
  readonly invites: InviteApi;
  /** The owner's passkey on this computer; without one, Accept asks for the backup code. */
  readonly passkey?: PasskeyInfo | undefined;
  /** The passkey gesture. Default: passkeyProof. */
  readonly gesture?: (info: PasskeyInfo) => Promise<PresenceProof | undefined>;
  readonly platform?: Platform;
  /** The invite was accepted; `name` is the name-rule output. The page follows the pairing. */
  readonly onConnected?: (name: string) => void;
}

type Phase =
  | { readonly k: 'closed' }
  | { readonly k: 'form' }
  | { readonly k: 'checking' }
  | { readonly k: 'who'; readonly invite: CheckedInvite; readonly code: boolean }
  | { readonly k: 'refused'; readonly sentence: string };

export function PasteInvite({
  invites,
  passkey,
  gesture = passkeyProof,
  platform: givenPlatform,
  onConnected,
}: PasteInviteProps): ReactElement {
  const regionId = useId();
  const [platform] = useState<Platform>(() => givenPlatform ?? detectPlatform());
  const [phase, setPhase] = useState<Phase>({ k: 'closed' });
  const [text, setText] = useState('');
  // The link the check answered for: the one Accept sends (never another text typed since).
  const [link, setLink] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const open = phase.k !== 'closed';

  const restart = (): void => {
    setText('');
    setLink('');
    setMessage(undefined);
    setPhase({ k: 'form' });
  };

  const check = (event: FormEvent): void => {
    event.preventDefault();
    if (phase.k === 'checking') return;
    const found = inviteLinkOf(text.trim());
    if (found === undefined) {
      setMessage(P.notLink);
      return;
    }
    setMessage(undefined);
    setPhase({ k: 'checking' });
    void invites.check(found).then((outcome) => {
      if (outcome.kind === 'ok') {
        setLink(found);
        setPhase({ k: 'who', invite: outcome.invite, code: false });
        return;
      }
      if (outcome.kind === 'refused') {
        setPhase({ k: 'refused', sentence: REFUSED[outcome.why] });
        return;
      }
      setPhase({ k: 'form' });
      setMessage(
        outcome.kind === 'try_again'
          ? P.busy
          : outcome.kind === 'not_set_up'
            ? S.notSetUp
            : outcome.kind === 'session_expired'
              ? S.sessionExpired
              : P.offline,
      );
    });
  };

  const send = (invite: CheckedInvite, proof: PresenceProof): void => {
    if (busy) return;
    const shown = formatContactName({ name: invite.name, fingerprint: invite.fingerprint }).text;
    setBusy(true);
    setMessage(undefined);
    void invites.accept(link, proof).then((outcome) => {
      setBusy(false);
      if (outcome.kind === 'pending') {
        // The pasted text goes once the invite is used.
        setText('');
        setLink('');
        setPhase({ k: 'closed' });
        onConnected?.(shown);
        return;
      }
      if (outcome.kind === 'presence_rejected') return setMessage(C.presenceRejected);
      if (outcome.kind === 'presence_required') return setMessage(C.presenceRequired);
      if (outcome.kind === 'wait') return setMessage(waitSeconds(outcome.seconds));
      if (outcome.kind === 'busy') return setMessage(C.busy);
      if (outcome.kind === 'try_again') return setMessage(P.busy);
      if (outcome.kind === 'refused') {
        setPhase({ k: 'refused', sentence: REFUSED[outcome.why] });
        return;
      }
      setPhase({ k: 'form' });
      setMessage(
        outcome.kind === 'offline'
          ? P.offline
          : outcome.kind === 'session_expired'
            ? S.sessionExpired
            : outcome.kind === 'not_set_up'
              ? S.notSetUp
              : outcome.kind === 'not_applied'
                ? C.notApplied
                : P.notConnected,
      );
    });
  };

  const accept = (invite: CheckedInvite): void => {
    if (busy) return;
    setMessage(undefined);
    if (passkey === undefined) {
      setPhase({ k: 'who', invite, code: true });
      return;
    }
    void gesture(passkey).then((proof) => {
      // Touch ID cancelled: the card stays and nothing is sent.
      if (proof === undefined) setMessage(J.notAccepted);
      else send(invite, proof);
    });
  };

  let body: ReactElement | null = null;
  if (phase.k === 'form' || phase.k === 'checking') {
    body = (
      <form className="inv-paste-form al-reveal" onSubmit={check}>
        {/* A textarea: its value is never mirrored into an attribute. */}
        <TextArea
          label={P.label}
          hint={P.hint}
          name="invite-link"
          rows={3}
          autoComplete="off"
          spellCheck={false}
          value={text}
          readOnly={phase.k === 'checking'}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <div className="inv-paste-actions">
          <Button
            type="submit"
            variant="secondary"
            className="al-press"
            disabled={text.trim() === '' || phase.k === 'checking'}
          >
            {P.go}
          </Button>
        </div>
        {phase.k === 'checking' ? <ProgressBar label={P.checking} indeterminate /> : null}
        {message === undefined ? null : <InlineError>{message}</InlineError>}
      </form>
    );
  } else if (phase.k === 'refused') {
    body = (
      <div className="inv-paste-form al-reveal">
        <InlineError>{phase.sentence}</InlineError>
        <p className="al-text-body-sm al-muted inv-paste-note">{P.askForNew}</p>
        <div className="inv-paste-actions">
          <Button variant="ghost" onClick={restart}>
            {P.another}
          </Button>
        </div>
      </div>
    );
  } else if (phase.k === 'who') {
    const { invite } = phase;
    const shown = formatContactName({ name: invite.name, fingerprint: invite.fingerprint }).text;
    const until = DAY.format(new Date(invite.expiresAt));
    body = (
      <div className="inv-friend-card al-reveal">
        <div className="inv-friend-who">
          <span className="inv-avatar inv-avatar--them" aria-hidden="true">
            {letterOf(shown)}
          </span>
          <span className="inv-badge al-text-caption">{S.nameBySender}</span>
        </div>
        <h2 className="inv-friend-title">{invitesYou(shown)}</h2>
        <p className="al-text-body-sm al-muted inv-paste-note">{S.acceptBody(shown)}</p>
        <p className="al-text-body-sm al-muted inv-paste-note">
          {J.check(shown, invite.fingerprint)} · {J.until(until)}
        </p>
        {phase.code ? (
          <PresencePrompt
            summary={J.statement(shown, invite.fingerprint, P.thisAgent)}
            passkey={undefined}
            busy={busy}
            error={message}
            onSubmit={(proof) => send(invite, proof)}
            onCancel={() => setPhase({ k: 'who', invite, code: false })}
          />
        ) : (
          <>
            <Button
              variant="primary"
              size="lg"
              block
              className="al-press"
              disabled={busy}
              onClick={() => accept(invite)}
            >
              <span className="inv-btn-in">
                {passkey === undefined ? null : <FingerprintIcon />}
                {passkey === undefined ? J.acceptWithCode : J.acceptWith(platform)}
              </span>
            </Button>
            {busy ? <ProgressBar label={P.connecting(shown)} indeterminate /> : null}
            {message === undefined ? null : <InlineError>{message}</InlineError>}
            <Button variant="ghost" disabled={busy} onClick={restart}>
              {S.notNow}
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="inv-paste">
      <button
        type="button"
        className="inv-link-button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => (open ? setPhase({ k: 'closed' }) : restart())}
      >
        {P.open}
      </button>
      <div id={regionId}>{body}</div>
    </div>
  );
}
