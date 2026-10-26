// M1-11c-a3: the Files page's API (08 §1; 04 §2.5, §4; 06 §3; D-99, D-118, D-119; I-4, I-5, I-7).
//
// - GET /api/ui/files: the folders the AI may send files from, read through core
//   `files.resolvedFolders()`. Display paths only: each folder as the rules write it and its realpath
//   when core resolved it. Never a file, a key, a URL or an error's text.
// - GET /api/ui/files/review?add=<path> | ?remove=<path>: nothing is signed and nothing changes.
//   - add: the 04 §4 checks on the path the owner typed, before anything is prepared: a full path
//     (`~/` is the home folder), no `.` or `..`, showable (no control, format or bidi character, so
//     what the owner reads is what is signed), an existing folder, then its realpath (links
//     followed). The REAL folder is what is checked, shown and signed: never the root, the home
//     folder or a folder above it, never hidden, never inside a protected folder (`~/.ssh`,
//     `~/.agentlink`, keychains), and never a folder that contains one (D-99, compared in its lexical
//     form and its realpath, ignoring case). `elsewhere` tells the page the typed path led somewhere
//     else (a link, or another spelling), so it shows the real folder before the owner confirms.
//   - remove: the entry exactly as the rules write it.
//   - Then core `preparePolicyEdit` builds the unsigned `policy.set`. The server keeps that body
//     (per server, at most MAX_REVIEWS, until it expires) under its hash, base64url SHA-256 of its
//     JCS, and answers the folder, every warning code and that hash as an opaque review token.
//   - D-109: when core would have to ask "Keep delivery receipts on?", a folder edit would silently
//     sign them off. The review is refused (`receipts_question`) and the page sends the owner to
//     Rules, which asks. Nothing is kept.
// - POST /api/ui/files/folders (`presence: true`, behind the central gate): input
//   `{ review, acknowledged }`. D-119: the server signs ONLY when `acknowledged` is exactly the set
//   of warning codes returned for the body kept under `review`: a missing, extra, repeated or unknown
//   code is refused before `sign` is called. Because the acknowledgement is checked against the body
//   that hash names, and each review is used once whatever the outcome, an acknowledgement can't be
//   replayed onto another edit, or onto the same edit twice. Before signing, the hash is recomputed
//   and an added folder is checked again (a folder swapped for a link since the review is refused).
//   Then `sign` signs exactly that body, once, and core applies it (I-4).
//
// The browser never signs and never sees the body: only the folder, the codes and the token.
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import process from 'node:process';
import {
  POLICY_EDIT_WARNING_CODES,
  expandHome,
  isInsideFolder,
  parseAbsolutePath,
  protectedRoots,
  segmentsBelow,
  type OwnerActionOutcome,
  type PathFlavor,
} from '@4thtech-io/core';
import {
  canonicalize,
  encodeBase64url,
  encodeUtf8,
  sha256,
  type JsonObject,
  type JsonValue,
} from '@4thtech-io/crypto';
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

/** 06 §3 `files.allowedFolders`: at most 32. */
const MAX_FOLDERS = 32;
/** Reviews kept per server; the oldest goes first. */
const MAX_REVIEWS = 8;
/** 06 §3 path bound, in UTF-16 units here (the bytes are bounded by core's schema). */
const MAX_PATH_CHARS = 4096;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/**
 * Control, format (bidi, zero-width), separator and lone surrogate characters: never shown, never
 * signed.
 */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const CODES: ReadonlySet<string> = new Set(POLICY_EDIT_WARNING_CODES);

export type FolderRefusal =
  | 'not_full_path'
  | 'dot_segments'
  | 'not_showable'
  | 'missing'
  | 'not_folder'
  | 'too_broad'
  | 'protected'
  | 'contains_protected'
  | 'hidden'
  | 'already_allowed'
  | 'too_many'
  | 'not_allowed';

type Checked =
  | { readonly ok: true; readonly folder: string; readonly elsewhere: boolean }
  | { readonly ok: false; readonly reason: FolderRefusal; readonly protectedFolder?: string };

const result = (status: number, body: JsonValue): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze(body) as JsonValue });
const fixed = (status: number, error: string): LocalUiResult => result(status, { error });
const refused = (reason: FolderRefusal, protectedFolder?: string): LocalUiResult =>
  result(422, {
    error: 'folder_refused',
    reason,
    ...(protectedFolder === undefined ? {} : { protectedFolder }),
  });
const INVALID = fixed(400, 'invalid');
const FAILED = fixed(500, 'failed');

const showable = (s: string): boolean => !UNSHOWABLE.test(s);

const segmentsOf = (path: string, flavor: PathFlavor): readonly string[] =>
  parseAbsolutePath(path, flavor)?.segments ?? [];

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** `~` expanded, one trailing separator removed: a full, clean, showable path, or a refusal. */
function lexical(
  typed: string,
  home: string,
  flavor: PathFlavor,
): { ok: true; path: string } | { ok: false; reason: FolderRefusal } {
  if (typed.length === 0 || !showable(typed)) return { ok: false, reason: 'not_showable' };
  let path = expandHome(typed, home, flavor);
  if (path.split(flavor === 'posix' ? '/' : /[\\/]/).some((s) => s === '.' || s === '..')) {
    return { ok: false, reason: 'dot_segments' };
  }
  const sep = flavor === 'posix' ? /[/]$/ : /[\\/]$/;
  if (path.length > 1 && sep.test(path) && parseAbsolutePath(path.slice(0, -1), flavor)) {
    path = path.slice(0, -1);
  }
  if (parseAbsolutePath(path, flavor) === undefined) return { ok: false, reason: 'not_full_path' };
  return { ok: true, path };
}

/** The 04 §4 and D-99 checks for a folder the owner allows (see the header). */
async function checkFolder(typed: string, home: string, flavor: PathFlavor): Promise<Checked> {
  const shaped = lexical(typed, home, flavor);
  if (!shaped.ok) return shaped;
  const { path } = shaped;
  try {
    if (!(await stat(path)).isDirectory()) return { ok: false, reason: 'not_folder' };
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const real = await realpathOrUndefined(path);
  if (real === undefined) return { ok: false, reason: 'missing' };
  if (!showable(real) || parseAbsolutePath(real, flavor) === undefined) {
    return { ok: false, reason: 'not_showable' };
  }
  const homes = [home];
  const homeReal = await realpathOrUndefined(home);
  if (homeReal !== undefined && homeReal !== home) homes.push(homeReal);
  const inside = { flavor, self: 'inside' } as const;
  if (segmentsOf(real, flavor).length === 0 || homes.some((h) => isInsideFolder(h, real, inside))) {
    return { ok: false, reason: 'too_broad' };
  }
  const roots = homes.flatMap((h) => protectedRoots(h, flavor));
  const ci = { caseInsensitive: true } as const;
  for (const root of roots) {
    const forms = [root];
    const rootReal = await realpathOrUndefined(root);
    if (rootReal !== undefined && rootReal !== root) forms.push(rootReal);
    // The real folder is a protected folder or inside one (in either of its forms).
    if (forms.some((form) => segmentsBelow(real, form, flavor, ci) !== undefined)) {
      return { ok: false, reason: 'protected' };
    }
  }
  for (const root of roots) {
    const forms = [root];
    const rootReal = await realpathOrUndefined(root);
    if (rootReal !== undefined && rootReal !== root) forms.push(rootReal);
    // D-99: the real folder holds a protected folder (whether or not it exists: fail closed).
    if (forms.some((form) => segmentsBelow(form, real, flavor, ci) !== undefined)) {
      const below = segmentsBelow(root, home, flavor);
      const shown =
        below === undefined ? root : ['~', ...below].join(flavor === 'posix' ? '/' : '\\');
      return showable(shown)
        ? { ok: false, reason: 'contains_protected', protectedFolder: shown }
        : { ok: false, reason: 'protected' };
    }
  }
  if (segmentsOf(real, flavor).some((s) => s.startsWith('.'))) {
    return { ok: false, reason: 'hidden' };
  }
  // A link anywhere on the way, or another spelling of the same folder: the real one is signed.
  return { ok: true, folder: real, elsewhere: real !== path };
}

/** A body kept for one review (per server). */
interface Review {
  readonly change: 'add' | 'remove';
  /** add: the real folder; remove: the entry as the rules write it. */
  readonly folder: string;
  readonly body: JsonObject;
  readonly codes: readonly string[];
  readonly expiresAtMs: number;
}

const hashOf = (jcs: string): string => encodeBase64url(sha256(encodeUtf8(jcs)));

/** The one query parameter of a review: `add` or `remove`, once, 1–4096 characters. */
function parseReviewQuery(
  query: URLSearchParams,
):
  | { readonly change: 'add' | 'remove'; readonly path: string; readonly baseVersion: number }
  | undefined {
  const keys = [...query.keys()];
  if (keys.length !== 2 || query.getAll('version').length !== 1) return undefined;
  const change = keys.find((k) => k !== 'version');
  if (change !== 'add' && change !== 'remove') return undefined;
  if (query.getAll(change).length !== 1) return undefined;
  const path = query.get(change);
  if (path === null || path.length === 0 || path.length > MAX_PATH_CHARS) return undefined;
  const version = query.get('version') ?? '';
  if (!/^(0|[1-9][0-9]{0,14})$/.test(version)) return undefined;
  return { change, path, baseVersion: Number(version) };
}

/** The POST input, strictly: `{ review, acknowledged }` and nothing else. */
function parseCommit(
  input: JsonValue | undefined,
): { readonly review: string; readonly acknowledged: readonly string[] } | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'acknowledged' || keys[1] !== 'review') return undefined;
  const { review, acknowledged } = input as { review: unknown; acknowledged: unknown };
  if (typeof review !== 'string' || !TOKEN.test(review)) return undefined;
  if (!Array.isArray(acknowledged) || acknowledged.length > CODES.size) return undefined;
  if (!acknowledged.every((c): c is string => typeof c === 'string' && CODES.has(c))) {
    return undefined;
  }
  return { review, acknowledged };
}

const sameStrings = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The folders in a prepared `policy.set` body, or undefined when it has another shape. */
function foldersOf(body: JsonObject): readonly unknown[] | undefined {
  const params = body['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
  const policy = (params as JsonObject)['policy'];
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) return undefined;
  const files = (policy as JsonObject)['files'];
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return undefined;
  const folders = (files as JsonObject)['allowedFolders'];
  return Array.isArray(folders) ? folders : undefined;
}

function applyAnswer(outcome: OwnerActionOutcome): LocalUiResult {
  if (outcome.status === 'applied') {
    return result(200, { status: 'applied', confirmed: outcome.markRaised !== false });
  }
  switch (outcome.reason) {
    case 'version_not_newer':
    case 'store_changed':
    case 'nonce_used':
      return fixed(409, 'changed');
    case 'expired':
      return fixed(409, 'expired');
    default:
      return fixed(409, 'not_applied');
  }
}

export interface FilesRouteOptions {
  /** The home folder `~` stands for. Default: the OS user's. */
  readonly home?: string;
  /** The path flavour. Default: this platform's. */
  readonly flavor?: PathFlavor;
}

/** The Files routes; each server (context) keeps its own reviews. */
export function createFilesRoutes(options: FilesRouteOptions = {}): readonly LocalUiRoute[] {
  const flavor: PathFlavor = options.flavor ?? (process.platform === 'win32' ? 'win32' : 'posix');
  const homeOf = (): string => options.home ?? homedir();
  const kept = new WeakMap<LocalUiContext, Map<string, Review>>();
  const reviewsOf = (context: LocalUiContext): Map<string, Review> => {
    let map = kept.get(context);
    if (map === undefined) {
      map = new Map();
      kept.set(context, map);
    }
    return map;
  };

  async function list(context: LocalUiContext, request: LocalUiRequest): Promise<LocalUiResult> {
    if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
    const client = context.client;
    if (client === undefined) return UI_NOT_SET_UP;
    let folders: { readonly configured: readonly string[]; readonly resolved: readonly string[] };
    try {
      folders = await client.files.resolvedFolders();
    } catch {
      return UI_UNAVAILABLE;
    }
    // L-1: the version the owner's view is built on. An empty patch prepares an inert body (signed
    // never, kept never) only to learn it; the review passes it back as `baseVersion`, so an edit
    // made on this view after the rules changed is refused (`stale_version`), never undoing it.
    let version: number | null = null;
    try {
      const probe = await client.files.preparePolicyEdit({});
      if (probe.status === 'prepared') version = probe.baseVersion;
    } catch {
      version = null;
    }
    const home = homeOf();
    const resolvedByCore = new Set(folders.resolved);
    const rows = await Promise.all(
      folders.configured.map(async (path) => {
        const real = await realpathOrUndefined(expandHome(path, home, flavor));
        // Core is the authority on what resolves; this only pairs each entry with its realpath.
        return { path, resolved: real !== undefined && resolvedByCore.has(real) ? real : null };
      }),
    );
    return result(200, { folders: rows, max: MAX_FOLDERS, version });
  }

  async function review(context: LocalUiContext, request: LocalUiRequest): Promise<LocalUiResult> {
    const parsed = parseReviewQuery(request.query);
    if (parsed === undefined) return UI_INVALID_QUERY;
    const client = context.client;
    if (client === undefined) return UI_NOT_SET_UP;
    let configured: readonly string[];
    try {
      configured = (await client.files.resolvedFolders()).configured;
    } catch {
      return UI_UNAVAILABLE;
    }
    let folder: string;
    let elsewhere = false;
    let next: string[];
    if (parsed.change === 'add') {
      const checked = await checkFolder(parsed.path, homeOf(), flavor);
      if (!checked.ok) return refused(checked.reason, checked.protectedFolder);
      folder = checked.folder;
      elsewhere = checked.elsewhere;
      if (configured.includes(folder)) return refused('already_allowed');
      if (configured.length >= MAX_FOLDERS) return refused('too_many');
      next = [...configured, folder];
    } else {
      // L-3: the same showable rule as an add (no control, format, bidi or lone surrogate).
      if (!showable(parsed.path)) return refused('not_showable');
      if (!configured.includes(parsed.path)) return refused('not_allowed');
      folder = parsed.path;
      next = configured.filter((entry) => entry !== parsed.path);
    }

    let prepared: Awaited<ReturnType<typeof client.files.preparePolicyEdit>>;
    try {
      prepared = await client.files.preparePolicyEdit(
        { files: { allowedFolders: next } },
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
    // What is shown is what is signed: the body is the folders asked for, in its one encoding.
    if (
      prepared.op !== 'policy.set' ||
      prepared.jcs !== canonicalize(body) ||
      typeof expiresAt !== 'number' ||
      !sameStrings(foldersOf(body) ?? [], next) ||
      foldersOf(body) === undefined
    ) {
      return UI_UNAVAILABLE;
    }
    const codes = prepared.warnings.map((w) => w.code as string);
    if (!codes.every((c) => CODES.has(c)) || new Set(codes).size !== codes.length) {
      return UI_UNAVAILABLE;
    }
    const token = hashOf(prepared.jcs);
    const reviews = reviewsOf(context);
    reviews.set(token, {
      change: parsed.change,
      folder,
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
      change: parsed.change,
      folder,
      typed: parsed.path,
      elsewhere,
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
    const kept = reviews.get(input.review);
    // One use, whatever happens next.
    reviews.delete(input.review);
    if (kept === undefined) return fixed(409, 'unknown_review');
    if (context.now() >= kept.expiresAtMs) return fixed(409, 'expired');
    // D-119: exactly the codes returned for THIS body, each once.
    const given = new Set(input.acknowledged);
    if (
      given.size !== input.acknowledged.length ||
      given.size !== kept.codes.length ||
      !kept.codes.every((code) => given.has(code))
    ) {
      return fixed(409, 'not_acknowledged');
    }
    if (hashOf(canonicalize(kept.body)) !== input.review) return fixed(409, 'unknown_review');
    if (kept.change === 'add') {
      const again = await checkFolder(kept.folder, homeOf(), flavor);
      if (!again.ok || again.folder !== kept.folder) return fixed(409, 'folder_changed');
    }
    const lines =
      kept.change === 'add'
        ? [
            `Allow your AI to send files from ${kept.folder} and its subfolders to your contacts.`,
            'Hidden files are never sent.',
          ]
        : [`Stop your AI from sending files from ${kept.folder}.`];
    const [signature] = await owner.sign({ lines }, [{ kind: 'owner-action', action: kept.body }]);
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
    Object.freeze({ method: 'GET', path: '/api/ui/files', presence: false, handler: list }),
    Object.freeze({
      method: 'GET',
      path: '/api/ui/files/review',
      presence: false,
      handler: review,
    }),
    Object.freeze({
      method: 'POST',
      path: '/api/ui/files/folders',
      presence: true,
      handler: commit,
    }),
  ]);
}

export const filesRoutes: readonly LocalUiRoute[] = createFilesRoutes();
