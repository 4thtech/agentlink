// U3-invite: "Accept {name}'s invite?" (b11 §33.2; 08 §4 "One step from an invite link"; 04 §3.6,
// §3.6.1; I-4, I-5, I-7). Shown in the first-run shell (a focused column) at /settings/join: after
// first run v3, or at once when AgentLink is already set up and `agentlink join` handed an invite to
// the app.
//
// - Everything about the inviter comes from `GET /api/ui/join`: the name-rule name, Self-declared,
//   the short owner fingerprint and the expiry, rendered as React text. Never the link: the page
//   does not have it, and nothing about the invite goes into the address bar, the title or a toast.
// - "Accept with Touch ID": the owner statement names the inviter and the agent; the passkey (or the
//   backup code) is the presence proof of one `POST /api/ui/join/accept {inviteId}`, bound to the ID
//   this screen shows (another one is `invite_changed`, and nothing is signed). The server signs.
// - "Not now" forgets the invite (`POST /api/ui/join/dismiss`) and goes to Home.
// - After accepting: "Waiting for {name}'s agent to answer." (the 10-minute line after 10 minutes),
//   then "Connected with {name}." and the safety-code step on Contacts. The safety code does not
//   exist before the handshake-ack (04 §3.6.1), so it is never shown here before that.
// W4-PEOPLE-INVITE (prototype v23 A6, A7): the card is the friend's screen, "{name} invites you to
// connect your AIs" with one Accept with Touch ID; "Not now" says nothing was shared and the link
// still works; once connected, the Connected moment shows the safety code for the new contact
// (found in this app's contacts by the inviter's fingerprint), and Done goes Home.
import { Button, ProgressBar } from '@4thtech-io/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { ConnectedMoment } from '../invite/connected.js';
import { FingerprintIcon } from '../invite/icons.js';
import { INVITE_STRINGS as I, invitesYou, letterOf } from '../invite/strings.js';
import {
  createOwnerClient,
  passkeyProof,
  type PasskeyInfo,
  type PresenceProof,
} from '../contacts/owner.js';
import { PresencePrompt } from '../contacts/presence-prompt.js';
import { detectPlatform } from '../first-run/passkey.js';
import type { Platform } from '../first-run/strings.js';
import { createJoinApi, type JoinApi, type JoinInvite, type JoinState } from './api.js';
import { JOIN_STRINGS as S } from './strings.js';
import './join.css';

const HOME = '/';
const CONTACTS = '/contacts';
/** How often the screen reads again while it follows the pairing. */
const POLL_MS = 3_000;
/** b11 §33.2: the extra line after 10 minutes with no answer. */
export const TEN_MINUTES_MS = 10 * 60_000;

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export interface JoinPageProps {
  readonly api?: JoinApi;
  /** The stored passkey, when this browser can use one. Default: the owner client's. */
  readonly passkey?: () => Promise<PasskeyInfo | undefined>;
  /** The passkey gesture. Default: passkeyProof. */
  readonly gesture?: (info: PasskeyInfo) => Promise<PresenceProof | undefined>;
  readonly platform?: Platform;
  /** Leaves the screen (Home or Contacts), with a full load. */
  readonly go?: (path: string) => void;
  readonly now?: () => number;
  readonly pollMs?: number;
  /** This app's contacts route, for the new contact's safety code. Default: the page's own client. */
  readonly contacts?: ApiClient;
}

function goTo(path: string): void {
  window.location.assign(path);
}

type View =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'read';
      readonly state: JoinState;
      readonly invite?: JoinInvite;
      readonly agent?: string;
      readonly contactRef?: string;
    }
  | { readonly kind: 'offline' };

export function JoinPage({
  api: given,
  passkey: readPasskey,
  gesture = passkeyProof,
  platform: givenPlatform,
  go = goTo,
  now = () => Date.now(),
  pollMs = POLL_MS,
  contacts: givenContacts,
}: JoinPageProps): ReactElement {
  const [contacts] = useState<ApiClient>(() => givenContacts ?? createApiClient());
  const [declined, setDeclined] = useState(false);
  const [api] = useState<JoinApi>(() => given ?? createJoinApi());
  const [platform] = useState<Platform>(() => givenPlatform ?? detectPlatform());
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [passkey, setPasskey] = useState<PasskeyInfo | undefined>(undefined);
  const [askCode, setAskCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [waitingSince, setWaitingSince] = useState<number | undefined>(undefined);
  const [, tick] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);

  const read = useCallback(async (): Promise<void> => {
    const answer = await api.read();
    if (answer.kind === 'ok') {
      setView({
        kind: 'read',
        state: answer.state,
        ...(answer.invite === undefined ? {} : { invite: answer.invite }),
        ...(answer.agent === undefined ? {} : { agent: answer.agent }),
        ...(answer.contactRef === undefined ? {} : { contactRef: answer.contactRef }),
      });
    } else {
      setView({ kind: 'offline' });
    }
  }, [api]);

  useEffect(() => {
    void read();
    const owner = readPasskey ?? (() => createOwnerClient().passkey());
    void owner().then(setPasskey, () => setPasskey(undefined));
  }, [read, readPasskey]);

  const state = view.kind === 'read' ? view.state : undefined;
  // Follow the pairing while it runs; nothing else polls.
  useEffect(() => {
    if (state !== 'waiting_for_them' && state !== 'connecting') return undefined;
    if (state === 'waiting_for_them' && waitingSince === undefined) setWaitingSince(now());
    const timer = setInterval(() => {
      void read();
      tick((n) => n + 1);
    }, pollMs);
    return () => clearInterval(timer);
  }, [state, waitingSince, read, now, pollMs]);

  // Focus moves to the title (b11 §33.2).
  useEffect(() => {
    title.current?.focus();
  }, [state]);

  const invite = view.kind === 'read' ? view.invite : undefined;
  const agent = view.kind === 'read' ? (view.agent ?? '') : '';

  const send = (proof: PresenceProof): void => {
    if (invite === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    void api.accept(invite.inviteId, proof).then(async (outcome) => {
      setBusy(false);
      if (outcome.kind === 'pending') {
        setAskCode(false);
        await read();
        return;
      }
      if (outcome.kind === 'invite_changed') {
        setError(S.changed);
        await read();
        return;
      }
      if (outcome.kind === 'agent_changed') {
        window.location.reload();
        return;
      }
      if (outcome.kind === 'expired') {
        await read();
        return;
      }
      if (outcome.kind === 'policy_denied') return setError(S.rulesDeny);
      if (outcome.kind === 'offline') return setError(S.offline);
      setError(S.notAccepted);
    });
  };

  const accept = (): void => {
    if (invite === undefined || busy) return;
    setError(undefined);
    if (passkey === undefined) {
      setAskCode(true);
      return;
    }
    void gesture(passkey).then((proof) => {
      // Touch ID cancelled: the card stays.
      if (proof === undefined) setError(S.notAccepted);
      else send(proof);
    });
  };

  // "Not now" forgets the invite on this computer; the link itself keeps working until it expires.
  const notNow = (): void => {
    void api.dismiss().then(() => setDeclined(true));
  };

  // Connected: the server names the new contact (IR SEC-1 L3), so the code is that contact's.
  const contactRef = view.kind === 'read' ? view.contactRef : undefined;

  if (view.kind === 'loading') {
    return (
      <section className="jn-card" aria-busy="true">
        <ProgressBar label={S.regionLabel} indeterminate />
      </section>
    );
  }
  if (view.kind === 'offline') {
    return (
      <section className="jn-card">
        <p className="al-text-body" role="alert">
          {S.offline}
        </p>
        <Button variant="secondary" onClick={() => go(HOME)}>
          {S.goHome}
        </Button>
      </section>
    );
  }

  const name = invite?.name ?? '';
  const fingerprint = invite?.fingerprint ?? '';

  /** A state that cannot be used: one sentence and Go to Home (b11 §33.2 "Can't use it"). */
  const cannot = (sentence: string, extra?: ReactElement): ReactElement => (
    <section className="jn-card">
      <h1 className="al-text-title-2" tabIndex={-1} ref={title}>
        {sentence}
      </h1>
      <div className="jn-actions">
        {extra}
        <Button variant="secondary" onClick={() => void api.dismiss().then(() => go(HOME))}>
          {S.goHome}
        </Button>
      </div>
    </section>
  );

  if (view.state === 'none' || invite === undefined) {
    return cannot(S.none);
  }
  if (view.state === 'expired') return cannot(S.expired(name));
  if (view.state === 'own') return cannot(S.own);
  if (view.state === 'already_accepted') {
    return cannot(
      S.alreadyAccepted,
      <Button variant="primary" onClick={() => go(CONTACTS)}>
        {S.open(name)}
      </Button>,
    );
  }
  if (view.state === 'connected') {
    return (
      <section className="jn-moment">
        <p className="jn-live" role="status" aria-live="polite">
          {S.connected(name)}
        </p>
        <ConnectedMoment
          name={name}
          me={agent}
          api={contacts}
          {...(contactRef === undefined ? {} : { contactRef })}
          onDone={() => void api.dismiss().then(() => go(HOME))}
        />
      </section>
    );
  }
  if (view.state === 'waiting_for_them' || view.state === 'connecting') {
    const late =
      view.state === 'waiting_for_them' &&
      waitingSince !== undefined &&
      now() - waitingSince >= TEN_MINUTES_MS;
    return (
      <section className="jn-card">
        <h1 className="al-text-title-2" tabIndex={-1} ref={title}>
          {view.state === 'connecting' ? S.connecting(name) : S.waitingForThem(name)}
        </h1>
        <ProgressBar label={S.connecting(name)} indeterminate />
        {late ? <p className="al-text-body-sm al-muted">{S.tenMinutes(name)}</p> : null}
        <div className="jn-actions">
          <Button variant="secondary" onClick={() => go(HOME)}>
            {S.goHome}
          </Button>
        </div>
      </section>
    );
  }

  // Waiting for the owner: the friend's card (A6).
  const until = DAY.format(new Date(invite.expiresAt));
  return (
    <section className="jn-card jn-friend al-reveal">
      <div className="jn-who-row">
        <span className="jn-letter" aria-hidden="true">
          {letterOf(name)}
        </span>
        <span className="jn-badge al-text-caption">{I.nameBySender}</span>
      </div>
      <div className="jn-head">
        <h1 className="jn-title" tabIndex={-1} ref={title}>
          {invitesYou(name)}
        </h1>
        <p className="jn-lead al-muted">{I.acceptBody(name)}</p>
      </div>
      <p className="al-text-body-sm al-muted jn-check" aria-label={S.regionLabel}>
        {S.check(name, fingerprint)} · {S.until(until)}
        {agent === '' ? null : (
          <>
            {' · '}
            {S.forAgent(agent)}
          </>
        )}
      </p>
      {askCode ? (
        <PresencePrompt
          summary={S.statement(name, fingerprint, agent === '' ? 'this agent' : agent)}
          passkey={undefined}
          busy={busy}
          error={error}
          onSubmit={send}
          onCancel={() => setAskCode(false)}
        />
      ) : (
        <div className="jn-accept">
          {/* IR-1 low (c): what Touch ID signs, shown before the gesture (04 §3.6 Accept step 2). */}
          <p className="al-text-body-sm jn-statement">
            {S.statement(name, fingerprint, agent === '' ? 'this agent' : agent)}
          </p>
          <Button
            variant="primary"
            size="lg"
            block
            className="jn-primary al-press"
            onClick={accept}
            disabled={busy || declined}
          >
            <span className="inv-btn-in">
              {passkey === undefined ? null : <FingerprintIcon />}
              {passkey === undefined ? S.acceptWithCode : S.acceptWith(platform)}
            </span>
          </Button>
          {busy ? <ProgressBar label={S.connecting(name)} indeterminate /> : null}
          {error === undefined ? null : (
            <p className="al-text-body-sm jn-error" role="alert">
              {error}
            </p>
          )}
          {declined ? (
            <>
              <p className="jn-declined al-reveal" role="status">
                {I.declined(until)}
              </p>
              <Button variant="ghost" onClick={() => go(HOME)}>
                {S.goHome}
              </Button>
            </>
          ) : (
            <button type="button" className="jn-not-now" onClick={notNow} disabled={busy}>
              {S.notNow}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
