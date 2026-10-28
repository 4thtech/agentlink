// UX2-d2 (b11 §21.1): the one link that opens the Add contact sheet from another page (Home's next
// step, the empty states). A fixed marker with no data: never an invite, a name or an ID. The
// Contacts page opens the sheet and drops the marker from the address at once.
export const ADD_CONTACT_MARKER = 'add-contact';
export const ADD_CONTACT_HREF = `/settings/contacts?${ADD_CONTACT_MARKER}`;
