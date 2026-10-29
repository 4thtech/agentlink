// Saving a received file from the local app (W4-FILES-SAVE; 04 §2.5.1 `file.save`, §4; 08 §1 "Save a
// received file"; proposed, owner confirms at merge).
//
// The owner signs one `file.save` behind the local app's presence gate; this is the only way it is
// used. In order:
// 1. Only a `file.save` is taken: any other object (another op, junk) is refused as `malformed`
//    before anything is applied, so no other owner action can ride on this path (I-4).
// 2. A file already saved is answered `already_saved` before anything is applied: no second copy,
//    the nonce stays unused.
// 3. OwnerActions.apply verifies the object against the own card (encoding, agent, owner, signature,
//    freshness, lifetime, nonce) and records its nonce row (the audit record). A refusal saves nothing.
// 4. Then core's own fetch (FileFetcher, as `agentlink_fetch_file`): the size cap, the SSRF-safe
//    download, local decryption, both hashes, a sanitised name that never overwrites, written only
//    into the Inbox folder of the rules in force (04 §4, D-84). Its envelope and index come from the
//    signed body, never from anything else.
// The result carries the saved name only, never the path; nothing here logs a name, a path or a link
// (I-7). The saved name is the sender's text, sanitised: untrusted (I-5).
import { canonicalize } from '@4thtech-io/crypto';
import { signedOwnerActionSchema } from '@4thtech-io/types';
import { CoreError } from '../errors.js';
import { parseOwnerActionText, type OwnerActionRefusal } from '../owner-action.js';
import type { OwnerActions } from '../owner-actions.js';
import type { FilesIoView } from '../ui-messages.js';
import type { FileFetcher, FetchFileResult } from './incoming.js';

export type SaveReceivedFileResult =
  | {
      readonly status: 'saved';
      /** The single, sanitised name the file got in the Inbox folder; never a path. Untrusted. */
      readonly name: string;
    }
  | { readonly status: 'already_saved' }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'rejected';
      readonly code: Extract<FetchFileResult, { status: 'rejected' }>['code'];
    }
  | {
      readonly status: 'failed';
      readonly code: 'inbox_unavailable' | 'file_download_failed' | 'files_unavailable';
    }
  | { readonly status: 'refused'; readonly reason: OwnerActionRefusal };

export interface SaveReceivedFileDeps {
  readonly ownerActions: Pick<OwnerActions, 'apply'>;
  readonly filesIo: Pick<FilesIoView, 'savedName'>;
  readonly fetcher: Pick<FileFetcher, 'fetch'>;
  /**
   * Saves in flight per item ID (IR L2): a second save of the same file waits for the first, then
   * sees it saved and answers `already_saved`, so two at once never write two copies.
   */
  readonly inFlight?: Map<string, Promise<unknown>>;
}

const MALFORMED: SaveReceivedFileResult = Object.freeze({ status: 'refused', reason: 'malformed' });
const FAILED_CODES: ReadonlySet<string> = new Set(['inbox_unavailable', 'file_download_failed']);

export async function saveReceivedFile(
  deps: SaveReceivedFileDeps,
  input: unknown,
): Promise<SaveReceivedFileResult> {
  let text: string;
  let value: unknown;
  try {
    text = canonicalize(input as never);
    value = parseOwnerActionText(text);
  } catch {
    return MALFORMED;
  }
  const shape = signedOwnerActionSchema.safeParse(value);
  if (!shape.success || shape.data.body.op !== 'file.save') return MALFORMED;
  const { envelopeId, fileIndex } = shape.data.body.params;
  const itemId = `${envelopeId}.${String(fileIndex).padStart(2, '0')}`;
  const queue = deps.inFlight;
  if (queue === undefined) return saveOne(deps, text, itemId, envelopeId, fileIndex);
  const before = queue.get(itemId) ?? Promise.resolve();
  const run = before
    .catch(() => undefined)
    .then(() => saveOne(deps, text, itemId, envelopeId, fileIndex));
  queue.set(itemId, run);
  try {
    return await run;
  } finally {
    if (queue.get(itemId) === run) queue.delete(itemId);
  }
}

async function saveOne(
  deps: SaveReceivedFileDeps,
  text: string,
  itemId: string,
  envelopeId: string,
  fileIndex: number,
): Promise<SaveReceivedFileResult> {
  if ((await deps.filesIo.savedName(itemId)) !== null) return { status: 'already_saved' };

  const outcome = await deps.ownerActions.apply(text);
  if (outcome.status !== 'applied') return { status: 'refused', reason: outcome.reason };
  if (outcome.op !== 'file.save') return MALFORMED;

  let fetched: FetchFileResult;
  try {
    fetched = await deps.fetcher.fetch({ envelopeId, fileIndex });
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    const code = FAILED_CODES.has(error.code) ? error.code : 'files_unavailable';
    return { status: 'failed', code: code as 'inbox_unavailable' | 'file_download_failed' };
  }
  if (fetched.status === 'ok') return { status: 'saved', name: fetched.name };
  if (fetched.status === 'rejected') return { status: 'rejected', code: fetched.code };
  return { status: 'not_found' };
}
