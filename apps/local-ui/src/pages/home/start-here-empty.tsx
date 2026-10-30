// The empty states on Contacts, Messages and Files point to step 2 of Start here (UX2-g; B-11 §27.4).
// "Add contact" opens the Invite screen (W4-WIRE; W4-WIRE-2 retired the Add contact sheet, Decision
// 52 (3)); Contacts itself opens it in place. Once step 2 is done, or while it is not known, the
// pages keep their own empty states.
import type { ReactElement } from 'react';
import { ADD_CONTACT_HREF } from '../contacts/add-contact-link.js';
import { inviteStillToDo, useStartHereContext } from './start-here-context.js';
import { START_STRINGS as T } from './strings.js';

/** True only while step 2 is known not done. */
export function useInviteFirst(): boolean {
  return inviteStillToDo(useStartHereContext());
}

export function AddContactAction(): ReactElement {
  return (
    <a className="al-btn al-btn-primary" href={ADD_CONTACT_HREF}>
      {T.addContact}
    </a>
  );
}
