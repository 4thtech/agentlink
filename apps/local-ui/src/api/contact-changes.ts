// W5-INVITE-FEEDBACK (08 §1 `GET /api/ui/events`, event `contacts`; 04 §2.9): what changed in the
// open agent's contacts, so both sides of an invite hear when it is done, with no reload.
//
// - The live store (live.ts) announces CONTACTS_CHANGED when the stream says the contacts or invites
//   changed. The event carries nothing: the views read again through the usual reads.
// - One shared follower reads `GET /api/ui/contacts` and `GET /api/ui/invites` on each
//   announcement, when the tab comes back, and, while something waits (an open invite or an accept)
//   and the stream is not running, every 5 s. It compares the read with the last one (diffContacts)
//   and tells its listeners what changed: a new contact while an invite was open ("accepted"), an
//   accept of ours that completed ("connected"), and a re-pair, a later `pairedAt` on a contact
//   already there ("again").
// - Another agent's list (after a switch) is never a change: the first read of each agent is only
//   remembered. Names are text from the server's name rule (I-5); refs are never shown.
import { LIST_PATH, parseList, type ContactRow } from '../pages/contacts/data.js';
import {
  INVITES_LIST_PATH,
  parseConnecting,
  parseOpenInvites,
  type ConnectingRow,
} from '../pages/contacts/invite-api.js';
import { createApiClient, type ApiClient } from './client.js';
import { getLive, liveMode, subscribeLive } from './live.js';

export const CONTACTS_CHANGED = 'agentlink:contacts-changed';
/** The fallback read while something waits and the stream is not running (08 §1). */
export const CONTACTS_POLL_MS = 5_000;

/** Tells the views that show contacts or invites to read again. */
export function announceContactsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(CONTACTS_CHANGED));
}

/** One read of the open agent's contacts and invites. */
export interface ContactsPicture {
  /** The open agent (the live store's `current`), so another agent's list is never a change. */
  readonly agent: string | null;
  readonly contacts: readonly ContactRow[];
  readonly connecting: readonly ConnectingRow[];
  readonly openInvites: number;
}

export interface ContactChange {
  /** accepted: your invite; connected: the invite you pasted; again: a re-pair. */
  readonly kind: 'accepted' | 'connected' | 'again';
  readonly ref: string;
  /** The name the list shows (owner alias or the name rule's output): text only. */
  readonly name: string;
}

const paired = (c: ContactRow): boolean => c.status === 'active' && c.pairing === 'complete';
const shown = (c: ContactRow): string =>
  c.nameSource === 'counterparty' && c.name.trim() === '' && c.fingerprint !== undefined
    ? c.fingerprint
    : c.name;

/** What changed between two reads of the same agent; nothing on the first read or after a switch. */
export function diffContacts(
  before: ContactsPicture | undefined,
  after: ContactsPicture,
): ContactChange[] {
  if (before === undefined || before.agent !== after.agent) return [];
  const old = new Map(before.contacts.map((c) => [c.ref, c]));
  const mine = new Set(before.connecting.map((c) => c.ref));
  const out: ContactChange[] = [];
  for (const c of after.contacts) {
    if (!paired(c)) continue;
    const was = old.get(c.ref);
    const name = shown(c);
    if (was === undefined || !paired(was)) {
      const kind = mine.has(c.ref) || before.openInvites === 0 ? 'connected' : 'accepted';
      out.push({ kind, ref: c.ref, name });
      continue;
    }
    if (was.pairedAt !== undefined && c.pairedAt !== undefined && c.pairedAt > was.pairedAt) {
      out.push({ kind: 'again', ref: c.ref, name });
    }
  }
  return out;
}

// --- The shared follower ----------------------------------------------------------------------

type Listener = (change: ContactChange) => void;
const listeners = new Set<Listener>();
let api: ApiClient | undefined;
let last: ContactsPicture | undefined;
let reading = false;
let again = false;
let timer: ReturnType<typeof setInterval> | undefined;
let stopLive: (() => void) | undefined;

const visible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden';

async function read(): Promise<void> {
  if (reading) {
    again = true;
    return;
  }
  reading = true;
  try {
    const client = api ?? (api = createApiClient());
    const [list, invites] = await Promise.all([
      client.get(LIST_PATH),
      client.get(INVITES_LIST_PATH),
    ]);
    if (list.kind !== 'ok') return;
    const parsed = parseList(list.data);
    if (parsed.kind !== 'ok') return;
    const data = invites.kind === 'ok' ? invites.data : undefined;
    const next: ContactsPicture = {
      agent: getLive().list?.current ?? null,
      contacts: parsed.contacts,
      connecting: parseConnecting(data),
      openInvites: (parseOpenInvites(data) ?? []).length,
    };
    const changes = diffContacts(last, next);
    last = next;
    for (const change of changes) for (const l of [...listeners]) l(change);
  } catch {
    // A failed read changes nothing; the next one tries again.
  } finally {
    reading = false;
    if (again) {
      again = false;
      void read();
    }
  }
}

const waiting = (): boolean =>
  last !== undefined && (last.openInvites > 0 || last.connecting.length > 0);

const onChanged = (): void => void read();
const onVisible = (): void => {
  if (visible()) void read();
};

/**
 * Listens for what changed; the first listener starts the follower (and the shared live
 * subscription), the last one stops it.
 */
export function subscribeContactChanges(
  listener: Listener,
  seam?: { readonly api?: ApiClient },
): () => void {
  if (seam?.api !== undefined) api = seam.api;
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener(CONTACTS_CHANGED, onChanged);
    document.addEventListener('visibilitychange', onVisible);
    stopLive = subscribeLive(() => undefined);
    timer = setInterval(() => {
      if (visible() && waiting() && liveMode() !== 'stream') void read();
    }, CONTACTS_POLL_MS);
    void read();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener(CONTACTS_CHANGED, onChanged);
    document.removeEventListener('visibilitychange', onVisible);
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    stopLive?.();
    stopLive = undefined;
    last = undefined;
  };
}
