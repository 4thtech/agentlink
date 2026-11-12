// WP-11 (F-1 full; D-117 A; 08 §1 Backup; 04 §2.3.3, §2.5.1 `backup.export`) and WP-R2 (D-147 (2),
// (6), (7); 04 §2.3.3 "In the local app", "Kit record", "Check that my kit opens"; design-1112 §6.2 to
// §6.4): the Backup & restore page's API.
//
// - `GET /api/ui/backup`: `{export, record, state, lastKit, missing}` (kit-record.ts `KitStatus`;
//   frozen for WP-R4). `export` says whether this ID can save a recovery kit here (a keychain ID in
//   the app host). The rest comes from the server's kit record compared with today's IDs and
//   contacts, through the app host's backup desk (context `backup`): `lastKit` `{at, covers:
//   [{name, label}], peopleAtSave}`, `missing` `{ids: [{name, label}], people}`. Never a path, a
//   kitId or a nonce. A record whose covered ID's `backup.export` core does not hold reads as no kit.
//   Without the desk, or when it fails, `record` is `unreadable` and the page keeps its own flag.
// - `POST /api/ui/backup/export` (presence, `recoveryKit: true`): the operation input is `{}` (the
//   page sends no value: the server draws the kitId, the contents are `full`, the folder is fixed).
//   Before the gesture (`precheck`, the owner store is never opened) it is refused with
//   `not_available` when the ID cannot save a kit here. After the gesture the gate's
//   `exportRecoveryKit` signs one `backup.export` per ID in the kit, has each ID's core apply it and
//   only then seals the one kit (approval-server.ts, recovery-kit-export.ts). The answer carries the
//   file name, the folder's display name, the new recovery code (once; never logged or emitted as an
//   event, I-7), the covered IDs by name and label, and `check`, the export handle Check takes.
// - Show in Finder for the kit (`revealKit`, BACKUP_REVEAL_PATH): takes no input; reveals only the
//   record's own file, a regular file, in its folder (kit-record.ts revealKitFile). Its registration
//   needs a route kind that takes no presence and no input (the server's reveal gate): WP-R1's routes.
//
// Restore and Check are WP-R1's routes. No MCP tool reaches this (I-4).
import type { JsonValue } from '@4thtech-io/crypto';
import {
  kitStatus,
  readKitRecord,
  revealKitFile,
  type KitStatus,
  type KitTodayId,
  type LocalUiBackupDesk,
} from '../../kit-record.js';
import type { RecoveryKitSaved } from '../../recovery-kit-export.js';
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

/** WP-R2: Show in Finder for the recorded kit (registered by WP-R1's routes, see the file comment). */
export const BACKUP_REVEAL_PATH = '/api/ui/backup/reveal';

/**
 * WP-R2: the app host's backup desk on the context. The context field is added by the server wiring
 * (context.ts `backup?: LocalUiBackupDesk`, built in approval-server.ts buildUiContext); until then
 * it is absent and the record reads as `unreadable`.
 */
type BackupContext = LocalUiContext & { readonly backup?: LocalUiBackupDesk };
const deskOf = (context: LocalUiContext): LocalUiBackupDesk | undefined =>
  (context as BackupContext).backup;

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

const UNREADABLE: KitStatus = Object.freeze({
  record: 'unreadable',
  state: 'unknown',
  lastKit: null,
  missing: null,
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

/**
 * Core's word on the record: false when a covered ID's store holds no such `backup.export`, true when
 * at least one covered ID confirms it, undefined when none could be checked here (G-1: a display aid).
 */
async function verified(
  desk: LocalUiBackupDesk,
  covers: readonly string[],
  exports: Readonly<Record<string, string>>,
): Promise<boolean | undefined> {
  let answer: boolean | undefined;
  for (const agentId of covers) {
    const nonce = exports[agentId];
    if (nonce === undefined) return false;
    const one = await desk.exportRecorded(agentId, nonce);
    if (one === false) return false;
    if (one === true) answer = true;
  }
  return answer;
}

/** The status from the record (never throws; any failure is `unreadable`). */
async function statusOf(desk: LocalUiBackupDesk | undefined): Promise<KitStatus> {
  if (desk === undefined) return UNREADABLE;
  try {
    const read = await readKitRecord(desk.agentlinkDir);
    if (read.status !== 'saved') return kitStatus(read, [], undefined);
    const today: readonly KitTodayId[] = await desk.ids();
    const ok = await verified(desk, read.record.covers, read.record.exports);
    return kitStatus(read, today, ok);
  } catch {
    // Never the error's text (it may name a path).
    return UNREADABLE;
  }
}

/** GET /api/ui/backup. */
async function readBackup(context: LocalUiContext): Promise<LocalUiResult> {
  const status = await statusOf(deskOf(context));
  return {
    status: 200,
    body: {
      export: available(context) ? 'available' : 'not_available',
      record: status.record,
      state: status.state,
      lastKit:
        status.lastKit === null
          ? null
          : {
              at: status.lastKit.at,
              covers: status.lastKit.covers.map((c) => ({ name: c.name, label: c.label })),
              peopleAtSave: status.lastKit.peopleAtSave,
            },
      missing:
        status.missing === null
          ? null
          : {
              ids: status.missing.ids.map((c) => ({ name: c.name, label: c.label })),
              people: status.missing.people,
            },
    },
  };
}

/**
 * WP-R2: Show in Finder for the recorded kit. No input; the path is the record's, checked by
 * revealKitFile, and never answered. Fixed answers only.
 */
export async function revealKit(context: LocalUiContext): Promise<LocalUiResult> {
  const desk = deskOf(context);
  if (desk === undefined) return NOT_AVAILABLE;
  let outcome: Awaited<ReturnType<typeof revealKitFile>>;
  try {
    outcome = await revealKitFile(
      await readKitRecord(desk.agentlinkDir),
      desk.agentlinkDir,
      desk.revealer,
    );
  } catch {
    outcome = 'not_opened';
  }
  switch (outcome) {
    case 'shown':
      return { status: 200, body: { status: 'shown' } };
    case 'not_found':
      return fixed(404, 'not_found');
    case 'refused':
      return fixed(409, 'refused');
    default:
      return fixed(503, 'not_opened');
  }
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

/** WP-R2: the covered IDs and the export handle of a saved outcome (recovery-kit-export.ts). */
function savedExtras(outcome: object): {
  covers: readonly { readonly name: string }[];
  check: string | undefined;
} {
  const extra = outcome as Partial<Pick<RecoveryKitSaved, 'covers' | 'check'>>;
  const covers = Array.isArray(extra.covers)
    ? extra.covers.filter(
        (c): c is { agentId: string; name: string } =>
          typeof c === 'object' && c !== null && typeof c.name === 'string',
      )
    : [];
  const check =
    typeof extra.check === 'string' && /^[A-Za-z0-9_-]{22}$/.test(extra.check)
      ? extra.check
      : undefined;
  return { covers, check };
}

/** The covered IDs by name and label (labels from the desk; else the folder name). */
async function coversShown(
  context: LocalUiContext,
  covers: readonly { readonly name: string }[],
): Promise<{ name: string; label: string }[]> {
  let today: readonly KitTodayId[] = [];
  try {
    today = (await deskOf(context)?.ids()) ?? [];
  } catch {
    today = [];
  }
  return covers.map(({ name }) => ({
    name,
    label: today.find((id) => id.name === name)?.label ?? name,
  }));
}

/** POST /api/ui/backup/export: saves one recovery kit of this owner's IDs (signs `backup.export`). */
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
  const { covers, check } = savedExtras(outcome);
  return {
    status: 200,
    body: {
      status: 'saved',
      file: outcome.file,
      folder: outcome.folder,
      code: outcome.code,
      covers: await coversShown(context, covers),
      ...(check === undefined ? {} : { check }),
    },
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
