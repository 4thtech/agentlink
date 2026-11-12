// W5-INVITE-FEEDBACK (08 §1; 11 §5; I-5): the app-wide toasts for contacts, on every page, so the
// inviter hears "{name} accepted your invite" and the accepter "You're connected with {name}" the
// moment the pairing completes, with no reload. After a re-pair: "Connected again with {name}.
// Do the Contact check again." with one action to People, where the code is checked (signed with
// Touch ID there; nothing here approves anything). The name is React text only. A toast stays until
// it is dismissed or 8 s pass; at most three show, newest last.
import { Toast } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { subscribeContactChanges, type ContactChange } from '../api/contact-changes.js';
import { INTERIM_PEOPLE_PATH } from '../nav.js';
import { FEEDBACK_STRINGS as F, changeText } from '../pages/invite/strings.js';

const SHOW_MS = 8_000;

/** Opens People without a reload (the router follows popstate; it imports this layout itself). */
function openPeople(): void {
  history.pushState(null, '', INTERIM_PEOPLE_PATH);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
const MAX_SHOWN = 3;

interface Shown {
  readonly key: number;
  readonly change: ContactChange;
}

export interface ContactToastsProps {
  /** For tests; the shared follower by default. */
  readonly subscribe?: (listener: (change: ContactChange) => void) => () => void;
}

let seq = 0;

export function ContactToasts({
  subscribe = (l) => subscribeContactChanges(l),
}: ContactToastsProps): ReactElement | null {
  const [shown, setShown] = useState<readonly Shown[]>([]);

  useEffect(
    () =>
      subscribe((change) => {
        seq += 1;
        const key = seq;
        setShown((list) => [...list, { key, change }].slice(-MAX_SHOWN));
        setTimeout(() => setShown((list) => list.filter((t) => t.key !== key)), SHOW_MS);
      }),
    // One subscription per mount.
    [],
  );

  if (shown.length === 0) return null;
  const drop = (key: number): void => setShown((list) => list.filter((t) => t.key !== key));
  return (
    <div className="al-toasts">
      {shown.map(({ key, change }) => (
        <Toast
          key={key}
          {...(change.kind === 'again'
            ? {
                action: F.checkAction,
                onAction: () => {
                  drop(key);
                  openPeople();
                },
              }
            : {})}
          onDismiss={() => drop(key)}
        >
          {changeText(change)}
        </Toast>
      ))}
    </div>
  );
}
