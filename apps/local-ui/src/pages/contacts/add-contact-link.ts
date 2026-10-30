// UX2-d2 (b11 §21.1): the one link that opens "add a contact" from another page (Home's next step,
// the empty states, the compact window, the map). A fixed marker with no data: never an invite, a
// name or an ID. W4-WIRE: it now opens U4's Invite screen (People `?invite`); the old marker
// (`?add-contact`, from older links) opens the Invite screen too, and leaves the address at once.
import { INVITE_PATH } from '../../nav.js';

export const ADD_CONTACT_MARKER = 'add-contact';
export const ADD_CONTACT_HREF = INVITE_PATH;
