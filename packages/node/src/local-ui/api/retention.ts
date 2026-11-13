// RET-6 (S2; D-148; 04 §4.2 "Retention policy"; 06 §3 `history`; 08 §1; D-118; I-4, I-7):
// Settings › Storage › "Keep automatically".
//
// - `GET /api/ui/storage/retention` (read, `presence: false`): the `history.*` values in force (a
//   policy signed before D-148 reads as keep forever), the policy version, and whether they are in
//   force (`active`: only a verified owner-signed policy runs the pass). With exactly `?messages=&
//   files=` (each from the 06 §3 list) it adds what those values would remove now: counts and
//   stored bytes from core's preview, which plans and deletes nothing.
// - `POST /api/ui/storage/retention` (`presence: true`): the input is exactly `{base,
//   messagesKeepDays, filesKeepDays}`. Core prepares the complete `policy.set` for the patch
//   `{history}` on the version the page read (`base`); the server refuses before signing when the
//   values are off the lists, a key is missing or extra, the base is stale, or the prepared document
//   differs from the policy in force anywhere but `history` (a warning or the D-109 receipts question
//   means the edit would change another rule: that is the Rules page's). Then the owner's one gesture
//   signs exactly that body and core's `apply` verifies the signature (I-4).
//
// No MCP tool reaches either route (I-4). Fixed answers only: never an error's text or an input value.
import type { EffectivePolicy, PreparedPolicyEdit } from '@4thtech-io/core';
import { canonicalize, type JsonObject, type JsonValue } from '@4thtech-io/crypto';
import {
  HISTORY_FILES_KEEP_DAYS,
  HISTORY_PRE_D148,
  HISTORY_MESSAGES_KEEP_DAYS,
  historyOf,
  historySchema,
  type Policy,
} from '@4thtech-io/types';
import type { LocalUiContext } from '../context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
  LocalUiRequest,
  LocalUiResult,
  LocalUiRoute,
} from '../route-types.js';
import { UI_INVALID_QUERY, UI_NOT_SET_UP, UI_UNAVAILABLE } from '../route-types.js';

export const RETENTION_PATH = '/api/ui/storage/retention';

const answer = (status: number, body: JsonObject): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze(body) });

/** A handler that refuses before signing: the gate answers 409 `refused` whatever this says. */
const NOT_SIGNED = answer(409, { error: 'refused' });
/** The rules changed since the page read them. */
const STALE = answer(409, { error: 'stale' });
/** Signed, but core did not apply it. */
const NOT_SAVED = answer(409, { error: 'not_saved' });

/** What the owner's presence prompt shows (fixed text, I-5; the page was the review). */
const REVIEW_LINES = Object.freeze([
  'Change how long AgentLink keeps your history on this computer.',
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One query value from a fixed list, or undefined. */
function dayValue(raw: string | undefined, list: readonly number[]): number | undefined {
  if (raw === undefined || !/^(0|[1-9][0-9]{0,3})$/.test(raw)) return undefined;
  const n = Number(raw);
  return list.includes(n) ? n : undefined;
}

/** `?messages=&files=` as a keep value; null when absent; undefined when malformed. */
function previewQuery(
  query: URLSearchParams,
): { messagesKeepDays: number; filesKeepDays: number } | null | undefined {
  const keys = [...query.keys()];
  if (keys.length === 0) return null;
  if (keys.length !== 2 || query.getAll('messages').length !== 1) return undefined;
  if (query.getAll('files').length !== 1) return undefined;
  const messagesKeepDays = dayValue(query.get('messages') ?? undefined, HISTORY_MESSAGES_KEEP_DAYS);
  const filesKeepDays = dayValue(query.get('files') ?? undefined, HISTORY_FILES_KEEP_DAYS);
  if (messagesKeepDays === undefined || filesKeepDays === undefined) return undefined;
  return { messagesKeepDays, filesKeepDays };
}

const n = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;

async function readRetention(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return UI_NOT_SET_UP;
  const wanted = previewQuery(request.query);
  if (wanted === undefined) return UI_INVALID_QUERY;
  let effective: EffectivePolicy;
  try {
    effective = await client.policy.load();
  } catch {
    return UI_UNAVAILABLE;
  }
  if (effective.mode === 'fail_closed') return answer(200, { status: 'not_valid' });
  // IR-RET-67-1 Medium 2: on the defaults nothing runs and a first edit signs keep forever.
  const keep = historySchema.safeParse(
    effective.mode === 'signed' ? historyOf(effective.policy as Policy) : HISTORY_PRE_D148,
  );
  if (!keep.success) return answer(200, { status: 'not_valid' });
  const body: Record<string, JsonValue> = {
    status: 'ok',
    version: effective.mode === 'signed' ? effective.version : 0,
    active: effective.mode === 'signed',
    keep: {
      messagesKeepDays: keep.data.messagesKeepDays,
      filesKeepDays: keep.data.filesKeepDays,
    },
  };
  if (wanted !== null) {
    const retention = client.retention;
    if (retention === undefined) return UI_UNAVAILABLE;
    try {
      const preview = await retention.preview(wanted);
      body['preview'] = {
        messages: { count: n(preview.messages.count), bytes: n(preview.messages.bytes) },
        files: { count: n(preview.files.count), bytes: n(preview.files.bytes) },
        truncated: preview.truncated === true,
      };
    } catch {
      return UI_UNAVAILABLE;
    }
  }
  return answer(200, body);
}

/** The input, when it is exactly `{base, messagesKeepDays, filesKeepDays}` with listed values. */
function checkInput(
  input: JsonValue | undefined,
): { base: number; messagesKeepDays: number; filesKeepDays: number } | undefined {
  if (!isObject(input)) return undefined;
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'base,filesKeepDays,messagesKeepDays') return undefined;
  const { base, messagesKeepDays, filesKeepDays } = input;
  if (typeof base !== 'number' || !Number.isSafeInteger(base) || base < 0) return undefined;
  const parsed = historySchema.safeParse({ messagesKeepDays, filesKeepDays });
  if (!parsed.success) return undefined;
  return { base, ...parsed.data };
}

/**
 * True when `next` is `current` with only `history` changed. A section core fills on every new
 * `policy.set` (`files.autoSave`, D-142) may appear where `current` had none.
 */
function onlyHistoryChanged(current: Policy, next: Policy): boolean {
  const strip = (p: Policy, fillFrom?: Policy): JsonObject => {
    const copy = JSON.parse(JSON.stringify(p)) as Record<string, Record<string, unknown>>;
    delete copy['history'];
    const files = copy['files'];
    if (fillFrom !== undefined && files !== undefined && files['autoSave'] === undefined) {
      files['autoSave'] = (fillFrom.files as { autoSave?: unknown }).autoSave;
    }
    return copy as unknown as JsonObject;
  };
  return canonicalize(strip(current, next)) === canonicalize(strip(next));
}

async function saveRetention(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return NOT_SIGNED;
  const input = checkInput(request.input);
  if (input === undefined) return NOT_SIGNED;
  let effective: EffectivePolicy;
  let prepared: PreparedPolicyEdit;
  try {
    effective = await client.policy.load();
    if (effective.mode === 'fail_closed') return NOT_SIGNED;
    prepared = await client.policy.prepareEdit(
      { history: { messagesKeepDays: input.messagesKeepDays, filesKeepDays: input.filesKeepDays } },
      { baseVersion: input.base },
    );
  } catch {
    return NOT_SIGNED;
  }
  if (prepared.status !== 'prepared') {
    return prepared.reason === 'stale_version' ? STALE : NOT_SIGNED;
  }
  // Anything but history would change (a warning, the D-109 receipts question): not this page's.
  if (prepared.warnings.length > 0 || prepared.askKeepDeliveryReceipts) return NOT_SIGNED;
  const params = prepared.body.params as unknown as { policy: Policy };
  const next = params.policy;
  const history = historySchema.safeParse(next.history);
  if (
    !history.success ||
    history.data.messagesKeepDays !== input.messagesKeepDays ||
    history.data.filesKeepDays !== input.filesKeepDays ||
    !onlyHistoryChanged(effective.policy as Policy, next)
  ) {
    return NOT_SIGNED;
  }
  const body = prepared.body as unknown as JsonObject;
  const signatures = await owner.sign({ lines: REVIEW_LINES }, [
    { kind: 'owner-action', action: body },
  ]);
  const signed = signatures[0];
  if (
    signatures.length !== 1 ||
    signed?.kind !== 'owner-action' ||
    canonicalize(signed.signed.body) !== prepared.jcs
  ) {
    return answer(500, { error: 'failed' });
  }
  const outcome = await context.applyOwnerAction(signed.signed);
  if (outcome.status !== 'applied') {
    return outcome.reason === 'version_not_newer' ? STALE : NOT_SAVED;
  }
  return answer(200, { status: 'done', version: prepared.version });
}

export const retentionRoutes: readonly LocalUiRoute[] = Object.freeze([
  Object.freeze<LocalUiReadRoute>({
    method: 'GET',
    path: RETENTION_PATH,
    presence: false,
    handler: readRetention,
  }),
  Object.freeze<LocalUiOwnerRoute>({
    method: 'POST',
    path: RETENTION_PATH,
    presence: true,
    handler: saveRetention,
  }),
]);
