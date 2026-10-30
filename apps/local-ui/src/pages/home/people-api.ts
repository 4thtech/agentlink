// W4-HOME: what Home reads (08 §1; the existing read routes only, no new authority, I-4). Every
// answer goes through the existing allowlist parsers (messages/api.ts, contacts/data.ts,
// files/io-api.ts), so a field the server should not send never reaches the page.
//
// - `GET /api/ui/messages`: the people (every contact that is not removed) with their last activity;
// - `GET /api/ui/contacts`: the contact facts for the pro layer (fingerprint, identity, paired);
// - `GET /api/ui/files/received` and `/sent`: each file's state (Saved as, Arrived · not saved);
// - per person, the newest page each way (`/api/ui/messages/<id>?box=in|out`): the last message,
//   its delivery word, the proofs and the files. A person's pages are read again only when their
//   last activity changed or a message still waits to send, so polling stays cheap.
//
// Reading here never writes and never marks anything read for the AI.
import type { ApiClient } from '../../api/client.js';
import { LIST_PATH, parseList, type ContactRow } from '../contacts/data.js';
import { parseReceived, parseSent, type ReceivedItem, type SentItem } from '../files/io-api.js';
import {
  createMessagesApi,
  type Conversation,
  type MessageItem,
  type MessagePage,
  type MessagesApi,
  type Problem,
} from '../messages/api.js';

export const RECEIVED_LIST = '/api/ui/files/received?limit=100';
export const SENT_LIST = '/api/ui/files/sent?limit=100';
/** At most this many people get their newest pages read per refresh. */
export const MAX_SUMMARIES = 20;

/** A message with its direction, as the conversation shows it. */
export interface ThreadItem {
  readonly item: MessageItem;
  readonly out: boolean;
}

/** What a person row needs beyond the conversation list. */
export interface PersonSummary {
  /** The conversation's `lastAt` these pages were read for. */
  readonly lastAt: number;
  readonly last?: ThreadItem;
  /** The delivery state of the newest message your AI sent them. */
  readonly delivery?: MessageItem['status'];
  readonly proofs: number;
  readonly files: number;
  /** A message your AI sent still waits to send: read again next time. */
  readonly pending: boolean;
}

export interface HomeData {
  readonly people: readonly Conversation[];
  readonly contacts: ReadonlyMap<string, ContactRow>;
  readonly received: ReadonlyMap<string, ReceivedItem>;
  readonly sent: ReadonlyMap<string, SentItem>;
}

/** A received or sent file's item ID: `<envelope ID>.<two-digit index>`. */
export const fileItemId = (envelopeId: string, index: number): string =>
  `${envelopeId}.${String(index).padStart(2, '0')}`;

/** Both pages, oldest first. A message with no text and no file (a bare offer) is left out. */
export function mergeThread(
  inbox: readonly MessageItem[],
  sent: readonly MessageItem[],
): ThreadItem[] {
  return [
    ...[...inbox].reverse().map((item) => ({ item, out: false })),
    ...[...sent].reverse().map((item) => ({ item, out: true })),
  ]
    .filter(({ item }) => item.text !== '' || item.files.length > 0)
    .sort((a, b) => a.item.at - b.item.at);
}

export function summarize(lastAt: number, inbox: MessagePage, sent: MessagePage): PersonSummary {
  const thread = mergeThread(inbox.items, sent.items);
  const newestOut = sent.items[0];
  const all = [...inbox.items, ...sent.items];
  return {
    lastAt,
    ...(thread.length === 0 ? {} : { last: thread[thread.length - 1] as ThreadItem }),
    ...(newestOut?.status === undefined ? {} : { delivery: newestOut.status }),
    proofs: all.filter((m) => m.proof).length,
    files: all.reduce((n, m) => n + m.files.length, 0),
    pending: sent.items.some((m) => m.status === 'queued'),
  };
}

export type Loaded =
  | { readonly ok: true; readonly data: HomeData }
  | { readonly ok: false; readonly problem: Problem };

export interface PeopleApi {
  readonly messages: MessagesApi;
  load(): Promise<Loaded>;
  summary(person: Conversation): Promise<PersonSummary | undefined>;
}

export function createPeopleApi(api: ApiClient): PeopleApi {
  const messages = createMessagesApi(api);
  return {
    messages,
    async load() {
      const [people, contacts, received, sent] = await Promise.all([
        messages.conversations(),
        api.get<unknown>(LIST_PATH),
        api.get<unknown>(RECEIVED_LIST),
        api.get<unknown>(SENT_LIST),
      ]);
      if (!people.ok) return { ok: false, problem: people.problem };
      const list = contacts.kind === 'ok' ? parseList(contacts.data) : undefined;
      const rec = received.kind === 'ok' ? parseReceived(received.data) : undefined;
      const out = sent.kind === 'ok' ? parseSent(sent.data) : undefined;
      return {
        ok: true,
        data: {
          people: [...people.value].sort((a, b) => b.lastAt - a.lastAt),
          contacts: new Map(
            list?.kind === 'ok' ? list.contacts.map((c) => [c.ref, c] as const) : [],
          ),
          received: new Map((rec?.items ?? []).map((f) => [f.id, f] as const)),
          sent: new Map((out?.items ?? []).map((f) => [f.id, f] as const)),
        },
      };
    },
    async summary(person) {
      const [inbox, sent] = await Promise.all([
        messages.messages(person.contactId, 'in'),
        messages.messages(person.contactId, 'out'),
      ]);
      if (!inbox.ok || !sent.ok) return undefined;
      return summarize(person.lastAt, inbox.value, sent.value);
    },
  };
}
