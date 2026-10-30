// W4-PEOPLE-INVITE: the invite panel (prototype v23 A3 and A5; D-139 short invites; 11 §5; I-7).
// Get started step 4 and the Invite screen both use it.
//
// - The link is made at once (a short link on the encrypted drop; the server falls back to a long
//   one when the drop is down, and the panel says so in plain words). It exists only as the text of
//   the link box and, Under the hood, as the QR code's drawing: never in an attribute, the title,
//   the address, a log or an error. Everything goes to this same-origin server only.
// - The optional name is only for your list (the invite's local label). A name added before the
//   link went anywhere makes a fresh link with that name and cancels the unnamed one; once the link
//   was copied, emailed, shared or shown as a QR code, the name is fixed.
// - A link that never left the screen is cancelled when the panel goes, so a visit leaves no
//   pending row behind.
// - Copy (✓ moment), Email (the mail app, with our share text), Share (only where the browser has a
//   share sheet for text).
// - Under the hood: the invite's facts, a long link instead (D-139 fallback, nothing stored on the
//   service) and the QR code.
import { Button, InlineError, SkeletonLine, useHood } from '@4thtech-io/ui';
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { createInviteApi, type CreatedInvite, type InviteApi } from '../contacts/invite-api.js';
import { QrCode } from '../proofs/qr.js';
import { CheckMark, CopyMark, MailIcon, ShareIcon } from './icons.js';
import { INVITE_STRINGS as S, linkLabel, mailtoOf, worksFor } from './strings.js';
import './invite.css';

const DAY_MS = 86_400_000;
const COPIED_MS = 1600;
const MAX_NAME = 32;

export interface InvitePanelProps {
  /** For tests; the page's own same-origin clients by default. */
  readonly invites?: InviteApi;
  /** Opens the mail app with a `mailto:` address. Default: the browser's location. */
  readonly openMail?: (url: string) => void;
  /** A link was made (the pending list can read again). */
  readonly onCreated?: () => void;
  readonly now?: () => number;
}

interface Made {
  readonly invite: CreatedInvite;
  /** This invite's public ID, from its own create answer (never looked up in a list). */
  readonly id: string;
  /** The name the link was made for ('' for none). */
  readonly label: string;
  /** A long link was asked for (Under the hood), not a fallback. */
  readonly askedLong: boolean;
}

type Phase = 'making' | 'ready' | 'error';

/** True when the browser has a share sheet that takes this text. */
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

function defaultMail(url: string): void {
  window.location.assign(url);
}

/** RFC 3339 to the minute, UTC: the exact expiry Under the hood. */
const exact = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function InvitePanel({
  invites: givenInvites,
  openMail = defaultMail,
  onCreated,
  now = () => Date.now(),
}: InvitePanelProps): ReactElement {
  const [invites] = useState<InviteApi>(() => givenInvites ?? createInviteApi());
  const hood = useHood();
  const nameId = useId();
  const hintId = `${nameId}-hint`;
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('making');
  const [made, setMade] = useState<Made | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [shared, setShared] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [shareFailed, setShareFailed] = useState(false);
  const [qr, setQr] = useState(false);
  const [announce, setAnnounce] = useState('');

  // The latest values for the leave-time cancel and for stale answers.
  const madeRef = useRef<Made | undefined>(undefined);
  const sharedRef = useRef(false);
  const run = useRef(0);
  const live = useRef(true);
  madeRef.current = made;
  sharedRef.current = shared;

  const make = useCallback(
    async (label: string, long: boolean): Promise<void> => {
      const mine = (run.current += 1);
      const previous = madeRef.current;
      setPhase('making');
      setError(undefined);
      setNameError(undefined);
      const outcome = await invites.create(
        label === '' ? undefined : label,
        long ? { long } : undefined,
      );
      if (outcome.kind !== 'ok') {
        if (mine !== run.current || !live.current) return;
        if (outcome.kind === 'invalid_name') {
          setNameError(S.nameInvalid);
          setPhase(previous === undefined ? 'error' : 'ready');
          if (previous === undefined) setError(S.cantCreate);
          return;
        }
        setPhase(previous === undefined ? 'error' : 'ready');
        setError(
          outcome.kind === 'not_set_up'
            ? S.notSetUp
            : outcome.kind === 'session_expired'
              ? S.sessionExpired
              : S.cantCreate,
        );
        return;
      }
      // IR-W4-PEOPLE-INVITE-1 (M): the ID comes only from this create's own answer, so the panel can
      // never cancel another invite (one sent earlier, or one the AI app made meanwhile).
      const id = outcome.invite.inviteId;
      const next: Made = { invite: outcome.invite, id, label, askedLong: long };
      if (mine !== run.current || !live.current) {
        // A newer link (or leaving) won: this one never reached the screen.
        void invites.cancel(id);
        return;
      }
      madeRef.current = next;
      setMade(next);
      setPhase('ready');
      onCreated?.();
      // The one it replaces never left the screen: it goes.
      if (previous !== undefined && !sharedRef.current) void invites.cancel(previous.id);
    },
    [invites, onCreated],
  );

  useEffect(() => {
    live.current = true;
    void make('', false);
    return () => {
      live.current = false;
      const last = madeRef.current;
      // A link that never left the screen leaves no pending row behind.
      if (last !== undefined && !sharedRef.current) void invites.cancel(last.id);
    };
    // Made once per panel.
  }, []);

  useEffect(() => {
    if (copied !== 'copied') return undefined;
    const t = setTimeout(() => setCopied('idle'), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);

  // A name typed while the first link was still being made: apply it once the link is there, unless
  // the field still has focus (its blur commits it).
  useEffect(() => {
    if (phase !== 'ready' || made === undefined || sharedRef.current) return;
    const wanted = name.trim();
    if (wanted === made.label || document.activeElement?.id === nameId) return;
    void make(wanted, made.askedLong);
    // Only when a link arrives.
  }, [made]);

  const markShared = (): void => {
    sharedRef.current = true;
    setShared(true);
  };

  // IR-1 low (a): any copy whose selection holds the link counts as sent (the box, a triple-click,
  // a selection that spans the page), so leaving never cancels a link that went out.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onCopy = (): void => {
      const url = madeRef.current?.invite.inviteUrl;
      const selection = document.getSelection();
      if (url === undefined || selection === null || selection.rangeCount === 0) return;
      const box = boxRef.current;
      let inBox = false;
      for (let i = 0; i < selection.rangeCount && box !== null; i += 1) {
        const range = selection.getRangeAt(i);
        if (box.contains(range.commonAncestorContainer) || range.intersectsNode(box)) inBox = true;
      }
      if (inBox || selection.toString().includes(url.slice(-12))) {
        sharedRef.current = true;
        setShared(true);
      }
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, []);

  /** The name is committed (the field lost focus, or Enter): a fresh link while nothing went out. */
  const commitName = (): void => {
    const wanted = name.trim();
    if (shared || phase === 'making' || made === undefined) return;
    if (wanted === made.label) return;
    void make(wanted, made.askedLong);
  };

  const invite = made?.invite;
  const ready = phase === 'ready' && invite !== undefined;
  const fellBack = invite !== undefined && invite.format === 'long' && made?.askedLong !== true;
  const days =
    invite === undefined ? 7 : Math.max(1, Math.round((invite.expiresAt - now()) / DAY_MS));

  const copy = (): void => {
    if (invite === undefined) return;
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clip === undefined) {
      setCopied('failed');
      return;
    }
    void clip.writeText(invite.inviteUrl).then(
      () => {
        markShared();
        setCopied('copied');
        setAnnounce(S.copiedAnnounce);
      },
      () => setCopied('failed'),
    );
  };
  const email = (): void => {
    if (invite === undefined) return;
    markShared();
    openMail(mailtoOf(invite.shareText));
  };
  const share = (): void => {
    if (invite === undefined) return;
    setShareFailed(false);
    void navigator.share({ title: S.shareTitle, text: invite.shareText }).then(
      () => markShared(),
      (e: unknown) => {
        if (!isAbort(e)) setShareFailed(true);
      },
    );
  };

  const wanted = name.trim();
  return (
    <div className="inv-panel">
      <form
        className="inv-name"
        onSubmit={(e) => {
          e.preventDefault();
          commitName();
        }}
      >
        <label htmlFor={nameId} className="inv-name-label al-text-body">
          {S.whoFor} <span className="al-muted">{S.optional}</span>
        </label>
        <div className="al-input-wrap inv-input-wrap">
          <input
            id={nameId}
            type="text"
            className="al-input inv-input"
            name="invite-name"
            autoComplete="off"
            placeholder={S.placeholder}
            maxLength={MAX_NAME}
            value={name}
            readOnly={shared}
            aria-describedby={hintId}
            aria-invalid={nameError === undefined ? undefined : 'true'}
            onChange={(e) => setName(e.currentTarget.value)}
            onBlur={commitName}
          />
        </div>
        <span id={hintId} className="al-text-caption al-muted">
          {nameError ?? S.whoForHint}
        </span>
      </form>

      <section className="inv-card al-reveal" aria-label={linkLabel(wanted)}>
        <span className="inv-eyebrow">{linkLabel(wanted)}</span>
        <div className="inv-row">
          <div
            ref={boxRef}
            className="inv-link"
            data-state={ready ? 'ready' : 'making'}
            aria-busy={ready ? undefined : 'true'}
          >
            {invite !== undefined && phase !== 'making' ? (
              invite.inviteUrl
            ) : phase === 'error' ? null : (
              <>
                <SkeletonLine width={70} />
                <span className="al-visually-hidden">{S.making}</span>
              </>
            )}
          </div>
          <Button variant="primary" className="inv-copy al-press" disabled={!ready} onClick={copy}>
            <span className="inv-btn-in">
              {copied === 'copied' ? <CheckMark /> : <CopyMark />}
              {copied === 'copied' ? S.copied : S.copy}
            </span>
          </Button>
        </div>
        <div className="inv-ways">
          <Button className="al-press" disabled={!ready} onClick={email}>
            <span className="inv-btn-in">
              <MailIcon />
              {S.email}
            </span>
          </Button>
          {invite !== undefined && canShareText(invite.shareText) ? (
            <Button className="al-press" disabled={!ready} onClick={share}>
              <span className="inv-btn-in">
                <ShareIcon />
                {S.share}
              </span>
            </Button>
          ) : null}
        </div>
        <p className="al-text-body-sm al-muted inv-note">{worksFor(days)}</p>
        {fellBack ? <p className="al-text-body-sm inv-note">{S.fellBack}</p> : null}
        {copied === 'failed' ? (
          <p className="al-text-body-sm" role="alert">
            {S.copyFailed}
          </p>
        ) : null}
        {shareFailed ? (
          <p className="al-text-body-sm" role="alert">
            {S.shareFailed}
          </p>
        ) : null}
        {error === undefined ? null : (
          <InlineError
            action={
              <Button size="sm" onClick={() => void make(wanted, made?.askedLong === true)}>
                {S.tryAgain}
              </Button>
            }
          >
            {error}
          </InlineError>
        )}
        {hood && invite !== undefined ? (
          <section className="inv-details al-expand" aria-label={S.details}>
            <h3 className="inv-eyebrow">{S.details}</h3>
            <dl className="inv-facts al-text-body-sm">
              <dt>{S.kind}</dt>
              <dd>{invite.format === 'short' ? S.kindShort : S.kindLong}</dd>
              <dt>{S.expires}</dt>
              <dd className="inv-mono">{exact(invite.expiresAt)}</dd>
            </dl>
            <div className="inv-ways">
              <Button
                size="sm"
                aria-expanded={qr}
                disabled={!ready}
                onClick={() => {
                  if (!qr) markShared();
                  setQr((on) => !on);
                }}
              >
                {qr ? S.hideQr : S.showQr}
              </Button>
              <Button
                size="sm"
                disabled={!ready}
                onClick={() => {
                  setQr(false);
                  void make(made?.label ?? '', invite.format !== 'long');
                }}
              >
                {invite.format === 'long' ? S.makeShort : S.makeLong}
              </Button>
            </div>
            {qr ? (
              <figure className="inv-qr al-reveal">
                <QrCode value={invite.inviteUrl} label={S.qrLabel} className="inv-qr-code" />
                <figcaption className="al-text-caption al-muted">{S.qrCaption}</figcaption>
              </figure>
            ) : null}
          </section>
        ) : null}
      </section>
      <p className="al-visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
