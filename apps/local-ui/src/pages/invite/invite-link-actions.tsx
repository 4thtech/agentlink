// REL051-B2 (owner test, 13 Nov; 08 §1): Copy link and Show link on a waiting invite (Home and
// People). The link is fetched from this app's own server only when the owner clicks, used for the
// clipboard or shown as text in the row (never an attribute, the title, the address, a log or an
// error), and dropped from the page when hidden. Prototype 02-people: Copy link (secondary), the
// rest quiet (ghost).
import { Button, COPIED_MS, InlineError } from '@4thtech-io/ui';
import { useEffect, useId, useState, type ReactElement } from 'react';
import type { LinkOutcome } from '../contacts/invite-api.js';
import { CheckMark, CopyMark } from './icons.js';
import { INVITE_STRINGS as S } from './strings.js';
import './invite.css';

export interface InviteLink {
  readonly copy: () => void;
  readonly toggle: () => void;
  readonly busy: boolean;
  readonly copied: boolean;
  readonly shown: string | undefined;
  readonly problem: string | undefined;
  readonly announce: string;
  readonly revealId: string;
}

/** The owner's own link actions for one waiting invite; `onLink` reads the kept link. */
export function useInviteLink(
  inviteId: string,
  onLink: ((inviteId: string) => Promise<LinkOutcome>) | undefined,
): InviteLink {
  const revealId = useId();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const read = async (): Promise<string | undefined> => {
    if (onLink === undefined) return undefined;
    setBusy(true);
    setProblem(undefined);
    let out: LinkOutcome;
    try {
      out = await onLink(inviteId);
    } catch {
      out = { kind: 'failed' };
    }
    setBusy(false);
    if (out.kind === 'ok') return out.inviteUrl;
    setProblem(
      out.kind === 'no_link'
        ? S.noLinkKept
        : out.kind === 'not_found'
          ? S.linkGone
          : out.kind === 'session_expired'
            ? S.sessionExpired
            : S.cantGetLink,
    );
    return undefined;
  };

  const copy = (): void => {
    if (busy) return;
    void read().then((url) => {
      if (url === undefined) return;
      const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (clip === undefined) {
        setProblem(S.copyFailed);
        return;
      }
      clip.writeText(url).then(
        () => {
          setCopied(true);
          setAnnounce(S.copiedAnnounce);
        },
        () => setProblem(S.copyFailed),
      );
    });
  };

  const toggle = (): void => {
    if (shown !== undefined) {
      setShown(undefined);
      return;
    }
    if (busy) return;
    void read().then((url) => {
      if (url !== undefined) setShown(url);
    });
  };

  return { copy, toggle, busy, copied, shown, problem, announce, revealId };
}

/** Copy link (secondary) and Show link / Hide link (ghost). */
export function InviteLinkButtons({ link }: { readonly link: InviteLink }): ReactElement {
  return (
    <>
      <Button size="sm" className="al-press" disabled={link.busy} onClick={link.copy}>
        <span className="inv-btn-in">
          {link.copied ? <CheckMark /> : <CopyMark />}
          {link.copied ? S.linkCopied : S.copyLink}
        </span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="al-press"
        aria-expanded={link.shown !== undefined}
        aria-controls={link.revealId}
        disabled={link.busy && link.shown === undefined}
        onClick={link.toggle}
      >
        {link.shown === undefined ? S.showLink : S.hideLink}
      </Button>
    </>
  );
}

/** The shown link (text only), a problem line, and the polite announcement of a copy. */
export function InviteLinkReveal({
  link,
  label,
}: {
  readonly link: InviteLink;
  /** The accessible name of the shown link ("Invite link for {name}"). */
  readonly label: string;
}): ReactElement {
  return (
    <>
      <div id={link.revealId}>
        {link.shown === undefined ? null : (
          <div className="inv-link inv-link-kept" tabIndex={0} role="group" aria-label={label}>
            {link.shown}
          </div>
        )}
      </div>
      {link.problem === undefined ? null : <InlineError>{link.problem}</InlineError>}
      <span className="al-visually-hidden" role="status" aria-live="polite">
        {link.announce}
      </span>
    </>
  );
}
