// M1-11c-a1: the Activity page's API (08 §1; 11 §6.2; D-118; I-4, I-5).
//
// `GET /api/ui/activity?limit=&cursor=`: one page of core's activity feed (`ActivityService.list`,
// newest first) through the read-only client view. A read: no presence, nothing changes.
//
// What leaves the server is an allowlist per kind: the time, the kind and the display fields the
// page needs. Row, record and approval IDs, rule versions, tool names and the proof network stay
// here (UX north star: no IDs, hashes or networks in the default view). An entry of an unknown kind,
// or with a value outside its allowlist, is left out (fail closed). Core's entries carry no inbound
// text (activity.ts), and the page renders every value as text only (I-5).
//
// UX1113 WP-A1 (design-1112 spec §7): a contact is sent as a reference, `contactId` (its agent ID,
// `0x` + 40 lowercase hex, as the contacts route names it), which the page resolves to the shown
// name with its own people read; never a display name. A decided approval adds what it was about:
// `action` (one of ACTION_TYPES), `contactId`, `files` (`{name, size}`, the sanitized names the
// owner's AI gave) and `costUsd` (the fee the rules evaluated). The action is checked whole: one
// value outside its allowlist drops all of it, and the entry stays a plain decision. A proof adds
// `contactId` and, once charged, `costUsd`. New kinds: contact_connected (`via`), contact_removed,
// contact_revoked, id_created, id_removed, id_paused, id_resumed, id_renamed (`name`, the owner's
// own label), app_connected and app_disconnected (`app`, an id of the 06 §7 table), backup_saved.
// An optional field outside its allowlist is left out; a people entry without a valid reference is
// left out whole.
//
// UX1113-QA2-ACTIVITY (QA finding N7): contact_blocked may come with no reference (a block core lists
// from its owner action after the contact was unblocked or removed): sent without `contactId`; a
// reference that is present but not one still drops it. New kinds contact_unblocked and
// contact_checked (`contactId` when it is a reference). id_created may name the ID (`name`, the
// owner's own label, as for id_renamed).
//
// Frozen response shape for the page (WP-A2): `{items: Item[], nextCursor?: string}`, each Item
// `{kind, at}` plus, by kind:
//   approval_decided   decision; action?, contactId?, files?, costUsd?
//   proof              direction, state; contactId?, costUsd?
//   sender_blocked     senderCode
//   contact_blocked    contactId?   (QA2: none for a block listed from its owner action)
//   contact_unblocked, contact_checked   contactId?
//   contact_renamed    contactId, formerName, newName
//   contact_connected  contactId; via? ('your_invite' | 'their_invite')
//   contact_removed    contactId
//   contact_revoked    contactId
//   invite_answered_twice   contactId   (R1-SEC-03, 04 §3.6: the contact the invite connected)
//   rules_changed      (nothing more)
//   id_created         name?
//   id_removed, id_paused, id_resumed, backup_saved   (nothing more)
//   id_renamed         name?
//   app_connected, app_disconnected   app?
import {
  CoreError,
  type ActivityEntry,
  type ApprovalDecision,
  type PageQuery,
} from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import { AI_APP_IDS, MAX_FILES_PER_PAYLOAD, isUsdAmount } from '@4thtech-io/types';
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

/** WP-A1: a contact reference, the contact's agent ID as the contacts route names it (04 §2.9). */
const CONTACT_REF = /^0x[0-9a-f]{40}$/;
/** WP-A1: what a decided approval was about (core activity.ts ActivityActionType). */
const ACTION_TYPES: ReadonlySet<string> = new Set([
  'send_message',
  'send_file',
  'add_proof',
  'accept_invite',
  'offer_terms',
  'accept_terms',
  'reject_terms',
  'counter_terms',
  'accept_record',
  'reject_record',
  'share_proof_key',
]);
const CONNECTED_VIA: ReadonlySet<string> = new Set(['your_invite', 'their_invite']);
const APPS: ReadonlySet<string> = new Set(AI_APP_IDS);
/** sanitizeFileName's bound: at most 255 UTF-8 bytes, so at most 255 UTF-16 code units. */
const MAX_FILE_NAME = 255;
/** The agent label's bound (owner-action agentLabelParamsSchema: at most 32 code points). */
const MAX_ID_NAME_CODE_POINTS = 32;
/** Control, format (bidi and invisible) and separator characters other than a plain space. */
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const FILE_NAME_FORBIDDEN = /[/\\]/;

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isContactRef = (v: unknown): v is string => typeof v === 'string' && CONTACT_REF.test(v);

/** One file of an approval's action, or undefined when it is not exactly `{name, size}` and plain. */
function fileView(file: unknown): JsonObject | undefined {
  if (!isRecord(file)) return undefined;
  const keys = Object.keys(file);
  if (keys.length !== 2 || !Object.hasOwn(file, 'name') || !Object.hasOwn(file, 'size')) {
    return undefined;
  }
  const { name, size } = file;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_FILE_NAME)
    return undefined;
  if (NOT_PLAIN.test(name) || FILE_NAME_FORBIDDEN.test(name) || name.startsWith('.')) {
    return undefined;
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return undefined;
  return { name, size };
}

/** WP-A1: an approval's action fields, or undefined to send none of them. */
function actionView(action: unknown): JsonObject | undefined {
  if (!isRecord(action)) return undefined;
  const { type, contactId, files, feeUsd } = action;
  if (typeof type !== 'string' || !ACTION_TYPES.has(type)) return undefined;
  if (contactId !== null && !isContactRef(contactId)) return undefined;
  if (feeUsd !== null && !isUsdAmount(feeUsd)) return undefined;
  if (!Array.isArray(files) || files.length > MAX_FILES_PER_PAYLOAD) return undefined;
  const shownFiles: JsonObject[] = [];
  for (const file of files as unknown[]) {
    const shown = fileView(file);
    if (shown === undefined) return undefined;
    shownFiles.push(shown);
  }
  return {
    action: type,
    ...(contactId === null ? {} : { contactId }),
    ...(shownFiles.length === 0 ? {} : { files: shownFiles }),
    ...(feeUsd === null ? {} : { costUsd: feeUsd }),
  };
}

/** WP-A1: the owner's own ID label, or undefined when it is not short plain text. */
function idName(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.length === 0 || NOT_PLAIN.test(name)) return undefined;
  return Array.from(name).length <= MAX_ID_NAME_CODE_POINTS ? name : undefined;
}

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
    case 'approval_decided': {
      if (!DECISIONS.has(entry.decision)) return undefined;
      const action = actionView((entry as { action?: unknown }).action);
      return { kind: entry.kind, at, decision: entry.decision, ...action };
    }
    case 'proof': {
      const state = Object.hasOwn(PROOF_STATE, entry.status)
        ? PROOF_STATE[entry.status]
        : undefined;
      if (state === undefined) return undefined;
      if (entry.direction !== 'sent' && entry.direction !== 'received') return undefined;
      const contact: unknown = isRecord(entry.contact) ? entry.contact.id : undefined;
      const cost: unknown = entry.cost;
      const usd = isRecord(cost) && cost.kind === 'charged' ? cost.usd : undefined;
      return {
        kind: entry.kind,
        at,
        direction: entry.direction,
        state,
        ...(isContactRef(contact) ? { contactId: contact } : {}),
        ...(isUsdAmount(usd) ? { costUsd: usd } : {}),
      };
    }
    case 'sender_blocked':
      return typeof entry.senderCode === 'string' && SENDER_CODE.test(entry.senderCode)
        ? { kind: entry.kind, at, senderCode: entry.senderCode }
        : undefined;
    case 'contact_blocked':
      // QA2: no reference (null) is a block listed from its owner action; anything else must be one.
      if (entry.contactId === null) return { kind: entry.kind, at };
      return isContactRef(entry.contactId)
        ? { kind: entry.kind, at, contactId: entry.contactId }
        : undefined;
    case 'contact_unblocked':
    case 'contact_checked':
      return {
        kind: entry.kind,
        at,
        ...(isContactRef(entry.contactId) ? { contactId: entry.contactId } : {}),
      };
    case 'contact_removed':
    case 'contact_revoked':
    case 'invite_answered_twice':
      return isContactRef(entry.contactId)
        ? { kind: entry.kind, at, contactId: entry.contactId }
        : undefined;
    case 'contact_connected': {
      if (!isContactRef(entry.contactId)) return undefined;
      const via: unknown = entry.via;
      return {
        kind: entry.kind,
        at,
        contactId: entry.contactId,
        ...(typeof via === 'string' && CONNECTED_VIA.has(via) ? { via } : {}),
      };
    }
    case 'id_created': {
      const name = idName(entry.name);
      return { kind: entry.kind, at, ...(name === undefined ? {} : { name }) };
    }
    case 'rules_changed':
    case 'id_removed':
    case 'id_paused':
    case 'id_resumed':
    case 'backup_saved':
      return { kind: entry.kind, at };
    case 'id_renamed': {
      const name = idName(entry.name);
      return { kind: entry.kind, at, ...(name === undefined ? {} : { name }) };
    }
    case 'app_connected':
    case 'app_disconnected': {
      const app: unknown = entry.app;
      return {
        kind: entry.kind,
        at,
        ...(typeof app === 'string' && APPS.has(app) ? { app } : {}),
      };
    }
    case 'contact_renamed': {
      // W4-RENAME-REACHES-CONTACTS (D-141): "{formerName} is now called {newName}", both as core
      // restricted them (06 §2.1), short plain text only; never a raw name.
      const plain = (name: unknown): name is string =>
        typeof name === 'string' && name.length > 0 && name.length <= MAX_RENAMED_CHARS;
      if (!plain(entry.formerName) || !plain(entry.newName)) return undefined;
      if (!isContactRef(entry.contactId)) return undefined;
      return {
        kind: entry.kind,
        at,
        contactId: entry.contactId,
        formerName: entry.formerName,
        newName: entry.newName,
      };
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
