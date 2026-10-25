// `agentlink_list_contacts` (06 §2.1; M1-9c). Read-only and local: it reads the contact book and the
// stored unread counts, with no relay traffic (`openWorldHint: false`). Names follow the 06 §2.1 rule
// (the core's `display`); no safety code is ever returned (04 §3.6.1).
import { MAX_TOOL_TEXT_CHARS } from '@4thtech-io/types';
import { copy, renderCopy } from './strings/index.js';
import { activeContacts, refsById, renderRef } from './contacts.js';
import type { ToolContext } from './context.js';
import { ok, type HandlerOutput } from './result.js';
import { TOOL_TEXT } from './text.js';

/** At most this many names in the summary; `structuredContent` lists every contact. */
const SUMMARY_NAMES = 5;

const rfc3339 = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export async function listContactsHandler(
  _input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  const views = activeContacts(await context.client.contacts());
  const counts = await context.client.storedCounts();
  const unreadById = new Map(counts.inbox.map((entry) => [entry.contactId, entry.unread] as const));
  const refs = refsById(views);
  const contacts = views.map((view) => ({
    ...refs.get(view.id)!,
    ownerFingerprint: view.ownerFingerprint.short,
    pairing: view.pairing,
    safetyCodeChecked: view.safetyCodeChecked,
    lastActivity: rfc3339(view.updatedAt),
    unread: unreadById.get(view.id) ?? 0,
  }));
  context.logger.info('list contacts', { contacts: contacts.length });
  return ok(contactsSummary(views.map((view) => renderRef(refs.get(view.id)!))), { contacts });
}

/** "You have 2 contacts: …" with at most five names; the count alone when names would not fit. */
export function contactsSummary(names: readonly string[]): string {
  if (names.length === 0) return copy('chat.status.ok.contactsNone');
  const shown = names.slice(0, SUMMARY_NAMES);
  const rest = names.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
  const summary = copy('chat.status.ok.contacts', { count: names.length, contacts: list });
  return Array.from(summary).length <= MAX_TOOL_TEXT_CHARS
    ? summary
    : renderCopy(TOOL_TEXT.contactsCountOnly, { count: names.length });
}
