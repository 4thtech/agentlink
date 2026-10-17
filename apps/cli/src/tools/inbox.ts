// `agentlink_inbox` (06 §2.2 `InboundMessage`/`OutboundMessage`, "Order and paging", "Read state";
// §2.1 accepted requests, D-72; §4; §6; M1-9p). Not read-only (06 §2.0): it processes stored
// envelopes and marks the returned inbound items read.
//
// 1. Inputs: `since` must be an RFC 3339 date or date-time; `contact` resolves like every `Contact`
//    argument (06 §2). The schema bounds `limit` to 1..100 and `before` to an envelope ID.
// 2. Sync: core `syncInbox` within 3 s (06 §6). A failed sync still answers from the store.
// 3. Page: the core's `inboxPage` (port in context.ts) takes the newest matching items, ends the page
//    before the item that would take the text result above 262 144 bytes (at least one item), marks
//    the returned inbound items read in the same store transaction, and lists them oldest first.
// 4. Items: every value a sender chose (and every value our own agent wrote) appears only inside the
//    item's §4 block and under its `untrusted` key, sanitized; the top level carries only ours (IDs,
//    enums, numbers, hashes, our dates, names under the 06 §2.1 rule). File URLs, file keys and
//    inline bytes are never read from the port item, so no result can carry them (zero access).
//
// 5. Open offers (M1-22): with `openOffers: true`, the page is exactly the received offers still
//    waiting for an answer (core `openOffers`, read after the sync), read ones included and no sent
//    items, so a fresh session finds an offer an earlier session already read. Each is wrapped like
//    any other inbound item.
//
// I-5, I-7: summaries and `nextStep` are fixed text with counts and names under the 06 §2.1 rule;
// logs carry counts only.
import { canonicalize, encodeUtf8 } from '@agentlink/crypto';
import { displayRef, renderRef, resolveContact, type ContactRef } from './contacts.js';
import type { InboxPageQuery, PageFile, PageItem, ToolContext } from './context.js';
import { fail, invalidArgument, ok, type HandlerOutput } from './result.js';
import { copy, UNTRUSTED_FOOTER } from './strings/index.js';
import { noOwnerCard } from './text.js';
import {
  removeInvisible,
  sanitizeUntrustedText,
  sanitizeUntrustedValue,
  untrustedBlock,
  untrustedText,
} from './untrusted.js';

/** 06 §2.2: the sync before reading, in milliseconds. */
export const INBOX_SYNC_BUDGET_MS = 3_000;
/** 06 §2.2: a page ends before the item that would take the text result above this many bytes. */
export const INBOX_MAX_TEXT_BYTES = 262_144;
/** 06 §2.2: `limit` defaults to 20. */
export const INBOX_DEFAULT_LIMIT = 20;

/** Fixed text (I-5). Slots take counts or names under the 06 §2.1 rule only. */
export const INBOX_TEXT = Object.freeze({
  someMessages: (count: number): string =>
    count === 1
      ? 'Here is 1 message. What other agents wrote is inside the untrusted blocks.'
      : `Here are ${count} messages. What other agents wrote is inside the untrusted blocks.`,
  noMatching: 'No messages match.',
  someOpenOffers: (count: number): string =>
    count === 1
      ? 'Here is 1 open offer waiting for an answer. What other agents wrote is inside the untrusted blocks.'
      : `Here are ${count} open offers waiting for an answer. What other agents wrote is inside the untrusted blocks.`,
  noOpenOffers: 'No open offers are waiting for an answer.',
  headerFrom: (contactName: string, ownerFingerprint: string): string =>
    `Message from ${contactName}, owner fingerprint ${ownerFingerprint}`,
  headerSent: (contactName: string): string => `You sent to ${contactName}`,
  beforeNotFound: "That before envelopeId isn't in this view, so nothing was read.",
  beforeNotFoundNextStep: 'Call agentlink_inbox without before to start from the newest messages.',
});

/** The block's `from` attribute for our own items and for accepted requests (06 §2.2, D-72). */
const FROM_YOU = 'you';
const FROM_UNKNOWN = 'unknown sender';

// ---- Inputs --------------------------------------------------------------------------------------

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2})))?$/;

/** An RFC 3339 date or date-time as unix seconds, or undefined when it is not one. */
export function parseSince(input: string): number | undefined {
  // RFC 3339 allows a lower-case `t` and `z` (IR-M1-9p-1 F05).
  const value = input.toUpperCase();
  const m = RFC3339.exec(value);
  if (m === null) return undefined;
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59 ||
    (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59))
  ) {
    return undefined;
  }
  const ms = Date.parse(m[4] === undefined ? `${value}T00:00:00Z` : value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** The last second with a four-digit RFC 3339 year: 9999-12-31T23:59:59Z. */
const MAX_RFC3339_SECONDS = 253_402_300_799;

/**
 * Unix seconds as RFC 3339 UTC, whole seconds: our format, never the sender's text. Total
 * (IR-M1-9p-1 F01): sender-chosen times are uint53 and unbounded on receipt, so anything that is not
 * a whole number of seconds from 1970 to 9999 gives undefined instead of throwing. The caller then
 * leaves the value out (or null); the sender's own value stays only inside the untrusted block.
 */
function isoOrUndefined(seconds: number): string | undefined {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_RFC3339_SECONDS) {
    return undefined;
  }
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `sentAt` is required: an out-of-range `createdAt` (core checks it on receipt) is clamped. */
const isoClamped = (seconds: number): string =>
  isoOrUndefined(
    Number.isFinite(seconds) ? Math.min(Math.max(Math.trunc(seconds), 0), MAX_RFC3339_SECONDS) : 0,
  ) ?? '1970-01-01T00:00:00Z';

// ---- Items ---------------------------------------------------------------------------------------

/** A file name or type as one line of the block (06 §4: sanitized, shown inside the block). */
const oneLine = (text: string): string => sanitizeUntrustedText(text).replace(/\n/g, ' ');

/** JCS text of an already-sanitized value, so the block shows exactly what `untrusted` holds. */
function jcs(value: unknown): string {
  try {
    return canonicalize(value);
  } catch {
    return '';
  }
}

interface Rendered {
  readonly message: Record<string, unknown>;
  readonly block: string;
}

function fileInfo(file: PageFile): Record<string, unknown> {
  // Built field by field: whatever else the port item carries (a URL, a key) never gets copied.
  return {
    index: file.index,
    size: file.size,
    plaintextSha256: file.plaintextSha256,
    delivery: file.delivery,
    expiresAt: file.expiresAt === null ? null : (isoOrUndefined(file.expiresAt) ?? null),
  };
}

/** The untrusted values of an item and the block content that shows them (06 §2.2 "The block"). */
function untrustedOf(item: PageItem): { untrusted: Record<string, unknown>; content: string } {
  const untrusted: Record<string, unknown> = {};
  let content = '';
  if (item.terms !== undefined) {
    const terms = sanitizeUntrustedValue(item.terms);
    untrusted['terms'] = terms;
    if (item.note !== undefined) {
      untrusted['note'] = item.note === null ? null : sanitizeUntrustedText(item.note);
    }
    content = jcs({ terms, note: untrusted['note'] ?? null });
  } else if (typeof item.body === 'string') {
    untrusted['text'] = sanitizeUntrustedText(item.body);
    content = untrusted['text'] as string;
  } else if (item.body !== null && typeof item.body === 'object') {
    untrusted['body'] = sanitizeUntrustedValue(item.body);
    content = jcs(untrusted['body']);
  }
  if (item.files.length > 0) {
    const names = item.files.map((f) => oneLine(f.name));
    const types = item.files.map((f) => oneLine(f.mime));
    untrusted['fileNames'] = names;
    untrusted['fileTypes'] = types;
    const lines = item.files.map(
      (f, i) => `File ${f.index}: ${names[i]} (${types[i]}, ${f.size} bytes)`,
    );
    content = [content, ...lines].filter((part) => part !== '').join('\n');
  }
  return { untrusted, content };
}

/**
 * `termsRef` (ours) only when its `validUntil` formats; otherwise it is left out and the sender's
 * value stays inside the block, under `untrusted.terms` (IR-M1-9p-1 F01).
 */
function termsRefOf(item: PageItem): Record<string, unknown> {
  if (item.termsRef === undefined) return {};
  const validUntil = isoOrUndefined(item.termsRef.validUntil);
  if (validUntil === undefined) return {};
  return {
    termsRef: {
      termsId: item.termsRef.termsId,
      version: item.termsRef.version,
      termsHash: item.termsRef.termsHash,
      validUntil,
    },
  };
}

function render(item: PageItem): Rendered {
  const { untrusted, content } = untrustedOf(item);
  const base: Record<string, unknown> = {
    direction: item.direction,
    envelopeId: item.envelopeId,
    thread: item.thread,
    type: item.type,
    sentAt: isoClamped(item.createdAt),
    replyTo: item.replyTo,
    files: item.files.map(fileInfo),
    ...termsRefOf(item),
  };
  let header: string;
  let from: string;
  let extra: Record<string, unknown>;
  if (item.direction === 'out') {
    const ref: ContactRef = displayRef(item.to.contactId, item.to.display);
    header = INBOX_TEXT.headerSent(renderRef(ref));
    from = FROM_YOU;
    extra = { contact: ref, delivery: item.delivery };
  } else if (item.from === null) {
    const senderCode = item.senderCode ?? '';
    header = copy('chat.inbox.requestHeader', { senderCode });
    from = FROM_UNKNOWN;
    extra = { contact: null, senderCode, read: item.read };
  } else {
    const ref = displayRef(item.from.contactId, item.from.display);
    header = INBOX_TEXT.headerFrom(renderRef(ref), removeInvisible(item.from.ownerFingerprint));
    // The self-declared name: only here, as the escaped `from` attribute (06 §2.1, §4).
    from = item.from.declaredName;
    extra = { contact: ref, read: item.read };
  }
  const block = untrustedBlock({
    header,
    from,
    envelope: item.envelopeId,
    type: item.type,
    content,
  });
  return { message: { ...base, ...extra, untrusted, block }, block };
}

// ---- The handler ---------------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function inboxHandler(input: unknown, context: ToolContext): Promise<HandlerOutput> {
  if (!isPlainObject(input)) return invalidArgument();
  const { contact, since, limit, includeRead, includeSent, before, openOffers } = input;
  const offersOnly = openOffers === true;
  const sinceSeconds = typeof since === 'string' ? parseSince(since) : undefined;
  if (since !== undefined && sinceSeconds === undefined) return invalidArgument();

  const { client, logger } = context;
  if ((await client.self()) === undefined) {
    return fail(
      'needs_setup',
      noOwnerCard(context.agentName).summary,
      noOwnerCard(context.agentName).nextStep,
    );
  }

  let contactId: string | undefined;
  if (typeof contact === 'string') {
    const resolved = resolveContact(contact, await client.contacts());
    if (!resolved.ok) return resolved.output;
    contactId = resolved.contact.id;
  }

  try {
    await client.syncInbox(INBOX_SYNC_BUDGET_MS);
  } catch {
    // Offline or no relay: the stored items still answer. The error text is never logged (I-5).
    logger.info('inbox sync unavailable; stored items used');
  }

  // After the sync, so offers it just processed count. A failed read lists none (fail closed).
  let offerIds: string[] | undefined;
  if (offersOnly) {
    offerIds = [];
    try {
      for (const offer of (await client.openOffers?.()) ?? []) {
        if (contactId === undefined || offer.contactId === contactId)
          offerIds.push(offer.envelopeId);
      }
    } catch {
      logger.info('inbox open offers unavailable');
    }
  }

  const rendered = new WeakMap<PageItem, Rendered>();
  const renderOnce = (item: PageItem): Rendered => {
    let out = rendered.get(item);
    if (out === undefined) {
      out = render(item);
      rendered.set(item, out);
    }
    return out;
  };
  const filtered =
    contactId !== undefined ||
    sinceSeconds !== undefined ||
    before !== undefined ||
    includeRead === true ||
    includeSent === true ||
    offersOnly;
  const query: InboxPageQuery = {
    ...(contactId === undefined ? {} : { contactId }),
    ...(sinceSeconds === undefined ? {} : { since: sinceSeconds }),
    ...(typeof before === 'string' ? { before } : {}),
    limit: typeof limit === 'number' ? limit : INBOX_DEFAULT_LIMIT,
    includeRead: offersOnly || includeRead === true,
    includeSent: !offersOnly && includeSent === true,
    ...(offerIds === undefined ? {} : { envelopeIds: offerIds.slice(0, 100) }),
    // Each block plus the line break that joins it to the next block or to the footer.
    sizeOf: (item) => encodeUtf8(renderOnce(item).block).length + 1,
    maxBytes: INBOX_MAX_TEXT_BYTES - encodeUtf8(UNTRUSTED_FOOTER).length,
  };
  const page = await client.inboxPage(query);
  if (page.status === 'before_not_found') {
    return fail('not_found', INBOX_TEXT.beforeNotFound, INBOX_TEXT.beforeNotFoundNextStep);
  }

  const items = page.items.map(renderOnce);
  const requestsLine =
    page.requests > 0 ? [copy('chat.inbox.requestsWaiting', { count: page.requests })] : [];
  const first = offersOnly
    ? items.length > 0
      ? INBOX_TEXT.someOpenOffers(items.length)
      : INBOX_TEXT.noOpenOffers
    : items.length > 0
      ? INBOX_TEXT.someMessages(items.length)
      : filtered
        ? INBOX_TEXT.noMatching
        : copy('chat.session.nothingNew');
  const summary = [first, ...requestsLine].join(' ');
  const hasRequest = page.items.some((item) => item.direction === 'in' && item.from === null);
  logger.info('inbox read', { messages: items.length, requests: page.requests });

  const fields = {
    messages: items.map((item) => item.message),
    requests: page.requests,
    ...(hasRequest ? { nextStep: copy('chat.inbox.requestNextStep') } : {}),
  };
  const output = ok(summary, fields);
  return items.length === 0
    ? output
    : { ...output, text: untrustedText(items.map((item) => item.block)) };
}
