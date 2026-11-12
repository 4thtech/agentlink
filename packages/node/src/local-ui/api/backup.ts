// WP-11 (F-1 full; D-117 A; 08 §1 Backup; 04 §2.3.3, §2.5.1 `backup.export`): the Backup page's API.
//
// - `GET /api/ui/backup`: `{export: "available" | "not_available"}`, whether the open ID can save a
//   recovery kit here (a keychain ID in the app host). Nothing else is read.
// - `POST /api/ui/backup/export` (presence, `recoveryKit: true`): the operation input is `{}` (the
//   page sends no value: the server draws the kitId, the contents are `full`, the folder is fixed).
//   Before the gesture (`precheck`, the owner store is never opened) it is refused with
//   `not_available` when the ID cannot save a kit here. After the gesture the gate's
//   `exportRecoveryKit` signs exactly one `backup.export` for the open ID, has core apply it and only
//   then seals the kit (approval-server.ts, local-ui/recovery-kit-export.ts). The answer carries the
//   file name, the folder's display name and the new recovery code, once; it is never logged or
//   emitted as an event (I-7).
//
// Restore is a terminal step by D-117 A (not built yet). No MCP tool reaches this (I-4).
import type { JsonValue } from '@4thtech-io/crypto';
import type { LocalUiContext } from '../context.js';
import {
  BACKUP_EXPORT_PATH,
  BACKUP_PATH,
  NOT_AVAILABLE,
  UI_NOT_SET_UP,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });
/** 400: the input is not `{}`. */
const INVALID = fixed(400, 'invalid');
/** Signed, but core did not apply it: nothing was sealed. */
const NOT_APPLIED = fixed(409, 'not_applied');
/** 500: the kit could not be written; no file is left. */
const FAILED: LocalUiResult = Object.freeze({
  status: 500,
  body: Object.freeze({ status: 'failed' }),
});

/** The operation input: absent or exactly `{}`. */
function emptyInput(input: JsonValue | undefined): boolean {
  if (input === undefined) return true;
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 0
  );
}

const available = (context: LocalUiContext): boolean =>
  context.client !== undefined && context.recoveryKitAvailable === true;

/** GET /api/ui/backup. */
function readBackup(context: LocalUiContext): Promise<LocalUiResult> {
  return Promise.resolve({
    status: 200,
    body: { export: available(context) ? 'available' : 'not_available' },
  });
}

/** Before the presence gate: refuse when this ID cannot save a kit here (reads nothing). */
function exportPrecheck(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult | undefined> {
  if (!emptyInput(request.input)) return Promise.resolve(INVALID);
  if (context.client === undefined) return Promise.resolve(UI_NOT_SET_UP);
  return Promise.resolve(available(context) ? undefined : NOT_AVAILABLE);
}

/** POST /api/ui/backup/export: saves a recovery kit of the open ID (signs `backup.export`). */
async function exportKit(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  if (!emptyInput(request.input)) return INVALID;
  if (context.client === undefined) return UI_NOT_SET_UP;
  if (!available(context) || owner.exportRecoveryKit === undefined) return NOT_AVAILABLE;
  let shown = 'this ID';
  try {
    const reading = await context.client.agent?.label();
    if (reading?.status === 'verified') shown = reading.label;
  } catch {
    // The statement then names "this ID".
  }
  const outcome = await owner.exportRecoveryKit({
    lines: [
      `Save a recovery kit for ${shown}`,
      'It holds your keys, contacts and messages. Keep it and its recovery code apart.',
    ],
  });
  if (outcome.status === 'not_applied') return NOT_APPLIED;
  if (outcome.status !== 'saved') return FAILED;
  return {
    status: 200,
    body: { status: 'saved', file: outcome.file, folder: outcome.folder, code: outcome.code },
  };
}

const readRoute: LocalUiReadRoute = Object.freeze({
  method: 'GET',
  path: BACKUP_PATH,
  presence: false,
  handler: readBackup,
});

const exportRoute: LocalUiOwnerRoute = Object.freeze({
  method: 'POST',
  path: BACKUP_EXPORT_PATH,
  presence: true,
  recoveryKit: true,
  precheck: exportPrecheck,
  handler: exportKit,
});

export const backupRoutes: readonly LocalUiRoute[] = Object.freeze([readRoute, exportRoute]);
