// The inbox as the core returns it (M1-7h; 07 §2 `syncInbox`; 06 §2.1, §2.2, §4; 02 F-21).
//
// - Items are a contact's processed envelopes (`state = ok`, `direction = in`) of a message type,
//   each with the metadata the untrusted-content wrapper needs (06 §4): the sender under the 06 §2.1
//   contact-name rule (an owner alias, or the restricted name) with its identity label (11 §5.2),
//   the short owner fingerprint, and the self-declared name for the block's `from` attribute only.
//   The label comes from the stored contact, never from the name, and is never "verified" alone.
// - Counts (`counts`) read the store only. They serve the fetch-only catch-up (M1-7h addendum,
//   D-73): unread is the contact's unread messages of the types an inbox page returns (PAGE_TYPES) plus the `received` rows whose verified `from` is
//   that contact's current agent key, so a catch-up can count what it fetched without processing it
//   (06 §2.0). Unknown senders are a count only.
//
// I-5: payloads are untrusted and returned only as data for the wrapper; nothing from them reaches a
// log line or an error. I-7: logs carry counts only.
import { parseJson } from '@4thtech-io/crypto';
import { payloadSchema, type ContactDisplayName, type Payload } from '@4thtech-io/types';
import type { ContactBook, ContactView } from './contacts.js';
import { open, type CoreContext } from './context.js';
import {
  PAGE_TYPES,
  dropOriginsOf,
  readInboxPage,
  type InboxPage,
  type InboxPageQuery,
} from './inbox-page.js';
import type { RequestsQueue } from './requests.js';

export {
  INBOX_PAGE_MAX_LIMIT,
  PAGE_TYPES,
  type InboundPageItem,
  type InboxPage,
  type InboxPageFile,
  type InboxPageItem,
  type InboxPageQuery,
  type InboxTermsRef,
  type OutboundPageItem,
} from './inbox-page.js';

/** Types shown in the inbox: the user message types (02 F-22, D-55) and the follow-ups to them. */
export const INBOX_TYPES: readonly string[] = Object.freeze([
  'text',
  'note',
  'request',
  'delivery',
  'offer',
  'accept',
  'reject',
  'file',
  'proof',
]);

/** Who sent an inbox item, as the untrusted-content wrapper shows it (06 §2.1, §4). */
export interface InboxSender {
  /** The contact's agent ID (04 §2.9). */
  readonly contactId: string;
  /**
   * For everything outside the untrusted block: an owner alias or the restricted name, with its
   * identity label (11 §5.2). Render with renderContactName.
   */
  readonly display: ContactDisplayName;
  /** The short owner fingerprint (`7F3A·19C2`): identifies, never authenticates (04 §2.9). */
  readonly ownerFingerprint: string;
  /** True only while the owner's `contact.check` verifies (04 §3.6.1). Never named "verified". */
  readonly safetyCodeChecked: boolean;
  /**
   * The name as the contact declared it. Untrusted (I-5): only for the untrusted block's `from`
   * attribute, escaped as 06 §4 specifies, never anywhere else.
   */
  readonly declaredName: string;
}

/** One inbound message from a contact (06 §2.2 `InboundMessage`, before the MCP wrapper). */
export interface InboxItem {
  readonly envelopeId: string;
  readonly thread: string;
  readonly type: string;
  /** The envelope's `createdAt` (sender-chosen, within the freshness window of 04 §3.1.1). */
  readonly createdAt: number;
  readonly read: boolean;
  readonly from: InboxSender;
  /** Untrusted (I-5): the decrypted payload, for the inside of the untrusted block only. */
  readonly payload: Payload;
}

/** Unread counts by contact, from the store alone (06 §2.0, §2.1 `agentlink_status`). */
export interface InboxCounts {
  /** Paired contacts with something unread, by contact ID. Counts only, never content. */
  readonly inbox: readonly { readonly contactId: string; readonly unread: number }[];
  /** The requests queue (unknown senders, 02 F-65): a count only. */
  readonly requests: number;
}

const senderOf = (view: ContactView): InboxSender => ({
  contactId: view.id,
  display: view.display,
  ownerFingerprint: view.ownerFingerprint.short,
  safetyCodeChecked: view.safetyCodeChecked,
  declaredName: view.name.value,
});

export class InboxService {
  readonly #ctx: CoreContext;
  readonly #contacts: ContactBook;
  readonly #requests: RequestsQueue;
  readonly #dropOrigins: ReadonlySet<string>;

  constructor(
    ctx: CoreContext,
    contacts: ContactBook,
    requests: RequestsQueue,
    options: { readonly dropOrigins?: readonly string[] } = {},
  ) {
    this.#ctx = ctx;
    this.#contacts = contacts;
    this.#requests = requests;
    this.#dropOrigins = dropOriginsOf(options.dropOrigins);
  }

  /**
   * One `agentlink_inbox` page with its read marks (M1-7h-c; 06 §2.2): received messages, accepted
   * requests (D-72) and, with `includeSent`, our own sent messages, newest `limit` first and listed
   * oldest first. The returned unread inbound items are marked read in the store transaction that
   * commits the page (inbox-page.ts). Throws `inbox_query_invalid` for a malformed query.
   */
  page(query: InboxPageQuery): Promise<InboxPage> {
    return readInboxPage(
      { ctx: this.#ctx, contacts: this.#contacts, dropOrigins: this.#dropOrigins },
      query,
    );
  }

  /**
   * The inbox items among `envelopeIds`, in the order given. An ID that is not a contact's
   * processed message (another state or type, a request, an outbound row) is left out. A row whose
   * payload cannot be read is left out and counted in the log (07 §3.1, fail closed).
   */
  async items(envelopeIds: readonly string[]): Promise<InboxItem[]> {
    const ids = [...new Set(envelopeIds)];
    const rows = await this.#ctx.store.transaction((tx) =>
      ids
        .map((envelopeId) => tx.get('envelopes', { envelope_id: envelopeId }))
        .filter(
          (row) =>
            row !== undefined &&
            row.direction === 'in' &&
            row.state === 'ok' &&
            row.contact_id !== null &&
            row.payload_json !== null &&
            INBOX_TYPES.includes(row.type),
        ),
    );
    const senders = new Map<string, InboxSender | undefined>();
    const out: InboxItem[] = [];
    let unreadable = 0;
    for (const row of rows) {
      if (row === undefined || row.contact_id === null || row.payload_json === null) continue;
      const contactId = row.contact_id;
      if (!senders.has(contactId)) {
        senders.set(contactId, await this.#contacts.get(contactId).then(senderOf, () => undefined));
      }
      const from = senders.get(contactId);
      let payload: Payload | undefined;
      try {
        const text = await open(
          this.#ctx,
          'envelopes',
          'payload_json',
          [row.envelope_id],
          row.payload_json,
        );
        const parsed = payloadSchema.safeParse(parseJson(text));
        payload = parsed.success ? parsed.data : undefined;
      } catch {
        payload = undefined;
      }
      if (from === undefined || payload === undefined || payload.type !== row.type) {
        unreadable += 1;
        continue;
      }
      out.push({
        envelopeId: row.envelope_id,
        thread: row.thread_id,
        type: row.type,
        createdAt: row.created_at,
        read: row.read_at !== null,
        from,
        payload,
      });
    }
    if (unreadable > 0) this.#ctx.log.warn('inbox rows unreadable', { rows: unreadable });
    return out;
  }

  /**
   * Unread counts by paired contact and the requests count, from the store alone: no envelope is
   * opened or processed and nothing is written (06 §2.0). A `received` row counts for the contact
   * whose current agent key signed it (its signature passed 04 §3.1.1 step 4 when it was stored);
   * its type is not known until it is processed, so it counts as one unread item.
   *
   * A processed row counts only if the inbox page can return it (PAGE_TYPES, M1-9p-b;
   * IR-M1-7h-c-1): a `proof` or another type the page never returns would otherwise leave an unread
   * count that no inbox read clears.
   */
  async counts(): Promise<InboxCounts> {
    const inbox = await this.#ctx.store.transaction((tx) => {
      const out: { contactId: string; unread: number }[] = [];
      const contacts = tx.select(
        'contacts',
        { status: 'active', pairing: 'complete' },
        { orderBy: [['contact_id', 'asc']] },
      );
      for (const contact of contacts) {
        const unread =
          tx.count('envelopes', {
            direction: 'in',
            contact_id: contact.contact_id,
            state: 'ok',
            read_at: null,
            type: { in: [...PAGE_TYPES] },
          }) +
          tx.count('envelopes', {
            direction: 'in',
            state: 'received',
            from_key: contact.agent_nostr,
            // A terms offer waiting for a version it links to is not unread until the chain
            // takes it (M1-32-b, IR-M1-32-b-1 F01).
            refused_reason: null,
          });
        if (unread > 0) out.push({ contactId: contact.contact_id, unread });
      }
      return out;
    });
    return { inbox, requests: await this.#requests.count() };
  }
}
