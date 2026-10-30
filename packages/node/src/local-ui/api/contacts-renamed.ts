// W4-RENAME-REACHES-CONTACTS (S2; D-141; 07 §3 "Former name"; 08 §1 "A contact's rename"; 11 §5.8;
// proposed, owner confirms at merge): the seen mark of a contact's "{new} (was {old})" note.
//
// - `GET /api/ui/contacts` (api/contacts.ts) carries `formerName` while core says the note is due.
// - `GET /api/ui/contacts/:ref/name-seen`: the page showed the note (the Contacts row or the Messages
//   header); core sets `name_change_seen`, so later reads carry no `formerName`. The page keeps
//   showing the note until it leaves (08 §1). Display state only (07 §3: nothing is decided from it):
//   no owner presence, nothing signed, no identity label, safety code or key state changes. A GET,
//   because the shell's only writes are presence-gated owner operations and this is not one; it is
//   idempotent (a second call finds nothing due) and answers the same either way.
//
// What leaves: `{status: 'done'}` or a fixed error. Never a name.
import type { LocalUiContext } from '../context.js';
import {
  NOT_AVAILABLE,
  UI_INVALID_QUERY,
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';

/** A contact's ID: its agent's EVM address, lowercase (04 §2.9). */
const REF = /^0x[0-9a-f]{40}$/;

const NOT_FOUND: LocalUiResult = Object.freeze({
  status: 404,
  body: Object.freeze({ error: 'not_found' }),
});
const DONE: LocalUiResult = Object.freeze({ status: 200, body: Object.freeze({ status: 'done' }) });

async function nameSeen(context: LocalUiContext, request: LocalUiRequest): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return UI_NOT_SET_UP;
  if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
  const ref = request.params['ref'];
  if (typeof ref !== 'string' || !REF.test(ref)) return NOT_FOUND;
  const names = client.contactNames;
  if (names === undefined) return NOT_AVAILABLE;
  try {
    // Only a contact the list shows (not removed); its note may already be seen.
    const known = (await client.contacts.list()).some((view) => view.id === ref);
    if (!known) return NOT_FOUND;
    await names.markSeen(ref);
  } catch {
    // Never the error's text.
    return UI_UNAVAILABLE;
  }
  return DONE;
}

const nameSeenRoute: LocalUiReadRoute = Object.freeze({
  method: 'GET',
  path: '/api/ui/contacts/:ref/name-seen',
  presence: false,
  handler: nameSeen,
});

export const contactNamesRoutes: readonly LocalUiRoute[] = Object.freeze([nameSeenRoute]);
