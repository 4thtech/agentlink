// REL051-A34 (D-149; 08 §1; 04 §4; I-4, I-5, I-7): `GET /api/ui/files/received/preview?id=<item ID>`,
// the in-app preview of one received text file (types ui-contract/file-preview.ts).
//
// A read route: the server's read gate (session, CSRF, Host, Origin, fetch metadata) runs first, as
// for every `/api/ui/` read. No presence, no signing, no store write; not an MCP tool (I-4).
//
// The query is exactly one `id`, `<envelope ID>.<index>`; anything else is `400 bad_request`, never
// echoed. The handler reads the sanitised name, the stated size, the plaintext hash and the saved
// name from the store by that ID (core `filesIo.previewSource`) and the Inbox folder from the rules
// in force, and hands just those to the checked read (local-ui/read-preview.ts). A name whose kind is
// not text, or a stated size over the cap, is refused before the disk is touched.
//
// The answer is exactly `{kind, size, text}`: the text is the other party's words, which the page
// shows only inside the untrusted frame (I-5). Never the name, the folder, a path, a link, a hash or
// an error's text; nothing is logged here (I-7).
import {
  FILE_PREVIEW_MAX_BYTES,
  FILE_PREVIEW_PATH,
  previewKindOf,
} from '@4thtech-io/types/ui-contract/file-preview';
import type { LocalUiContext } from '../context.js';
import {
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
} from '../route-types.js';
import { readSavedText, type PreviewReadLimits, type PreviewReadOutcome } from '../read-preview.js';

/** `<envelope ID>.<index>`, the index as two digits (core ui-messages.ts). */
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}\.[0-9]{2}$/;

/** The checked read the route calls (tests pass a fake). */
export type PreviewRead = (
  inboxFolder: string,
  savedName: string,
  limits: PreviewReadLimits,
) => Promise<PreviewReadOutcome>;

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

const BAD_REQUEST = fixed(400, 'bad_request');
const NOT_FOUND = fixed(404, 'not_found');
const NOT_SAVED = fixed(409, 'not_saved');
const NOT_TEXT = fixed(415, 'not_text');
const TOO_LARGE = fixed(413, 'too_large');

const READ_ANSWERS: Readonly<Record<Exclude<PreviewReadOutcome['status'], 'ok'>, LocalUiResult>> =
  Object.freeze({
    not_found: NOT_FOUND,
    refused: fixed(403, 'refused'),
    unavailable: UI_UNAVAILABLE,
    too_large: TOO_LARGE,
    changed: fixed(409, 'changed'),
    not_text: NOT_TEXT,
  });

/** The one item ID of the query, or undefined when the query is anything else. */
function itemIdOf(query: URLSearchParams): string | undefined {
  const keys = [...query.keys()];
  if (keys.length !== 1 || keys[0] !== 'id') return undefined;
  const id = query.get('id');
  return typeof id === 'string' && ITEM_ID.test(id) ? id : undefined;
}

/**
 * The route. `read` is for tests; otherwise the server's read (context `previewRead`, its home
 * folder) or readSavedText with the OS user's home.
 */
export function createFilesPreviewRoute(read?: PreviewRead): LocalUiReadRoute {
  const handler = async (
    context: LocalUiContext,
    request: LocalUiRequest,
  ): Promise<LocalUiResult> => {
    const client = context.client;
    if (client === undefined) return UI_NOT_SET_UP;
    const id = itemIdOf(request.query);
    if (id === undefined) return BAD_REQUEST;
    const previewSource = client.filesIo.previewSource;
    if (previewSource === undefined) return UI_UNAVAILABLE;
    let inboxFolder: unknown;
    let source: Awaited<ReturnType<typeof previewSource>>;
    try {
      source = await previewSource(id);
      if (source === null) return NOT_FOUND;
      const kind = previewKindOf(source.name);
      if (kind === undefined) return NOT_TEXT;
      if (!Number.isSafeInteger(source.size) || source.size > FILE_PREVIEW_MAX_BYTES) {
        return TOO_LARGE;
      }
      if (source.savedName === null) return NOT_SAVED;
      const policy = await client.policy.load();
      // Rules that fail closed name no Inbox folder: nothing is read.
      if (policy.mode === 'fail_closed') return UI_UNAVAILABLE;
      inboxFolder = (policy.policy.files as { inboxFolder?: unknown } | undefined)?.inboxFolder;
    } catch {
      // Never the error's text: it could name a file or a path.
      return UI_UNAVAILABLE;
    }
    if (typeof inboxFolder !== 'string' || inboxFolder.length === 0) return UI_UNAVAILABLE;
    const kind = previewKindOf(source.name);
    if (kind === undefined) return NOT_TEXT;
    let outcome: PreviewReadOutcome;
    try {
      const reader: PreviewRead =
        read ?? context.previewRead ?? ((f, n, l) => readSavedText(f, n, l));
      outcome = await reader(inboxFolder, source.savedName as string, {
        sha256: source.plaintextSha256,
        maxBytes: FILE_PREVIEW_MAX_BYTES,
      });
    } catch {
      return UI_UNAVAILABLE;
    }
    if (outcome.status !== 'ok') return READ_ANSWERS[outcome.status] ?? UI_UNAVAILABLE;
    const text = outcome.text;
    return {
      status: 200,
      body: { kind, size: new TextEncoder().encode(text).length, text },
    };
  };
  return Object.freeze<LocalUiReadRoute>({
    method: 'GET',
    path: FILE_PREVIEW_PATH,
    presence: false,
    handler,
  });
}

/** REL051-A34: the in-app preview, the one route of its path. */
export const filesPreviewRoute: LocalUiReadRoute = createFilesPreviewRoute();
