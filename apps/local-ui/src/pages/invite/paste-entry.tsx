// W5-PASTE-ENTRY (owner test of 0.4.6, 1 Nov: the paste entry was hard to find): "Someone invited
// you? Paste link" on Home, in Get started and on People, and an opt-in clipboard check.
//
// - The entry is a plain link to People's paste screen (`/contacts?paste`, a fixed marker with no
//   data); the marker leaves the address at once.
// - The clipboard is read only (a) when the owner clicks "Paste from clipboard", or (b) when the
//   window gains focus, after the owner turned that on once (a checkbox; this browser only). It is
//   never read silently otherwise. Only one AgentLink invite link counts (paste-invite.ts
//   inviteLinkOf, fail closed); on focus it is only offered ("Use the invite link you copied?"),
//   never checked or sent on its own. The clipboard text never leaves this page: it goes into the
//   paste field, and the owner's Continue sends the link to this computer's own server as before.
import { Button } from '@4thtech-io/ui';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { INTERIM_PEOPLE_PATH } from '../../nav.js';
import { inviteLinkOf } from './invite-link-of.js';
import { FEEDBACK_STRINGS as F } from './strings.js';
import './invite.css';

export const PASTE_MARKER = 'paste';
export const PASTE_HREF = `${INTERIM_PEOPLE_PATH}?${PASTE_MARKER}`;
/** This browser's opt-in to the focus check (a per-viewer convenience; nothing else is stored). */
export const CLIPBOARD_OPT_IN_KEY = 'agentlink.clipboardInviteCheck';

/** "Someone invited you? Paste link": opens People's paste screen. */
export function PasteEntryLink({ className }: { readonly className?: string }): ReactElement {
  return (
    <a className={className ?? 'inv-link-button'} href={PASTE_HREF}>
      {F.pasteEntry}
    </a>
  );
}

function optedIn(): boolean {
  try {
    return localStorage.getItem(CLIPBOARD_OPT_IN_KEY) === 'on';
  } catch {
    return false;
  }
}

function setOptIn(on: boolean): void {
  try {
    if (on) localStorage.setItem(CLIPBOARD_OPT_IN_KEY, 'on');
    else localStorage.removeItem(CLIPBOARD_OPT_IN_KEY);
  } catch {
    // No storage: the check stays off after a reload.
  }
}

/** The one invite link on the clipboard, or 'none', or 'blocked' (no permission or no API). */
async function clipboardLink(): Promise<string | 'none' | 'blocked'> {
  const read = typeof navigator === 'undefined' ? undefined : navigator.clipboard?.readText;
  if (typeof read !== 'function') return 'blocked';
  let text: string;
  try {
    text = await read.call(navigator.clipboard);
  } catch {
    return 'blocked';
  }
  return inviteLinkOf(text.trim()) ?? 'none';
}

export interface ClipboardOfferProps {
  /** The owner chose this link (a click): it goes into the paste field. */
  readonly onFound: (link: string) => void;
}

/** "Paste from clipboard", the one-time opt-in to the focus check, and its offer. */
export function ClipboardOffer({ onFound }: ClipboardOfferProps): ReactElement {
  const optId = useId();
  const [on, setOn] = useState(optedIn);
  const [offer, setOffer] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    const onFocus = (): void => {
      void clipboardLink().then((found) => {
        if (!live) return;
        // On focus only an offer: nothing is checked or sent until the owner chooses it.
        if (found !== 'none' && found !== 'blocked') setOffer(found);
      });
    };
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [on]);

  const pasteNow = (): void => {
    setNote(undefined);
    void clipboardLink().then((found) => {
      if (found === 'blocked') setNote(F.clipboardBlocked);
      else if (found === 'none') setNote(F.clipboardEmpty);
      else onFound(found);
    });
  };

  return (
    <div className="inv-clip">
      {offer === undefined ? null : (
        <div className="inv-clip-offer" role="status">
          <span className="al-text-body-sm">{F.clipboardOffer}</span>
          <Button
            size="sm"
            onClick={() => {
              const link = offer;
              setOffer(undefined);
              onFound(link);
            }}
          >
            {F.useIt}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOffer(undefined)}>
            {F.notNow}
          </Button>
        </div>
      )}
      <Button size="sm" variant="secondary" onClick={pasteNow}>
        {F.pasteFromClipboard}
      </Button>
      {note === undefined ? null : <p className="al-text-body-sm al-muted">{note}</p>}
      <label className="inv-clip-opt al-text-body-sm al-muted" htmlFor={optId}>
        <input
          id={optId}
          type="checkbox"
          checked={on}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            setOptIn(next);
            setOn(next);
          }}
        />
        {F.clipboardOptIn}
      </label>
    </div>
  );
}
