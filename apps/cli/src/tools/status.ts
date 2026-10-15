// `agentlink_status` (06 §2.1, §2.0, §6.1; M1-9c). Read-only in fact: it runs the core's fetch-only
// catch-up (M1-7h, D-73), which stores envelopes and processes nothing (no handshake, ack, contact,
// read mark or receipt; only relay AUTH may sign, D-53), then reads counts and contacts.
//
// I-5: the result carries counts and contact names under the 06 §2.1 rule only (the core's
// `display`): never message text, subjects, file names, terms or a self-declared name. Unknown
// senders appear only as the `requests` count. No `credits` or `prices` until M1-9d.
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

  const pendingApprovals =
    client.pendingApprovals === undefined ? undefined : await client.pendingApprovals();
  const storage = { mode: await client.storageMode() };

  logger.info('status', { contacts: contacts.length, unread, requests: counts.requests });
  return ok(statusSummary(inbox, counts.requests), {
    agent: { name: context.agentName, id: self.agentId, fingerprint: self.agentFingerprint },
    owner: { fingerprint: self.ownerFingerprint },
    contacts: contacts.length,
    unread,
    inbox,
    requests: counts.requests,
    ...(pendingApprovals === undefined ? {} : { pendingApprovals }),
    storage,
  });
}

/** The session-start line (06 §6.1; 11 §6.1 copy): who sent something new, and requests waiting. */
export function statusSummary(
  inbox: readonly { readonly contact: ContactRef; readonly unread: number }[],
  requests: number,
): string {
  const tail = requests > 0 ? [copy('chat.inbox.requestsWaiting', { count: requests })] : [];
  const fits = (parts: readonly string[]): boolean =>
    Array.from(parts.join(' ')).length <= MAX_TOOL_TEXT_CHARS;
  const named: string[] = [];
  for (const { contact, unread } of inbox.slice(0, SUMMARY_CONTACTS)) {
    const line = copy('chat.session.start', { count: unread, contactName: renderRef(contact) });
    if (!fits([...named, line, TOOL_TEXT.moreContactsWithNews, ...tail])) break;
    named.push(line);
  }
  const parts = [
    ...named,
    ...(named.length < inbox.length ? [TOOL_TEXT.moreContactsWithNews] : []),
    ...tail,
  ];
  return parts.length === 0 ? copy('chat.session.nothingNew') : parts.join(' ');
}
