// The app's one toast stack (docs/design/notices.md), on every page: the contact toasts
// (W5-INVITE-FEEDBACK: "{name} accepted your invite", "You're connected with {name}", and after a
// re-pair "Connected again with {name}. Do the Contact check again." with one action to People,
// where the code is checked; nothing here approves anything) and every toast a page raises with
// `notify()` ("Renamed. Your contacts will see …", "{name} removed."). Names are React text only
// (I-5). A toast closes itself after a few seconds (longer with an action), or with its close; at
// most three show, newest last.
import { ToastStack, type ToastItem } from '@4thtech-io/ui';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { subscribeContactChanges, type ContactChange } from '../api/contact-changes.js';
import { INTERIM_PEOPLE_PATH } from '../nav.js';
import { subscribeToasts } from '../notices/index.js';
import { FEEDBACK_STRINGS as F, changeText } from '../pages/invite/strings.js';

/** Opens People without a reload (the router follows popstate; it imports this layout itself). */
function openPeople(): void {
  history.pushState(null, '', INTERIM_PEOPLE_PATH);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
const MAX_SHOWN = 3;

export interface ContactToastsProps {
  /** For tests; the shared follower by default. */
  readonly subscribe?: (listener: (change: ContactChange) => void) => () => void;
  /** For tests; the app's `notify()` bus by default. */
  readonly subscribeNotices?: (listener: (toast: ToastItem) => void) => () => void;
  /** For tests: auto-close after (0 keeps them). Default: the stack's own times. */
  readonly ms?: number;
}

let seq = 0;

function contactToast(change: ContactChange): ToastItem {
  seq += 1;
  return {
    id: `c${seq}`,
    text: changeText(change),
    ...(change.kind === 'again' ? { action: F.checkAction, onAction: openPeople } : {}),
  };
}

export function ContactToasts({
  subscribe = (l) => subscribeContactChanges(l),
  subscribeNotices = subscribeToasts,
  ms,
}: ContactToastsProps): ReactElement | null {
  const [shown, setShown] = useState<readonly ToastItem[]>([]);
  const add = useCallback(
    (item: ToastItem) => setShown((list) => [...list, item].slice(-MAX_SHOWN)),
    [],
  );

  useEffect(() => {
    const offContacts = subscribe((change) => add(contactToast(change)));
    const offNotices = subscribeNotices(add);
    return () => {
      offContacts();
      offNotices();
    };
    // One subscription per mount.
  }, []);

  return (
    <ToastStack
      items={shown}
      onDismiss={(id) => setShown((list) => list.filter((t) => t.id !== id))}
      {...(ms === undefined ? {} : { ms })}
    />
  );
}

/** The shell's toast host under its general name. */
export const AppToasts = ContactToasts;
