// W4-FILES-SAVE: "Save to Inbox", `POST /api/ui/files/save` (08 §1 "Save a received file"; 04 §2.5,
// §2.5.1 `file.save`, §4; D-118; I-1, I-4, I-5, I-7; proposed, owner confirms at merge).
//
// An owner route (`presence: true`): the server's central gate checks owner presence (the passkey
// assertion or the backup code) before the handler runs. The handler then:
// 1. reads only `{id}` from the input, the received item's ID `<envelope ID>.<index>`. Never a name,
//    a folder or a path; anything else is 400 `bad_request` (also in the precheck, before presence);
// 2. answers 409 `already_saved` for a file already saved, and 404 `not_found` for an ID that names
//    no received file of this agent (SEC-L1; also before presence: nothing signed);
// 3. asks core to prepare the unsigned `file.save` for this agent from that ID, checks it is exactly
//    that op for that file, and signs it once with this request's presence (fixed review text, never
//    the sender's file name);
// 4. hands the signed object to the save port: core takes only a `file.save`, verifies it again and
//    records its nonce, then saves with its own fetch (local decrypt, SSRF-safe download, Inbox folder
//    of the rules in force only, a name that never overwrites). The file key and the drop link never
//    reach this file.
// Each outcome is one fixed answer (types ui-contract/inbox.ts). No answer carries the saved name, a
// folder, a path, a link or an error's text, and nothing is logged here (I-7). Not an MCP tool (I-4).
import type { JsonObject } from '@4thtech-io/crypto';
import type { LocalUiContext, LocalUiFileSaveResult } from '../context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiRequest,
  LocalUiResult,
} from '../route-types.js';

/** The contract path (types ui-contract/inbox.ts FILE_SAVE_PATH). */
export const FILE_SAVE_PATH = '/api/ui/files/save';
/** A received item ID: a 16-byte envelope ID and the index 00 to 15 (ui-contract FILE_SAVE_ITEM_ID). */
const ITEM_ID = /^([A-Za-z0-9_-]{22})\.(0[0-9]|1[0-5])$/;
/** The review line the owner's gesture covers: fixed text, never inbound content (I-5). */
export const FILE_SAVE_REVIEW = 'Save a received file to your Inbox folder';

const fixed = (status: number, body: JsonObject): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze(body) });
const error = (status: number, code: string): LocalUiResult => fixed(status, { error: code });

const SAVED = fixed(200, { status: 'saved' });
const BAD_REQUEST = error(400, 'bad_request');
const ALREADY_SAVED = error(409, 'already_saved');
const NOT_FOUND = error(404, 'not_found');
const REFUSED = error(409, 'refused');
const NOT_SET_UP = error(409, 'not_set_up');
const UNAVAILABLE = error(503, 'unavailable');

const REJECTED: Readonly<Record<string, LocalUiResult>> = Object.freeze({
  FILE_TOO_LARGE: error(409, 'too_large'),
  INTEGRITY_FAILED: error(409, 'integrity_failed'),
  LINK_EXPIRED: error(409, 'expired'),
  URL_REFUSED: error(409, 'location_refused'),
  POLICY_DENIED: error(409, 'policy_denied'),
});
const FAILED: Readonly<Record<string, LocalUiResult>> = Object.freeze({
  inbox_unavailable: error(503, 'inbox_unavailable'),
  file_download_failed: error(502, 'download_failed'),
  files_unavailable: UNAVAILABLE,
});

/** The item ID of an input that is exactly `{id}` with a well-formed ID, or undefined. */
function itemOf(input: unknown): { id: string; envelopeId: string; fileIndex: number } | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'id') return undefined;
  const id = (input as { id?: unknown }).id;
  if (typeof id !== 'string') return undefined;
  const m = ITEM_ID.exec(id);
  if (m === null) return undefined;
  return { id, envelopeId: m[1] as string, fileIndex: Number(m[2]) };
}

/** The checks before presence and again after it: the input, set up, not saved yet. */
async function check(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult | ReturnType<typeof itemOf>> {
  const item = itemOf(request.input);
  if (item === undefined) return BAD_REQUEST;
  const client = context.client;
  if (client === undefined) return NOT_SET_UP;
  try {
    if ((await client.filesIo.savedName(item.id)) !== null) return ALREADY_SAVED;
    // SEC-L1: only a file this agent received; never ask for presence for anything else.
    const isReceived = client.filesIo.isReceived;
    if (isReceived !== undefined && !(await isReceived(item.id))) return NOT_FOUND;
  } catch {
    return UNAVAILABLE;
  }
  return item;
}

const isResult = (v: unknown): v is LocalUiResult =>
  typeof v === 'object' && v !== null && 'status' in v && 'body' in v;

/** True when `body` is exactly the `file.save` of this agent for this file. */
function isSaveBody(
  body: JsonObject,
  agent: string,
  item: { envelopeId: string; fileIndex: number },
): boolean {
  const params = body['params'];
  if (body['op'] !== 'file.save' || body['agent'] !== agent) return false;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
  const p = params as JsonObject;
  return (
    Object.keys(p).length === 3 &&
    p['agent'] === agent &&
    p['envelopeId'] === item.envelopeId &&
    p['fileIndex'] === item.fileIndex
  );
}

function answerOf(result: LocalUiFileSaveResult): LocalUiResult {
  switch (result.status) {
    case 'saved':
      return SAVED;
    case 'already_saved':
      return ALREADY_SAVED;
    case 'not_found':
      return NOT_FOUND;
    case 'rejected':
      return REJECTED[result.code] ?? UNAVAILABLE;
    case 'failed':
      return FAILED[result.code] ?? UNAVAILABLE;
    case 'refused':
      return REFUSED;
    default:
      return UNAVAILABLE;
  }
}

async function save(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const checked = await check(context, request);
  if (isResult(checked) || checked === undefined) return checked ?? BAD_REQUEST;
  const client = context.client;
  const port = context.fileSave;
  if (client === undefined) return NOT_SET_UP;
  if (port === undefined) return UNAVAILABLE;
  const prepare = client.filesIo.prepareSave;
  if (prepare === undefined) return UNAVAILABLE;
  let body: JsonObject;
  try {
    const prepared = await prepare(checked.id);
    if (prepared.status !== 'prepared') return BAD_REQUEST;
    body = prepared.body as unknown as JsonObject;
  } catch {
    // Never the error's text: it could name a file or a path.
    return UNAVAILABLE;
  }
  if (!isSaveBody(body, client.agentId, checked)) return BAD_REQUEST;
  const signatures = await owner.sign({ lines: [FILE_SAVE_REVIEW] }, [
    { kind: 'owner-action', action: body },
  ]);
  const first = signatures[0];
  if (signatures.length !== 1 || first === undefined || first.kind !== 'owner-action') {
    return REFUSED;
  }
  try {
    return answerOf(await port.save(first.signed));
  } catch {
    // Never the error's text: it could carry a link, a name or a path (I-7).
    return UNAVAILABLE;
  }
}

/** W4-FILES-SAVE: the one save route. */
export const filesSaveRoute: LocalUiOwnerRoute = Object.freeze<LocalUiOwnerRoute>({
  method: 'POST',
  path: FILE_SAVE_PATH,
  presence: true,
  precheck: async (context, request) => {
    const checked = await check(context, request);
    return isResult(checked) ? checked : checked === undefined ? BAD_REQUEST : undefined;
  },
  handler: save,
});
