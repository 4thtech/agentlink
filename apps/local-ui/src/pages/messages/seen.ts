// The "seen" marker (MSG-FILES-IO plan §4, owner decision 5 (a)): per contact, the time of the newest
// inbound message this person has looked at. Kept in this browser's localStorage only: a contact key
// and a time, never message text. Nothing is written to the server, so the AI's read state never
// changes. Storage can be missing or blocked: every access is wrapped, and the page works without.
export const SEEN_KEY = 'agentlink.messages.seen.v1';
export const SEEN_EVENT = 'agentlink:messages-seen';

export type Seen = Readonly<Record<string, number>>;

/** The fields the marker and the badge need from a conversation. */
export interface SeenSource {
  readonly contactId: string;
  readonly lastInAt: number;
}

export function loadSeen(): Seen {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Record that this contact's inbound messages up to `at` were looked at. Never moves back. */
export function markSeen(contactId: string, at: number): Seen {
  const current = loadSeen();
  if ((current[contactId] ?? -1) >= at) return current;
  const next = { ...current, [contactId]: at };
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(SEEN_EVENT));
  } catch {
    // No storage: the marker lives only in this page's memory.
  }
  return next;
}

/** Contacts with an inbound message newer than the marker: the sidebar badge. */
export function countUnseen(list: readonly SeenSource[], seen: Seen): number {
  return list.filter((c) => c.lastInAt > (seen[c.contactId] ?? 0)).length;
}
