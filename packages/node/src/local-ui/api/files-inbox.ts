// FILES-FOLDER-PICKER (D-154, proposed, owner confirms at merge; 04 §4.1 "The folder"; 08 §1
// "Choosing a folder"; I-4, I-5): changing where received files are saved, the Inbox folder
// (`files.inboxFolder`). 04 §4.1 already said "changeable in Settings with a `policy.set` behind
// presence"; these are the routes that do it, the same way as a Send folder (files.ts).
//
// - GET /api/ui/files/inbox/review?set=<path>&version=<n>: nothing is signed and nothing changes.
//   The path the owner picked in the app's folder dialog or typed in a browser is checked, in this
//   order, and the REAL folder is what is shown and signed:
//   - files.ts checkFolder: a full path (`~/` is home), no `.` or `..`, showable, an existing folder,
//     its realpath; never the root, the home folder or above it, never hidden, never a protected
//     folder (`~/.ssh`, `~/.agentlink` the app's data, keychains) or inside or around one (D-99);
//   - the folder itself is not a link (lstat of the typed path; "a shortcut to another place");
//   - inbox-folder.ts inboxFolderProblem, the rules every save checks again: owned by this OS user,
//     on macOS and Linux not writable by group or others, not an OS or app folder (macOS `~/Library`
//     with the app's own data, `/Library`, `/System`, `/Applications`; Windows `AppData` with the
//     app's own data, `Program Files`, `ProgramData`, `Windows`), not a Send folder, inside one or
//     around one (`files.allowedFolders`, so a received file never becomes sendable by the AI);
//   - writable by this user (access W_OK);
//   - not the Inbox already.
//   Then core `preparePolicyEdit({files: {inboxFolder}})` builds the unsigned `policy.set` (warning
//   `folder_changed`); it is kept per server under its hash, one use, as files.ts does.
// - POST /api/ui/files/inbox (`presence: true`, behind the central gate): `{ review, acknowledged }`,
//   exactly the warning codes of that body (D-119); the folder is checked again; then the owner signs
//   exactly that body once and core applies it (I-4). Files already saved stay where they are; new
//   files go to the new folder (each save resolves the rules in force). No MCP tool reaches these.
//
// The browser never signs and never sees the body. Answers carry fixed codes, never an error's text.
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import process from 'node:process';
import { expandHome, type OwnerActionOutcome, type PathFlavor } from '@4thtech-io/core';
import { canonicalize, type JsonObject, type JsonValue } from '@4thtech-io/crypto';
import { inboxFolderProblem, type InboxFolderProblem } from '../../inbox-folder.js';
import type { LocalUiContext } from '../context.js';
import {
  UI_INVALID_QUERY,
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiOwnerOperation,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';
import {
  applyAnswer,
  checkFolder,
  foldersOverlap,
  hashOf,
  inboxRealpath,
  parseCommit,
} from './files.js';

export const INBOX_REVIEW_PATH = '/api/ui/files/inbox/review';
export const INBOX_COMMIT_PATH = '/api/ui/files/inbox';

const MAX_REVIEWS = 8;
const MAX_PATH_CHARS = 4096;

/** Why a folder can't hold received files (fixed codes; the page has the words). */
export type InboxRefusal =
  | 'not_full_path'
  | 'dot_segments'
  | 'not_showable'
  | 'missing'
  | 'not_folder'
  | 'too_broad'
  | 'protected'
  | 'contains_protected'
  | 'hidden'
  | 'link'
  | 'not_owned'
  | 'shared_writable'
  | 'os_folder'
  | 'send_folder'
  | 'not_writable'
  | 'already_inbox';

const result = (status: number, body: JsonValue): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze(body) as JsonValue });
const fixed = (status: number, error: string): LocalUiResult => result(status, { error });
const refused = (reason: InboxRefusal, protectedFolder?: string): LocalUiResult =>
  result(422, {
    error: 'folder_refused',
    reason,
    ...(protectedFolder === undefined ? {} : { protectedFolder }),
  });
const INVALID = fixed(400, 'invalid');
const FAILED = fixed(500, 'failed');

const RULE_REASON: Readonly<Record<InboxFolderProblem, InboxRefusal>> = {
  not_a_folder: 'not_folder',
  not_owned: 'not_owned',
  shared_writable: 'shared_writable',
  home_or_root: 'too_broad',
  os_folder: 'os_folder',
  send_folder: 'send_folder',
};

interface Kept {
  readonly folder: string;
  readonly body: JsonObject;
  readonly codes: readonly string[];
  readonly expiresAtMs: number;
}

type Checked =
  | { readonly ok: true; readonly folder: string; readonly elsewhere: boolean }
  | { readonly ok: false; readonly reason: InboxRefusal; readonly protectedFolder?: string };

/** `?set=<path>&version=<n>`, each once, nothing else. */
function parseQuery(
  query: URLSearchParams,
): { readonly path: string; readonly baseVersion: number } | undefined {
  const keys = [...query.keys()].sort();
  if (keys.length !== 2 || keys[0] !== 'set' || keys[1] !== 'version') return undefined;
  const path = query.get('set');
  if (path === null || path.length === 0 || path.length > MAX_PATH_CHARS) return undefined;
  const version = query.get('version') ?? '';
  if (!/^(0|[1-9][0-9]{0,14})$/.test(version)) return undefined;
  return { path, baseVersion: Number(version) };
}

function inboxOf(body: JsonObject): unknown {
  const params = body['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
  const policy = (params as JsonObject)['policy'];
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) return undefined;
  const files = (policy as JsonObject)['files'];
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return undefined;
  return (files as JsonObject)['inboxFolder'];
}

export interface InboxRouteOptions {
  readonly home?: string;
  readonly flavor?: PathFlavor;
  /** Test seam: the platform of the 04 §4.1 rules. Default this one. */
  readonly platform?: NodeJS.Platform;
  /** Test seam: the current OS user's uid for the ownership rule. */
  readonly uid?: number;
}

/** The Inbox folder routes; each server (context) keeps its own reviews. */
export function createInboxRoutes(options: InboxRouteOptions = {}): readonly LocalUiRoute[] {
  const flavor: PathFlavor = options.flavor ?? (process.platform === 'win32' ? 'win32' : 'posix');
  const platform: NodeJS.Platform = options.platform ?? process.platform;
  const homeOf = (): string => options.home ?? homedir();
  const kept = new WeakMap<LocalUiContext, Map<string, Kept>>();
  const reviewsOf = (context: LocalUiContext): Map<string, Kept> => {
    let map = kept.get(context);
    if (map === undefined) {
      map = new Map();
      kept.set(context, map);
    }
    return map;
  };

  /** Every rule of the header on the typed or picked path. */
  async function check(
    context: LocalUiContext,
    typed: string,
    sendFolders: readonly string[],
  ): Promise<Checked> {
    const home = homeOf();
    const base = await checkFolder(typed, home, flavor);
    if (!base.ok) {
      return base.protectedFolder === undefined
        ? { ok: false, reason: base.reason as InboxRefusal }
        : { ok: false, reason: base.reason as InboxRefusal, protectedFolder: base.protectedFolder };
    }
    const folder = base.folder;
    // The folder itself is not a link (a link on the way is followed; the real folder is signed).
    const given = expandHome(typed, home, flavor).replace(
      flavor === 'posix' ? /\/$/ : /[\\/]$/,
      '',
    );
    const own = await lstat(given).catch(() => undefined);
    if (own === undefined) return { ok: false, reason: 'missing' };
    if (own.isSymbolicLink()) return { ok: false, reason: 'link' };
    const info = await lstat(folder).catch(() => undefined);
    if (info === undefined) return { ok: false, reason: 'missing' };
    const homeReal = await realpath(home).catch(() => home);
    const sendReal: string[] = [];
    for (const entry of sendFolders) {
      const abs = expandHome(entry, home, flavor);
      sendReal.push(abs);
      const real = await realpath(abs).catch(() => undefined);
      if (real !== undefined && real !== abs) sendReal.push(real);
    }
    const problem = await inboxFolderProblem({
      realpath: folder,
      home: homeReal,
      sendFolders: sendReal,
      stat: info,
      platform,
      ...(options.uid === undefined ? {} : { uid: options.uid }),
    });
    if (problem !== undefined) return { ok: false, reason: RULE_REASON[problem] };
    // Case-insensitive overlap too (inboxFolderProblem folds case on macOS and Windows only).
    if (sendReal.some((s) => foldersOverlap(folder, s, flavor))) {
      return { ok: false, reason: 'send_folder' };
    }
    try {
      await access(folder, constants.W_OK);
    } catch {
      return { ok: false, reason: 'not_writable' };
    }
    const current = await inboxRealpath(context.client, home, flavor);
    if (current !== undefined && current === folder) return { ok: false, reason: 'already_inbox' };
    return { ok: true, folder, elsewhere: base.elsewhere };
  }

  async function review(context: LocalUiContext, request: LocalUiRequest): Promise<LocalUiResult> {
    const parsed = parseQuery(request.query);
    if (parsed === undefined) return UI_INVALID_QUERY;
    const client = context.client;
    if (client === undefined) return UI_NOT_SET_UP;
    let configured: readonly string[];
    try {
      configured = (await client.files.resolvedFolders()).configured;
    } catch {
      return UI_UNAVAILABLE;
    }
    const checked = await check(context, parsed.path, configured);
    if (!checked.ok) return refused(checked.reason, checked.protectedFolder);
    let prepared: Awaited<ReturnType<typeof client.files.preparePolicyEdit>>;
    try {
      prepared = await client.files.preparePolicyEdit(
        { files: { inboxFolder: checked.folder } },
        { baseVersion: parsed.baseVersion },
      );
    } catch {
      return UI_UNAVAILABLE;
    }
    if (prepared.status !== 'prepared') {
      switch (prepared.reason) {
        case 'identity_missing':
          return UI_NOT_SET_UP;
        case 'policy_not_valid':
          return fixed(409, 'rules_unreadable');
        case 'stale_version':
          return fixed(409, 'stale');
        default:
          return fixed(409, 'refused');
      }
    }
    // D-109: never sign delivery receipts off behind a folder edit; Rules asks the question.
    if (prepared.askKeepDeliveryReceipts) return fixed(409, 'receipts_question');
    const body = prepared.body as unknown as JsonObject;
    const expiresAt = body['expiresAt'];
    if (
      prepared.op !== 'policy.set' ||
      prepared.jcs !== canonicalize(body) ||
      typeof expiresAt !== 'number' ||
      inboxOf(body) !== checked.folder
    ) {
      return UI_UNAVAILABLE;
    }
    const codes = prepared.warnings.map((w) => w.code as string);
    if (new Set(codes).size !== codes.length || !codes.every((c) => /^[a-z_]{1,64}$/.test(c))) {
      return UI_UNAVAILABLE;
    }
    const token = hashOf(prepared.jcs);
    const reviews = reviewsOf(context);
    reviews.set(token, {
      folder: checked.folder,
      body: JSON.parse(prepared.jcs) as JsonObject,
      codes: Object.freeze([...codes]),
      expiresAtMs: expiresAt * 1000,
    });
    while (reviews.size > MAX_REVIEWS) {
      const oldest = reviews.keys().next().value;
      if (oldest === undefined) break;
      reviews.delete(oldest);
    }
    return result(200, {
      review: token,
      change: 'inbox',
      folder: checked.folder,
      typed: parsed.path,
      elsewhere: checked.elsewhere,
      warnings: [...codes],
      expiresAt,
    });
  }

  async function commit(
    context: LocalUiContext,
    request: LocalUiRequest,
    owner: LocalUiOwnerOperation,
  ): Promise<LocalUiResult> {
    const input = parseCommit(request.input);
    if (input === undefined) return INVALID;
    const reviews = reviewsOf(context);
    const one = reviews.get(input.review);
    reviews.delete(input.review);
    if (one === undefined) return fixed(409, 'unknown_review');
    if (context.now() >= one.expiresAtMs) return fixed(409, 'expired');
    const given = new Set(input.acknowledged);
    if (
      given.size !== input.acknowledged.length ||
      given.size !== one.codes.length ||
      !one.codes.every((code) => given.has(code))
    ) {
      return fixed(409, 'not_acknowledged');
    }
    if (hashOf(canonicalize(one.body)) !== input.review) return fixed(409, 'unknown_review');
    // Checked again: a folder swapped for a link, or made a Send folder, since the review is refused.
    // Fable r1: without a client the Send-folder rule can't be checked: nothing is signed.
    if (context.client === undefined) return UI_NOT_SET_UP;
    let configured: readonly string[];
    try {
      configured = (await context.client.files.resolvedFolders()).configured;
    } catch {
      return UI_UNAVAILABLE;
    }
    const again = await check(context, one.folder, configured);
    if (!again.ok || again.folder !== one.folder) return fixed(409, 'folder_changed');
    const lines = [
      `Save files people send you in ${one.folder}.`,
      'Files already saved stay where they are. AgentLink never opens received files.',
    ];
    const [signature] = await owner.sign({ lines }, [{ kind: 'owner-action', action: one.body }]);
    if (signature === undefined || signature.kind !== 'owner-action') return FAILED;
    let outcome: OwnerActionOutcome;
    try {
      outcome = await context.applyOwnerAction(signature.signed);
    } catch {
      return FAILED;
    }
    return applyAnswer(outcome);
  }

  return Object.freeze<LocalUiRoute[]>([
    Object.freeze({ method: 'GET', path: INBOX_REVIEW_PATH, presence: false, handler: review }),
    Object.freeze({ method: 'POST', path: INBOX_COMMIT_PATH, presence: true, handler: commit }),
  ]);
}

export const inboxRoutes: readonly LocalUiRoute[] = createInboxRoutes();
