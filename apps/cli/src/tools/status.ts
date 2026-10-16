// `agentlink_status` (06 §2.1, §2.0, §6.1; M1-9c). Read-only in fact: it runs the core's fetch-only
// catch-up (M1-7h, D-73), which stores envelopes and processes nothing (no handshake, ack, contact,
// read mark or receipt; only relay AUTH may sign, D-53), then reads counts and contacts.
//
// I-5: the result carries counts and contact names under the 06 §2.1 rule only (the core's
// `display`): never message text, subjects, file names, terms or a self-declared name. Unknown
// senders appear only as the `requests` count. No `credits` or `prices` until M1-9d.
//
// Open offers (M1-22): received offers still waiting for an answer, even ones already read in an
// earlier session, are counted by contact (`openOffers`, `offers`) from the core's store read, so a
// fresh session can find them; their content is read only through `agentlink_inbox` with
// `openOffers: true`. A failed read counts none (fail closed); its error text is never logged.
import { MAX_TOOL_TEXT_CHARS } from '@agentlink/types';
import { copy } from './strings/index.js';
import { activeContacts, contactRef, renderRef, type ContactRef } from './contacts.js';
import type { Counts, ToolContext } from './context.js';
import { fail, ok, type HandlerOutput } from './result.js';
import { TOOL_TEXT } from './text.js';

/** 06 §2.1: the catch-up's time budget. */
export const STATUS_CATCH_UP_BUDGET_MS = 3_000;
/** At most this many contacts are named in the summary; the rest are counted. */
const SUMMARY_CONTACTS = 3;

export async function statusHandler(_input: unknown, context: ToolContext): Promise<HandlerOutput> {
  const { client, logger } = context;
  const self = await client.self();
  if (self === undefined) return fail('needs_setup', TOOL_TEXT.noIdentity, TOOL_TEXT.setupNextStep);

  let counts: Counts;
  try {
    counts = await client.catchUp(STATUS_CATCH_UP_BUDGET_MS);
  } catch {
    // Offline or no relay: the stored counts still answer the session-start check.
    logger.info('status catch-up unavailable; stored counts used');
    counts = await client.storedCounts();
  }

  const contacts = activeContacts(await client.contacts());
  const byId = new Map(contacts.map((view) => [view.id, contactRef(view)] as const));
  const inbox: { contact: ContactRef; unread: number }[] = [];
  let unread = 0;
  for (const entry of counts.inbox) {
    if (entry.unread <= 0) continue;
    unread += entry.unread;
    const contact = byId.get(entry.contactId);
    if (contact !== undefined) inbox.push({ contact, unread: entry.unread });
  }

  const offers: { contact: ContactRef; open: number }[] = [];
  let openOffers = 0;
  let found: readonly { readonly contactId: string }[] = [];
  try {
    found = (await client.openOffers?.()) ?? [];
  } catch {
    logger.info('status open offers unavailable');
  }
  for (const offer of found) {
    const contact = byId.get(offer.contactId);
    if (contact === undefined) continue;
    openOffers += 1;
    const entry = offers.find((o) => o.contact.id === contact.id);
    if (entry === undefined) offers.push({ contact, open: 1 });
    else entry.open += 1;
  }

  const pendingApprovals = await client.pendingApprovals();
  const storage = { mode: await client.storageMode() };

  logger.info('status', {
    contacts: contacts.length,
    unread,
    requests: counts.requests,
    openOffers,
  });
  return ok(statusSummary(inbox, counts.requests, offers), {
    agent: { name: context.agentName, id: self.agentId, fingerprint: self.agentFingerprint },
    owner: { fingerprint: self.ownerFingerprint },
    contacts: contacts.length,
    unread,
    inbox,
    requests: counts.requests,
    pendingApprovals,
    openOffers,
    offers,
    storage,
  });
}

const fill = (template: string, slots: Readonly<Record<string, string>>): string =>
  Object.entries(slots).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(value),
    template,
  );

/** One open-offer line (11 §5 vocabulary; a count and a name under the 06 §2.1 rule). */
function offersLine(contact: ContactRef, open: number): string {
  return fill(open === 1 ? TOOL_TEXT.openOffersFromOne : TOOL_TEXT.openOffersFromMany, {
    count: String(open),
    contactName: renderRef(contact),
  });
}

/** The session-start line (06 §6.1; 11 §6.1 copy): who sent something new, and requests waiting. */
export function statusSummary(
  inbox: readonly { readonly contact: ContactRef; readonly unread: number }[],
  requests: number,
  offers: readonly { readonly contact: ContactRef; readonly open: number }[] = [],
): string {
  const requestsTail =
    requests > 0 ? [copy('chat.inbox.requestsWaiting', { count: requests })] : [];
  const offersTail = offers.length > 0 ? [TOOL_TEXT.openOffersHowTo] : [];
  const fits = (parts: readonly string[]): boolean =>
    Array.from(parts.join(' ')).length <= MAX_TOOL_TEXT_CHARS;
  // Unread lines first; then open-offer lines, each kept only while the whole summary fits.
  const named: string[] = [];
  const reserve = [
    TOOL_TEXT.moreContactsWithNews,
    ...(offers.length > 0 ? [TOOL_TEXT.moreContactsWithOffers, ...offersTail] : []),
    ...requestsTail,
  ];
  for (const { contact, unread } of inbox.slice(0, SUMMARY_CONTACTS)) {
    const line = copy('chat.session.start', { count: unread, contactName: renderRef(contact) });
    if (!fits([...named, line, ...reserve])) break;
    named.push(line);
  }
  const unreadMore = named.length < inbox.length ? [TOOL_TEXT.moreContactsWithNews] : [];
  const offered: string[] = [];
  for (const { contact, open } of offers.slice(0, SUMMARY_CONTACTS)) {
    const line = offersLine(contact, open);
    const rest = [TOOL_TEXT.moreContactsWithOffers, ...offersTail, ...requestsTail];
    if (!fits([...named, ...unreadMore, ...offered, line, ...rest])) break;
    offered.push(line);
  }
  const parts = [
    ...named,
    ...unreadMore,
    ...offered,
    ...(offered.length < offers.length ? [TOOL_TEXT.moreContactsWithOffers] : []),
    ...offersTail,
    ...requestsTail,
  ];
  return parts.length === 0 ? copy('chat.session.nothingNew') : parts.join(' ');
}
