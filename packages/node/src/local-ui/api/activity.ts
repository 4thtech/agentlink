// M1-11c-a1: the Activity page's API (08 §1; 11 §6.2; D-118; I-4, I-5).
//
// `GET /api/ui/activity?limit=&cursor=`: one page of core's activity feed (`ActivityService.list`,
// newest first) through the read-only client view. A read: no presence, nothing changes.
//
// What leaves the server is an allowlist per kind: the time, the kind and the display fields the
// page needs. Row, record, approval and contact IDs, rule versions and the proof network stay here
// (UX north star: no IDs, hashes or networks in the default view). An entry of an unknown kind, or
// with a value outside its allowlist, is left out (fail closed). Core's entries carry no inbound
// text (activity.ts), and the page renders every value as text only (I-5).
import {
  CoreError,
  type ActivityEntry,
  type ApprovalDecision,
  type PageQuery,
} from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import type { LocalUiReadRoute, LocalUiResult } from '../route-types.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const LIMIT = /^[1-9][0-9]{0,2}$/;
const MAX_CURSOR = 256;
// 04 §2.9: short (`2B9E·04D1`) or extended (`2B9E·04D1·5D0E·88B1`) sender code.
const SENDER_CODE = /^[0-9A-F]{4}(?:·[0-9A-F]{4}){1,3}$/;
const DECISIONS: ReadonlySet<ApprovalDecision> = new Set([
  'approved',
  'approved_by_rules',
  'denied',
  'cancelled',
]);

/** The page's proof state for each core proof status (proofs/service.ts LISTED_PROOF_STATUSES). */
const PROOF_STATE: Readonly<Record<string, string>> = Object.freeze({
  signed: 'submitted',
  pending: 'submitted',
  needs_credits: 'needs_credits',
  failed: 'failed',
  conflict: 'failed',
  released: 'failed',
  recorded: 'recorded',
  announced: 'recorded',
  received: 'received',
});

/** D-141: the longest name a rename entry carries (restricted names are at most 32 code points). */
const MAX_RENAMED_CHARS = 128;

const result = (status: number, body: JsonObject): LocalUiResult => Object.freeze({ status, body });
const invalidQuery = (): LocalUiResult => result(400, { error: 'invalid_query' });

/** The page query, or undefined when it is malformed (one value each, limit 1 to 100). */
function pageQuery(query: URLSearchParams): PageQuery | undefined {
  const limits = query.getAll('limit');
  const cursors = query.getAll('cursor');
  if (limits.length > 1 || cursors.length > 1) return undefined;
  let limit = DEFAULT_LIMIT;
  const rawLimit = limits[0];
  if (rawLimit !== undefined) {
    if (!LIMIT.test(rawLimit)) return undefined;
    limit = Number(rawLimit);
    if (limit > MAX_LIMIT) return undefined;
  }
  const cursor = cursors[0];
  if (cursor === undefined) return { limit };
  if (cursor.length === 0 || cursor.length > MAX_CURSOR) return undefined;
  return { limit, cursor };
}

/** One entry as the page sees it, or undefined to leave it out. */
function view(entry: ActivityEntry): JsonObject | undefined {
  const { at } = entry as { at: unknown };
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined;
  switch (entry.kind) {
    case 'approval_decided':
      return DECISIONS.has(entry.decision)
        ? { kind: entry.kind, at, decision: entry.decision }
        : undefined;
    case 'proof': {
      const state = Object.hasOwn(PROOF_STATE, entry.status)
        ? PROOF_STATE[entry.status]
        : undefined;
      if (state === undefined) return undefined;
      if (entry.direction !== 'sent' && entry.direction !== 'received') return undefined;
      return { kind: entry.kind, at, direction: entry.direction, state };
    }
    case 'sender_blocked':
      return typeof entry.senderCode === 'string' && SENDER_CODE.test(entry.senderCode)
        ? { kind: entry.kind, at, senderCode: entry.senderCode }
        : undefined;
    case 'contact_blocked':
    case 'rules_changed':
      return { kind: entry.kind, at };
    case 'contact_renamed': {
      // W4-RENAME-REACHES-CONTACTS (D-141): "{formerName} is now called {newName}", both as core
      // restricted them (06 §2.1), short plain text only; never a raw name.
      const plain = (name: unknown): name is string =>
        typeof name === 'string' && name.length > 0 && name.length <= MAX_RENAMED_CHARS;
      if (!plain(entry.formerName) || !plain(entry.newName)) return undefined;
      return { kind: entry.kind, at, formerName: entry.formerName, newName: entry.newName };
    }
    default:
      return undefined;
  }
}

const listActivity: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: '/api/ui/activity',
  presence: false,
  handler: async (context, request) => {
    const query = pageQuery(request.query);
    if (query === undefined) return invalidQuery();
    const client = context.client;
    if (client === undefined) return result(409, { error: 'not_set_up' });
    try {
      const page = await client.listActivity(query);
      const items: JsonObject[] = [];
      for (const entry of page.items) {
        const shown = view(entry);
        if (shown !== undefined) items.push(shown);
      }
      return result(
        200,
        page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor },
      );
    } catch (error) {
      // No error text leaves the server: it could name a path or a store detail.
      if (error instanceof CoreError && error.code === 'page_query_invalid') return invalidQuery();
      return result(500, { error: 'failed' });
    }
  },
});

export const activityRoutes: readonly LocalUiReadRoute[] = Object.freeze([listActivity]);
