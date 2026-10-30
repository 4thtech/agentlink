// UX2-d2: the Add contact sheet (b11 §21; owner decisions 1.1 and 2.1; 11 §5, §6.1, §9; I-5).
//
// A level-3 side sheet from the right (a full page at 600 px and under), a labelled region, not a
// modal: the page behind stays visible and usable. Two tabs:
// - Invite someone: an optional name, Create invite (no presence: the invite route kind), then the
//   ready text in a well with three ways out, Copy invite, Share… (only where the browser has a share
//   sheet that takes text) and Show QR code. The invite exists only here: as text content of the
//   well and as the QR code's drawing. No element attribute holds it (no data-*, title or
//   aria-label), and it is never put in the address, the title, a toast, a log or an error. No email
//   button and no mailto (decision 2.1).
// - I have an invite: paste, Check invite (no presence; nothing stored), then "Is this who you
//   expected?" with the inviter's name under the name rule, its label and the short owner
//   fingerprint. Only Connect asks for presence, and the server signs one approval (decision 1.1).
//   The inviter's fields are untrusted (I-5): React text only.
import {
  Button,
  ContactName,
  Fingerprint,
  Icon,
  InlineError,
  ProgressBar,
  Segmented,
  Switch,
  TextArea,
  TextField,
  formatContactName,
  useReducedMotion,
} from '@4thtech-io/ui';
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { QrCode } from '../proofs/qr.js';
import {
  ADD_STRINGS as A,
  SAFETY_ADVICE,
  connectSummary,
  inviteReady,
  qrLabel,
  safetyLead,
  worksUntil,
} from './add-strings.js';
import type { CheckedInvite, CreatedInvite, InviteApi, InviteRefusal } from './invite-api.js';
import type { PasskeyInfo, PresenceProof } from './owner.js';
import { PresencePrompt } from './presence-prompt.js';
import { CONTACTS_STRINGS as S, waitSeconds } from './strings.js';

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const COPIED_MS = 1600;

type Tab = 'invite' | 'paste';

const REFUSED: Readonly<Record<InviteRefusal, string>> = {
  expired: A.inviteExpired,
  own: A.ownInvite,
  damaged: A.inviteDamaged,
  cant_use: A.cantUse,
  unavailable: A.unavailableInvite,
};

/** True when the browser has a share sheet that takes this text (b11 §21.3: hidden otherwise). */
function canShareText(text: string): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false;
  if (typeof navigator.canShare !== 'function') return true;
  try {
    return navigator.canShare({ text });
  } catch {
    return false;
  }
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Error).name === 'AbortError';
}

// --- Invite someone -----------------------------------------------------------------------------

function InviteSomeone({
  invites,
  nameId,
  onCreated,
  onSent,
  onDone,
  onAnnounce,
}: {
  invites: InviteApi;
  nameId: string;
  onCreated: (name: string | undefined, invite: CreatedInvite) => void;
  onSent: () => void;
  onDone: () => void;
  onAnnounce: (text: string) => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [long, setLong] = useState(false);
  const [phase, setPhase] = useState<'form' | 'creating' | 'ready'>('form');
  const [error, setError] = useState<string | undefined>(undefined);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [invite, setInvite] = useState<CreatedInvite | undefined>(undefined);
  const [shownName, setShownName] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [shareError, setShareError] = useState(false);
  const [qr, setQr] = useState(false);

  useEffect(() => {
    if (copied !== 'copied') return undefined;
    const t = setTimeout(() => setCopied('idle'), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const create = (event?: FormEvent): void => {
    event?.preventDefault();
    if (phase === 'creating') return;
    const wanted = name.trim();
    setError(undefined);
    setNameError(undefined);
    setPhase('creating');
    void invites
      .create(wanted === '' ? undefined : wanted, long ? { long: true } : undefined)
      .then((outcome) => {
        if (outcome.kind === 'ok') {
          const who = wanted === '' ? undefined : wanted;
          setInvite(outcome.invite);
          setShownName(who);
          setPhase('ready');
          onCreated(who, outcome.invite);
          onAnnounce(A.inviteReadyPlain);
          return;
        }
        setPhase('form');
        if (outcome.kind === 'invalid_name') {
          setNameError(A.nameInvalid);
          return;
        }
        const sentence =
          outcome.kind === 'not_set_up'
            ? A.notSetUp
            : outcome.kind === 'session_expired'
              ? A.sessionExpired
              : A.cantCreate;
        setError(sentence);
      });
  };

  if (phase !== 'ready' || invite === undefined) {
    return (
      <form className="ct-add-form" onSubmit={create}>
        <TextField
          id={nameId}
          label={A.whoFor}
          hint={A.whoForHint}
          name="invite-name"
          autoComplete="off"
          maxLength={32}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          {...(nameError === undefined ? {} : { error: nameError })}
        />
        <details className="ct-advanced">
          <summary className="al-text-body-sm">{A.advanced}</summary>
          <Switch
            label={A.longLink}
            description={A.longLinkHint}
            checked={long}
            onChange={setLong}
          />
        </details>
        <Button type="submit" variant="primary" disabled={phase === 'creating'}>
          {phase === 'creating' ? A.creating : A.createInvite}
        </Button>
        {error === undefined ? null : (
          <InlineError
            action={
              <Button size="sm" onClick={() => create()}>
                {A.tryAgain}
              </Button>
            }
          >
            {error}
          </InlineError>
        )}
      </form>
    );
  }

  const share = canShareText(invite.shareText);
  const copy = (): void => {
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clip === undefined) {
      setCopied('failed');
      return;
    }
    void clip.writeText(invite.shareText).then(
      () => {
        setCopied('copied');
        onSent();
        onAnnounce(A.inviteCopied);
      },
      () => setCopied('failed'),
    );
  };
  const shareNow = (): void => {
    setShareError(false);
    void navigator.share({ title: A.shareTitle, text: invite.shareText }).then(
      () => onSent(),
      (error: unknown) => {
        // Closing the share sheet is not an error: nothing happens.
        if (!isAbort(error)) setShareError(true);
      },
    );
  };

  return (
    <div className="ct-add-ready">
      <h3 className="al-text-title-3">{inviteReady(shownName)}</h3>
      <p className="ct-invite-well al-text-body-sm">{invite.shareText}</p>
      <p className="al-text-body-sm al-muted">
        {worksUntil(DAY.format(new Date(invite.expiresAt)))}
      </p>
      <p className="ct-safety al-text-body-sm">
        <Icon name="info" size={16} />
        <span>
          <strong>{safetyLead(shownName)}</strong> {SAFETY_ADVICE}
        </span>
      </p>
      <div className="ct-invite-ways">
        <Button variant="primary" icon={copied === 'copied' ? 'check' : 'copy'} onClick={copy}>
          {copied === 'copied' ? A.copied : A.copyInvite}
        </Button>
        {share ? <Button onClick={shareNow}>{A.share}</Button> : null}
        <Button
          aria-expanded={qr}
          onClick={() => {
            setQr((on) => !on);
            onSent();
          }}
        >
          {qr ? A.hideQr : A.showQr}
        </Button>
      </div>
      {copied === 'failed' ? (
        <p className="al-text-body-sm" role="alert">
          {A.copyFailed}
        </p>
      ) : null}
      {shareError ? (
        <p className="al-text-body-sm" role="alert">
          {A.shareFailed}
        </p>
      ) : null}
      {qr ? (
        <figure className="ct-qr">
          <QrCode value={invite.inviteUrl} label={qrLabel(shownName)} className="ct-qr-code" />
          <figcaption className="al-text-caption al-muted">{A.qrCaption}</figcaption>
        </figure>
      ) : null}
      <Button variant="ghost" onClick={onDone}>
        {A.done}
      </Button>
    </div>
  );
}

// --- I have an invite ---------------------------------------------------------------------------

type PastePhase =
  | { readonly kind: 'paste' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'who'; readonly invite: CheckedInvite }
  | { readonly kind: 'presence'; readonly invite: CheckedInvite }
  | { readonly kind: 'refused'; readonly sentence: string };

function HaveInvite({
  invites,
  passkey,
  onConnected,
}: {
  invites: InviteApi;
  passkey: PasskeyInfo | undefined;
  onConnected: (name: string) => void;
}): ReactElement {
  const fieldId = useId();
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<PastePhase>({ kind: 'paste' });
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [promptError, setPromptError] = useState<string | undefined>(undefined);

  const link = text.trim();
  const check = (event: FormEvent): void => {
    event.preventDefault();
    if (link === '' || phase.kind === 'checking') return;
    setMessage(undefined);
    setPhase({ kind: 'checking' });
    void invites.check(link).then((outcome) => {
      if (outcome.kind === 'ok') {
        setPhase({ kind: 'who', invite: outcome.invite });
        return;
      }
      if (outcome.kind === 'refused') {
        setPhase({ kind: 'refused', sentence: REFUSED[outcome.why] });
        return;
      }
      setPhase({ kind: 'paste' });
      setMessage(
        outcome.kind === 'try_again'
          ? A.busyTryAgain
          : outcome.kind === 'offline'
            ? A.offline
            : outcome.kind === 'not_set_up'
              ? A.notSetUp
              : outcome.kind === 'session_expired'
                ? A.sessionExpired
                : A.offline,
      );
    });
  };

  const accept = (proof: PresenceProof): void => {
    if (phase.kind !== 'presence' || busy) return;
    const shown = formatContactName({
      name: phase.invite.name,
      fingerprint: phase.invite.fingerprint,
    }).text;
    setBusy(true);
    setPromptError(undefined);
    void invites.accept(link, proof).then((outcome) => {
      setBusy(false);
      if (outcome.kind === 'pending') {
        // The pasted text is cleared once the invite is used (b11 §21.4).
        setText('');
        onConnected(shown);
        return;
      }
      if (outcome.kind === 'presence_rejected') return setPromptError(S.presenceRejected);
      if (outcome.kind === 'presence_required') return setPromptError(S.presenceRequired);
      if (outcome.kind === 'wait') return setPromptError(waitSeconds(outcome.seconds));
      if (outcome.kind === 'busy') return setPromptError(S.busy);
      if (outcome.kind === 'try_again') return setPromptError(A.busyTryAgain);
      if (outcome.kind === 'refused') {
        setPhase({ kind: 'refused', sentence: REFUSED[outcome.why] });
        return;
      }
      setPhase({ kind: 'paste' });
      setMessage(
        outcome.kind === 'offline'
          ? A.offline
          : outcome.kind === 'session_expired'
            ? A.sessionExpired
            : outcome.kind === 'not_set_up'
              ? A.notSetUp
              : outcome.kind === 'not_applied'
                ? S.notApplied
                : A.connectRefused,
      );
    });
  };

  if (phase.kind === 'who' || phase.kind === 'presence') {
    const { invite } = phase;
    const shown = formatContactName({ name: invite.name, fingerprint: invite.fingerprint }).text;
    return (
      <div className="ct-add-who">
        <p className="al-text-title-3">
          <ContactName name={invite.name} fingerprint={invite.fingerprint} label="selfdeclared" />
        </p>
        <p className="al-text-body-sm">
          <Fingerprint value={invite.fingerprint} />
        </p>
        <p className="al-text-body-sm al-muted">
          {worksUntil(DAY.format(new Date(invite.expiresAt)))}
        </p>
        <p className="al-text-body">
          <strong>{A.isThisWho}</strong>
        </p>
        {phase.kind === 'who' ? (
          <div className="ct-actions">
            <Button
              variant="primary"
              icon="approval"
              onClick={() => {
                setPromptError(undefined);
                setPhase({ kind: 'presence', invite });
              }}
            >
              {A.connect}
            </Button>
            <Button variant="ghost" onClick={() => setPhase({ kind: 'paste' })}>
              {A.cancel}
            </Button>
          </div>
        ) : (
          <PresencePrompt
            summary={connectSummary(shown)}
            passkey={passkey}
            busy={busy}
            error={promptError}
            onSubmit={accept}
            onCancel={() => setPhase({ kind: 'who', invite })}
          />
        )}
      </div>
    );
  }

  if (phase.kind === 'refused') {
    return (
      <div className="ct-add-refused" role="alert">
        <p className="al-text-body">
          <strong>{phase.sentence}</strong>
        </p>
        <p className="al-text-body-sm al-muted">{A.askForNew}</p>
        <Button
          variant="ghost"
          onClick={() => {
            setText('');
            setPhase({ kind: 'paste' });
          }}
        >
          {A.cancel}
        </Button>
      </div>
    );
  }

  return (
    <form className="ct-add-form" onSubmit={check}>
      {/* A textarea: its value is never mirrored into an attribute (b11 §21.5). */}
      <TextArea
        id={fieldId}
        label={A.pasteLabel}
        hint={A.pasteHint}
        name="invite-link"
        rows={3}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      <Button type="submit" variant="primary" disabled={link === '' || phase.kind === 'checking'}>
        {A.checkInvite}
      </Button>
      {phase.kind === 'checking' ? <ProgressBar label={A.checking} indeterminate /> : null}
      {message === undefined ? null : <InlineError>{message}</InlineError>}
    </form>
  );
}

// --- The sheet ----------------------------------------------------------------------------------

export interface AddContactSheetProps {
  readonly invites: InviteApi;
  readonly passkey: PasskeyInfo | undefined;
  /** An invite was created: the page adds its pending row (name and expiry only). */
  readonly onCreated: (name: string | undefined, expiresAt: number) => void;
  /** An invite was accepted: the page reloads the list. `name` is the name-rule output. */
  readonly onConnected: (name: string) => void;
  readonly onClose: () => void;
}

export function AddContactSheet({
  invites,
  passkey,
  onCreated,
  onConnected,
  onClose,
}: AddContactSheetProps): ReactElement {
  const reduced = useReducedMotion();
  const prefix = useId();
  const panelId = `${prefix}-panel`;
  const nameId = `${prefix}-name`;
  const [tab, setTab] = useState<Tab>('invite');
  const [created, setCreated] = useState(false);
  const [sent, setSent] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [announce, setAnnounce] = useState('');
  const keepOpenId = `${prefix}-keep`;

  // Focus moves to the first field on open (b11 §21.6).
  useEffect(() => {
    document.getElementById(nameId)?.focus();
  }, [nameId]);
  useEffect(() => {
    if (confirmClose) document.getElementById(keepOpenId)?.focus();
  }, [confirmClose, keepOpenId]);

  const requestClose = (): void => {
    // An invite that was not sent yet: ask first, in place (b11 §21.3, Closing).
    if (created && !sent) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    requestClose();
  };

  // Rendered at the end of the body: the page area is its own stacking context (its view
  // transition), and the sheet must sit above the sidebar and the 360 px bottom bar.
  return createPortal(
    <section
      className="al-surface al-surface--l3 al-sheet ct-add-sheet"
      data-level="3"
      data-motion={reduced ? 'reduced' : 'full'}
      role="region"
      aria-label={A.addContact}
      onKeyDown={onKeyDown}
    >
      <header className="al-sheet-head">
        <button type="button" className="al-sheet-close ct-add-back" onClick={requestClose}>
          <span aria-hidden="true">←</span>
          <span className="al-sr-only">{A.back}</span>
        </button>
        <h2 className="al-sheet-title al-text-title-3">{A.addContact}</h2>
        <button
          type="button"
          className="al-sheet-close ct-add-x"
          aria-label={A.close}
          onClick={requestClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="al-sheet-body ct-add-body">
        {confirmClose ? (
          <div className="ct-confirm" role="alert">
            <p className="al-text-body">{A.notSentYet}</p>
            <div className="ct-actions">
              <Button variant="danger" onClick={onClose}>
                {A.closeAnyway}
              </Button>
              <Button id={keepOpenId} variant="ghost" onClick={() => setConfirmClose(false)}>
                {A.keepOpen}
              </Button>
            </div>
          </div>
        ) : null}
        <Segmented
          label={A.tabsLabel}
          variant="tabs"
          idPrefix={prefix}
          panelId={panelId}
          value={tab}
          onChange={(v) => setTab(v === 'paste' ? 'paste' : 'invite')}
          options={[
            { value: 'invite', label: A.inviteSomeone },
            { value: 'paste', label: A.haveInvite },
          ]}
        />
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={`${prefix}-tab-${tab}`}
          className="ct-add-panel"
          hidden={confirmClose}
        >
          {/* Both stay mounted, so switching tabs never loses a created invite or a pasted one. */}
          <div hidden={tab !== 'invite'}>
            <InviteSomeone
              invites={invites}
              nameId={nameId}
              onCreated={(name, invite) => {
                setCreated(true);
                onCreated(name, invite.expiresAt);
              }}
              onSent={() => setSent(true)}
              onDone={requestClose}
              onAnnounce={setAnnounce}
            />
          </div>
          <div hidden={tab !== 'paste'}>
            <HaveInvite invites={invites} passkey={passkey} onConnected={onConnected} />
          </div>
        </div>
        <p className="al-sr-only" role="status" aria-live="polite">
          {announce}
        </p>
      </div>
    </section>,
    document.body,
  );
}
