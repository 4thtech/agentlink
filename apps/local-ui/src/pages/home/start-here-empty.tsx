// The empty states on Contacts, Messages and Files point to step 2 of Start here (UX2-g; B-11 §27.4).
// Until the Add contact sheet (UX2-d1, UX2-d2) lands, "Add contact" goes to Home, where the invite
// instructions of Start here are; the sheet replaces the link then. Once step 2 is done, or while it
// is not known, the pages keep their own empty states.
import type { ReactElement } from 'react';
import { inviteStillToDo, useStartHereContext } from './start-here-context.js';
import { START_STRINGS as T } from './strings.js';

/** True only while step 2 is known not done. */
export function useInviteFirst(): boolean {
  return inviteStillToDo(useStartHereContext());
}

export function AddContactAction(): ReactElement {
  return (
    <a className="al-btn al-btn-primary" href="/settings/home">
      {T.addContact}
    </a>
  );
}
