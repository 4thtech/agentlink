// W4-PEOPLE-INVITE: the invite panel (prototype v23 A3 and A5; D-139 short invites; 11 §5; I-7).
// Get started step 4 and the Invite screen both use it.
//
// - The link is made at once (a short link on the encrypted drop; the server falls back to a long
//   one when the drop is down, and the panel says so in plain words). It exists only as the text of
//   the link box, as the text of Email's `mailto:` address and, Under the hood, as the QR code's
//   drawing: never the title, the address, a log or an error. Everything goes to this same-origin
//   server only; a `mailto:` link is opened by the computer's mail app, not by us.
// - The optional name is only for your list (the invite's local label). A name added before the
//   link went anywhere makes a fresh link with that name and cancels the unnamed one; once the link
//   was copied, emailed, shared or shown as a QR code, the name is fixed.
// - REL051-B2 (owner test, 13 Nov; replaces "a link that never left the screen is cancelled when
//   the panel goes"): leaving keeps the link, copied or not. It waits under Home and People, where
//   Copy link and Show link get it again (the app keeps it, sealed) and Cancel invite ends it. Only
//   Get started's "Skip for now" (`discard`) ends a link that never left the screen.
// - Copy (✓ moment), Email (a real `mailto:` link with our share text; a click does not count as
//   sent, since nothing tells us a mail app opened), Copy invite message (the whole share text, the
//   dependable way when there is no mail app), Share (only where the browser has a share sheet).
// - Under the hood: the invite's facts, a long link instead (D-139 fallback, nothing stored on the
//   service) and the QR code.
import { Button, InlineError, SkeletonLine, useHood } from '@4thtech-io/ui';
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { createAgentsApi, type AgentsApi } from '../agents/api.js';
import { InviteNameGate } from '../agents/name-update.js';
import { createInviteApi, type CreatedInvite, type InviteApi } from '../contacts/invite-api.js';
import { createOwnerClient, type OwnerClient } from '../contacts/owner.js';
import { QrCode } from '../proofs/qr.js';
import { CheckMark, CopyMark, MailIcon, ShareIcon } from './icons.js';
import { INVITE_STRINGS as S, linkLabel, mailtoOf, worksFor } from './strings.js';
import { clearUnsentInvites } from './unsent-invites.js';
import './invite.css';

const DAY_MS = 86_400_000;
const COPIED_MS = 1600;
const MAX_NAME = 32;

export interface InvitePanelProps {
  /** For tests; the page's own same-origin clients by default. */
  readonly invites?: InviteApi;
  /** A link was made (the pending list can read again). */
  readonly onCreated?: () => void;
  /** Whether a link is on screen that has not gone anywhere yet. */
  readonly onUnsent?: (unsent: boolean) => void;
  /**
   * REL051-B2: set to true just before the panel goes when the owner chose not to invite ("Skip for
   * now" in Get started): a link that never left the screen is then cancelled. Otherwise it stays.
   */
  readonly discard?: { readonly current: boolean };
  /** WP-1: the IDs and owner clients of the name update asked before an invite (tests). */
  readonly agents?: AgentsApi;
  readonly owner?: OwnerClient;
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

/** RFC 3339 to the minute, UTC: the exact expiry Under the hood. */
const exact = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function InvitePanel({
  invites: givenInvites,
  onCreated,
  onUnsent,
  discard,
  now = () => Date.now(),
  agents: givenAgents,
  owner: givenOwner,
}: InvitePanelProps): ReactElement {
  const [invites] = useState<InviteApi>(() => givenInvites ?? createInviteApi());
  const [agents] = useState<AgentsApi>(() => givenAgents ?? createAgentsApi());
  const [owner] = useState<OwnerClient>(() => givenOwner ?? createOwnerClient());
  // WP-1 (R-2; D-141): the card still carries an older name: ask for the update before a link.
  const [nameGate, setNameGate] = useState<
    | {
        readonly cardName: string;
        readonly label: string;
        readonly name: string;
        readonly long: boolean;
      }
    | undefined
  >(undefined);
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
  const [copiedMessage, setCopiedMessage] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [shareFailed, setShareFailed] = useState(false);
  const [qr, setQr] = useState(false);
  const [announce, setAnnounce] = useState('');

  // The latest values for the leave-time cancel and for stale answers.
  const madeRef = useRef<Made | undefined>(undefined);
  const sharedRef = useRef(false);
  // An Email click: the mail app may hide the page; the invite stays pending (not shown as sent).
  const keptRef = useRef(false);
  const run = useRef(0);
  useEffect(() => {
    onUnsent?.(made !== undefined && !shared && !keptRef.current);
  }, [made, shared, onUnsent]);
  const live = useRef(true);
  madeRef.current = made;
  sharedRef.current = shared || keptRef.current;

  // REL051-UF3 (R1-UI-04): the link being made right now and the name it is for, so a Copy pressed
  // while the name is being saved copies that link, not nothing (the field's blur used to disable
  // Copy between the mouse press and the click, and the click was lost).
  const pendingRef = useRef<
    { readonly label: string; readonly promise: Promise<Made | undefined> } | undefined
  >(undefined);
  const makeNow = useCallback(
    async (label: string, long: boolean, oldName = false): Promise<Made | undefined> => {
      const mine = (run.current += 1);
      const previous = madeRef.current;
      setPhase('making');
      setError(undefined);
      setNameError(undefined);
      setNameGate(undefined);
      const outcome = await invites.create(
        label === '' ? undefined : label,
        long || oldName
          ? { ...(long ? { long } : {}), ...(oldName ? { oldName } : {}) }
          : undefined,
      );
      if (outcome.kind !== 'ok') {
        if (mine !== run.current || !live.current) return undefined;
        if (outcome.kind === 'name_update') {
          setNameGate({ cardName: outcome.cardName, label: outcome.label, name: label, long });
          setPhase(previous === undefined ? 'error' : 'ready');
          return undefined;
        }
        if (outcome.kind === 'invalid_name') {
          setNameError(S.nameInvalid);
          setPhase(previous === undefined ? 'error' : 'ready');
          if (previous === undefined) setError(S.cantCreate);
          return undefined;
        }
        setPhase(previous === undefined ? 'error' : 'ready');
        setError(
          outcome.kind === 'not_set_up'
            ? S.notSetUp
            : outcome.kind === 'session_expired'
              ? S.sessionExpired
              : S.cantCreate,
        );
        return undefined;
      }
      // IR-W4-PEOPLE-INVITE-1 (M): the ID comes only from this create's own answer, so the panel can
      // never cancel another invite (one sent earlier, or one the AI app made meanwhile).
      const id = outcome.invite.inviteId;
      const next: Made = { invite: outcome.invite, id, label, askedLong: long };
      if (mine !== run.current || !live.current) {
        // A newer link (or leaving) won: this one never reached the screen.
        void invites.cancel(id);
        return undefined;
      }
      madeRef.current = next;
      setMade(next);
      setPhase('ready');
      onCreated?.();
      // The one it replaces never left the screen: it goes.
      if (previous !== undefined && !sharedRef.current) void invites.cancel(previous.id);
      return next;
    },
    [invites, onCreated],
  );
  const make = useCallback(
    (label: string, long: boolean, oldName = false): Promise<Made | undefined> => {
      const promise = makeNow(label, long, oldName);
      const entry = { label, promise };
      pendingRef.current = entry;
      const done = (): void => {
        if (pendingRef.current === entry) pendingRef.current = undefined;
      };
      promise.then(done, done);
      return promise;
    },
    [makeNow],
  );

  useEffect(() => {
    live.current = true;
    // REL051-B2: an older build kept unsent invite IDs in this tab to cancel them later; those
    // invites now wait under Home and People instead, so the key is only cleared.
    clearUnsentInvites();
    void make('', false);
    return () => {
      live.current = false;
      // The link stays (Home and People can copy it again), unless the owner chose not to invite.
      const last = madeRef.current;
      if (discard?.current === true && last !== undefined && !sharedRef.current) {
        void invites.cancel(last.id);
      }
    };
    // Made once per panel.
  }, []);

  useEffect(() => {
    if (copied !== 'copied') return undefined;
    const t = setTimeout(() => setCopied('idle'), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    if (copiedMessage !== 'copied') return undefined;
    const t = setTimeout(() => setCopiedMessage('idle'), COPIED_MS * 2);
    return () => clearTimeout(t);
  }, [copiedMessage]);

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
    if (sharedRef.current || phase === 'making' || made === undefined) return;
    if (wanted === made.label) return;
    void make(wanted, made.askedLong);
  };

  /**
   * REL051-UF3 (R1-UI-04): the link a Copy, Email or Share click sends. A name typed and not saved
   * yet (the click came before or during the field's blur) is saved first, so what goes out is the
   * link for that name; a link being made is waited for. Undefined when making it failed (the panel
   * then says why).
   */
  const finalInvite = (): CreatedInvite | Promise<CreatedInvite | undefined> | undefined => {
    const current = madeRef.current;
    const pending = pendingRef.current;
    const wanted = name.trim();
    if (current !== undefined && !sharedRef.current && wanted !== current.label) {
      if (pending?.label === wanted) return pending.promise.then((m) => m?.invite);
      return make(wanted, current.askedLong).then((m) => m?.invite);
    }
    if (pending !== undefined) {
      return pending.promise.then((m) => m?.invite ?? madeRef.current?.invite);
    }
    return current?.invite;
  };

  /**
   * Puts the text on the clipboard. While the link is still being made, a ClipboardItem holding a
   * promise keeps the click's user gesture (Safari needs that); without one it writes once made.
   * 'none' when there was no link to copy (the panel already says why), 'failed' when refused.
   */
  const writeClip = (
    text: string | Promise<string | undefined>,
  ): Promise<'copied' | 'failed' | 'none'> => {
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clip === undefined) return Promise.resolve('failed');
    if (typeof text === 'string') {
      return clip.writeText(text).then(
        () => 'copied' as const,
        () => 'failed' as const,
      );
    }
    let none = false;
    const later = text.then((t) => {
      if (t === undefined) none = true;
      return t;
    });
    const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    const written: Promise<unknown> =
      Item !== undefined && typeof clip.write === 'function'
        ? clip.write([
            new Item({
              'text/plain': later.then((t) => {
                if (t === undefined) throw new Error('no link');
                return new Blob([t], { type: 'text/plain' });
              }),
            }),
          ])
        : later.then((t) => (t === undefined ? undefined : clip.writeText(t)));
    return written.then(
      () => (none ? ('none' as const) : ('copied' as const)),
      () => (none ? ('none' as const) : ('failed' as const)),
    );
  };

  const invite = made?.invite;
  const ready = phase === 'ready' && invite !== undefined;
  // A link is on screen (a fresh one may be on its way for a new name): Copy, Email and Share work.
  const usable = invite !== undefined && phase !== 'error';
  const fellBack = invite !== undefined && invite.format === 'long' && made?.askedLong !== true;
  const days =
    invite === undefined ? 7 : Math.max(1, Math.round((invite.expiresAt - now()) / DAY_MS));

  const copy = (): void => {
    if (madeRef.current === undefined) return;
    const target = finalInvite();
    const text = target instanceof Promise ? target.then((i) => i?.inviteUrl) : target?.inviteUrl;
    if (text === undefined) return;
    void writeClip(text).then((result) => {
      if (!live.current || result === 'none') return;
      if (result === 'failed') {
        setCopied('failed');
        return;
      }
      markShared();
      setCopied('copied');
      setAnnounce(S.copiedAnnounce);
    });
  };
  const keepPending = (): void => {
    keptRef.current = true;
    sharedRef.current = true;
  };
  // The whole invite text (our words around the link), for a mail written by hand or a chat.
  const copyMessage = (): void => {
    if (madeRef.current === undefined) return;
    const target = finalInvite();
    const text = target instanceof Promise ? target.then((i) => i?.shareText) : target?.shareText;
    if (text === undefined) return;
    void writeClip(text).then((result) => {
      if (!live.current || result === 'none') return;
      if (result === 'failed') {
        setCopiedMessage('failed');
        return;
      }
      markShared();
      setCopiedMessage('copied');
      setAnnounce(S.copiedMessageAnnounce);
    });
  };
  const share = (): void => {
    if (madeRef.current === undefined) return;
    setShareFailed(false);
    const send = (target: CreatedInvite | undefined): void => {
      if (target === undefined || !live.current) return;
      void navigator.share({ title: S.shareTitle, text: target.shareText }).then(
        () => markShared(),
        (e: unknown) => {
          if (!isAbort(e)) setShareFailed(true);
        },
      );
    };
    const target = finalInvite();
    if (target instanceof Promise) void target.then(send);
    else send(target);
  };
  // Email: a name not saved yet is saved first, then the mail app opens with that name's link.
  const email = (e: { preventDefault: () => void }): void => {
    const target = finalInvite();
    if (!(target instanceof Promise)) {
      keepPending();
      return;
    }
    e.preventDefault();
    void target.then((next) => {
      if (next === undefined || !live.current) return;
      keepPending();
      window.location.href = mailtoOf(next.shareText);
    });
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

      {nameGate === undefined ? null : (
        <InviteNameGate
          cardName={nameGate.cardName}
          label={nameGate.label}
          agents={agents}
          owner={owner}
          onUpdated={() => void make(nameGate.name, nameGate.long)}
          onOldName={() => void make(nameGate.name, nameGate.long, true)}
        />
      )}
      {nameGate !== undefined && made === undefined ? null : (
        <section className="inv-card al-reveal" aria-label={linkLabel(wanted)}>
          <span className="inv-eyebrow">{linkLabel(wanted)}</span>
          <div className="inv-row">
            <div
              ref={boxRef}
              className="inv-link"
              // A long link scrolls inside its box: the box takes focus so it can be read by keyboard.
              tabIndex={0}
              role="group"
              aria-label={linkLabel(wanted)}
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
            <Button
              variant="primary"
              className="inv-copy al-press"
              disabled={!usable}
              onClick={copy}
            >
              <span className="inv-btn-in">
                {copied === 'copied' ? <CheckMark /> : <CopyMark />}
                {copied === 'copied' ? S.copied : S.copy}
              </span>
            </Button>
          </div>
          <div className="inv-ways">
            {/* A real link: the mail app opens when there is one. Nothing tells us it did, so the
                click is not "sent" (Copy invite message is); it fixes the name and keeps Skip for
                now from cancelling the invite, which then waits until it expires. */}
            {usable ? (
              <a
                className="al-btn al-btn-secondary al-press inv-email"
                href={mailtoOf(invite.shareText)}
                onClick={email}
              >
                <span className="inv-btn-in">
                  <MailIcon />
                  {S.email}
                </span>
              </a>
            ) : (
              <Button className="al-press" disabled>
                <span className="inv-btn-in">
                  <MailIcon />
                  {S.email}
                </span>
              </Button>
            )}
            <Button className="al-press" disabled={!usable} onClick={copyMessage}>
              <span className="inv-btn-in">
                {copiedMessage === 'copied' ? <CheckMark /> : <CopyMark />}
                {S.copyMessage}
              </span>
            </Button>
            {invite !== undefined && canShareText(invite.shareText) ? (
              <Button className="al-press" disabled={!usable} onClick={share}>
                <span className="inv-btn-in">
                  <ShareIcon />
                  {S.share}
                </span>
              </Button>
            ) : null}
          </div>
          <p className="al-text-body-sm al-muted inv-note">{worksFor(days)}</p>
          {fellBack ? <p className="al-text-body-sm inv-note">{S.fellBack}</p> : null}
          {copiedMessage === 'copied' ? (
            <p className="al-text-body-sm inv-status" role="status">
              <CheckMark />
              <span>{S.copiedMessage}</span>
            </p>
          ) : null}
          {copied === 'failed' || copiedMessage === 'failed' ? (
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
      )}
      <p className="al-visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
