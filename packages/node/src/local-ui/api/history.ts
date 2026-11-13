// RET-4 (S2; D-148; 04 §4.2 "Presence and undo"; 08 §1 "The delete sheet", "Free up space"; I-4,
// I-7): Delete history and Show in Finder for the Inbox folder.
//
// - `POST /api/ui/history/delete/begin` (history kind, no presence): `{contact?, olderThanDays?,
//   envelopeIds?, include}`. The server plans (core `history.plan`) and keeps the plan in a ticket
//   of this page session; the answer is counts, sizes and a nonce (history-desk.ts).
// - `POST /api/ui/history/delete/finish` (`presence: true`, `historyFinish`): the body is the
//   presence proof and the input exactly `{nonce}`. The central gate verifies presence first; then
//   the bound plan is scheduled for when the Undo window ends. A list that changed is refused
//   (409 `not_applied`); nothing else can be named here.
// - `POST /api/ui/history/delete/undo` and `…/status` (history kind): `{nonce}`.
// - `POST /api/ui/storage/inbox/reveal` (inbox-reveal kind, no input): the Inbox folder in Finder.
//
// Not MCP tools (I-4). Answers are fixed words and numbers; nothing here logs.
import type { JsonObject } from '@4thtech-io/crypto';
import { finishNonce, type HistoryBeginAnswer } from '../history-desk.js';
import {
  HISTORY_BEGIN_PATH,
  HISTORY_FINISH_PATH,
  HISTORY_STATUS_PATH,
  HISTORY_UNDO_PATH,
  INBOX_REVEAL_PATH,
} from '../history-paths.js';
import type { LocalUiResult, LocalUiRoute } from '../route-types.js';

const answer = (status: number, body: JsonObject): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze(body) });

const INVALID = answer(400, { error: 'invalid' });
const UNAVAILABLE = answer(503, { error: 'unavailable' });

function beginResult(begun: HistoryBeginAnswer): LocalUiResult {
  if (begun.status === 'invalid') return INVALID;
  if (begun.status === 'busy') return answer(429, { error: 'busy' });
  if (begun.status !== 'planned') return UNAVAILABLE;
  return answer(200, {
    status: 'planned',
    nonce: begun.nonce,
    messages: { count: begun.messages.count, bytes: begun.messages.bytes },
    files: { count: begun.files.count, bytes: begun.files.bytes },
    notarized: begun.notarized,
    kept: begun.kept,
    truncated: begun.truncated,
    undoSeconds: begun.undoSeconds,
  });
}

const nonceOf = (body: JsonObject): unknown =>
  Object.keys(body).length === 1 ? body['nonce'] : undefined;

export const historyRoutes: readonly LocalUiRoute[] = Object.freeze<LocalUiRoute[]>([
  {
    method: 'POST',
    path: HISTORY_BEGIN_PATH,
    presence: 'history',
    step: 'begin',
    handler: async (_context, body, history) => {
      try {
        return beginResult(await history.begin(body));
      } catch {
        return UNAVAILABLE;
      }
    },
  },
  {
    method: 'POST',
    path: HISTORY_UNDO_PATH,
    presence: 'history',
    step: 'undo',
    handler: async (_context, body, history) => {
      const nonce = nonceOf(body);
      if (nonce === undefined) return INVALID;
      const undone = await history.undo(nonce);
      return undone === 'not_found'
        ? answer(404, { error: 'not_found' })
        : answer(200, { status: undone });
    },
  },
  {
    method: 'POST',
    path: HISTORY_STATUS_PATH,
    presence: 'history',
    step: 'status',
    handler: async (_context, body, history) => {
      const nonce = nonceOf(body);
      if (nonce === undefined) return INVALID;
      const status = await history.status(nonce);
      if (status.status !== 'done') return answer(200, { status: status.status });
      const { messages, files } = status.result;
      return answer(200, {
        status: 'done',
        result: {
          messages: {
            deleted: messages.deleted,
            notarized: messages.notarized,
            kept: messages.kept,
          },
          files: {
            trashed: files.trashed,
            changed: files.changed,
            missing: files.missing,
            refused: files.refused,
            noTrash: files.noTrash,
            failed: files.failed,
          },
        },
      });
    },
  },
  {
    method: 'POST',
    path: HISTORY_FINISH_PATH,
    presence: true,
    historyFinish: true,
    handler: async (context, request, owner) => {
      const history = context.historySession;
      const nonce = finishNonce(request.input);
      // Nothing is marked done unless the input is exactly `{nonce}` (the gate then answers
      // 409 `refused`): a selector can never travel with the gesture.
      if (history === undefined || nonce === undefined || owner.presenceChecked === undefined) {
        return INVALID;
      }
      // The one owner operation of this gesture: presence was verified by the central gate.
      owner.presenceChecked();
      const outcome = await history.finish(nonce);
      if (outcome === 'scheduled') {
        const status = await history.status(nonce);
        return status.status === 'scheduled'
          ? answer(200, { status: 'done', undoSeconds: 10 })
          : answer(409, { status: 'not_applied' });
      }
      if (outcome === 'agent_changed') return answer(409, { status: 'agent_changed' });
      return answer(409, { status: 'not_applied' });
    },
  },
  {
    method: 'POST',
    path: INBOX_REVEAL_PATH,
    presence: 'inbox-reveal',
    handler: async (context) => {
      if (context.revealInbox === undefined) return UNAVAILABLE;
      const shown = await context.revealInbox().catch(() => 'unavailable' as const);
      if (shown === 'shown') return answer(200, { status: 'shown' });
      if (shown === 'not_found') return answer(404, { error: 'not_found' });
      if (shown === 'refused') return answer(409, { error: 'refused' });
      return answer(503, { error: shown });
    },
  },
]);
