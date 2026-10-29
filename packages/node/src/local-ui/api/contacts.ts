// M1-11c-a2: the Contacts page's API (08 §1; 04 §2.5.1, §3.6.1; 06 §2.1; 11 §5.2; D-118; I-4, I-5).
//
// Reads (`presence: false`), through the read-only client view (context.ts):
// - `GET /api/ui/contacts`: every contact that is not removed, oldest first.
// - `GET /api/ui/contacts/:ref/safety-code`: the 12 digits, recomputed now from the stored signed
//   `handshake` and `handshake-ack` (core `ownerSafetyCode`). This is an owner surface (04 §3.6.1):
//   the digits never reach a tool result, and the pairing digest never leaves this file.
// - `GET /api/ui/contacts/:ref/rename-check?alias=`: whether core would sign that name, so the page
//   asks for presence only for a name that can be applied. It prepares and discards; nothing is
//   signed or written.
//
// Owner routes (`presence: true`): the central gate checks owner presence before the handler runs
// (approval-server.ts). Each handler builds the unsigned body with core's prepare helper (#415), signs
// it once through the gate's one-use `sign` with fixed review lines (never the contact's own name,
// I-5), and hands the signed object to core's `ownerActions.apply`, which verifies it (I-4).
// - `POST …/check` ("They match"): input `{code}`, the code the page showed. It is signed only when
//   the code recomputed now is that code and the prepared digest is the one behind it, so the owner
//   never signs a code they did not compare (a re-pair in between changes it).
// - `POST …/rename`: input `{alias}`; core checks the restricted form and uniqueness.
// - `POST …/remove`: no input.
// A handler that returns without signing performed nothing; the gate answers 409 `refused`.
//
// "They don't match" has no route: it signs nothing (04 §3.6.1), and the shell has no unsigned owner
// write yet, so the page offers Remove (signed). Blocking from the page is a follow-up.
//
// What leaves (UX north star; 11 §5.2): a contact's `ref` (its ID, used only in these paths and never
// shown), the name core shows (the owner's alias, or the contact's own name after restrictName), the
// short fingerprint only for a contact's own name (the name rule's fallback), a label no stronger
// than core's, a status, the pairing state and a date. Never the card, a key, the raw name, the
// pairing digest or an error's text. A row with a value this file does not know is left out.
// M1-UX3-DUP-CONTACTS: a newer active contact with the same owner as an older active one also
// carries `olderSameOwner`, that older contact's ref (a ref the list already shows); the full owner
// fingerprint is only a grouping key here and never leaves.
// W4-RENAME-REACHES-CONTACTS (D-141; 08 §1): a contact whose card-update changed its name, with the
// note not seen yet, also carries `formerName`, core's restricted form of the name the owner last saw
// (the seen mark is api/contacts-renamed.ts). The label and "Safety code checked" stay as core says.
import type { ContactView, PreparedOwnerAction } from '@4thtech-io/core';
import type { JsonObject, JsonValue } from '@4thtech-io/crypto';
import type { LocalUiContext } from '../context.js';
import {
  UI_INVALID_QUERY,
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';

/** A contact's ID: its agent's EVM address, lowercase (04 §2.9). */
const REF = /^0x[0-9a-f]{40}$/;
/** The shown safety code: three groups of four digits (04 §3.6.1). */
const CODE = /^[0-9]{4} [0-9]{4} [0-9]{4}$/;
/** The short owner fingerprint core shows (04 §2.9). */
const FINGERPRINT = /^[0-9A-F]{4}·[0-9A-F]{4}$/;
/** An alias as typed; core checks the restricted form (at most 32 code points). */
const MAX_ALIAS_CHARS = 128;
const MAX_NAME_CHARS = 128;

const STATUS: ReadonlySet<string> = new Set(['active', 'blocked', 'revoked']);
const PAIRING: ReadonlySet<string> = new Set(['pending', 'complete', 'mismatch']);

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

/** 404: the path names no contact this page can act on. */
const NOT_FOUND = fixed(404, 'not_found');
/** Nothing was signed (the gate answers 409 `refused` for it anyway). */
const NOT_SIGNED = fixed(409, 'refused');
/** Signed, but core did not apply it (a fixed code; the page says to try again). */
const NOT_APPLIED = fixed(409, 'not_applied');
const DONE: LocalUiResult = Object.freeze({ status: 200, body: Object.freeze({ status: 'done' }) });

/**
 * D-141 (07 §3 "Former name"): `formerName` while core says a note is due, only as core's restricted
 * form (the name rule, 06 §2.1) and only as short plain text; never the raw name.
 */
function formerNameOf(view: ContactView): {
  readonly formerName?: string;
  readonly newName?: string;
} {
  const plain = (name: unknown): name is string =>
    typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_CHARS;
  const former: unknown = view.nameChange?.formerName;
  if (!plain(former)) return {};
  // Under the owner's alias the row's name stays the alias: the note reads "Now calls itself
  // {newName} (was {formerName})", so the contact's own new name (restricted) comes with it.
  if (view.display.nameSource !== 'owner') return { formerName: former };
  const own: unknown = view.nameChange?.newName;
  return plain(own) ? { formerName: former, newName: own } : {};
}

function row(view: ContactView): JsonObject | undefined {
  if (typeof view.id !== 'string' || !REF.test(view.id)) return undefined;
  if (!STATUS.has(view.status) || !PAIRING.has(view.pairing)) return undefined;
  if (!Number.isSafeInteger(view.createdAt) || view.createdAt < 0) return undefined;
  const { display } = view;
  const name: unknown = display.name;
  if (typeof name !== 'string' || name.length > MAX_NAME_CHARS) return undefined;
  const owner = display.nameSource === 'owner';
  // Never stronger than core: "Safety code checked" only while core re-verified it on this read.
  const checked = display.label === 'safety-code-checked' && view.safetyCodeChecked === true;
  const short = view.ownerFingerprint.short;
  return {
    ref: view.id,
    name,
    nameSource: owner ? 'owner' : 'counterparty',
    ...(!owner && typeof short === 'string' && FINGERPRINT.test(short)
      ? { fingerprint: short }
      : {}),
    label: checked ? 'safety-code-checked' : 'self-declared',
    status: view.status,
    pairing: view.pairing,
    since: view.createdAt,
    // W4-RENAME-REACHES-CONTACTS (D-141; 08 §1): the unseen former name, as core restricted it.
    ...formerNameOf(view),
  };
}

/**
 * M1-UX3-DUP-CONTACTS: for each active contact, the ref of the next older active contact with the
 * same owner (same full owner fingerprint, 04 §2.9; cards are owner-signed, so the same fingerprint
 * means the same owner keys). Older is by pairing date, then list order. Only refs leave; the
 * fingerprint is used here as a grouping key and never added to a row.
 */
function olderSameOwner(views: readonly ContactView[]): ReadonlyMap<number, string> {
  const byDate = views
    .map((view, i) => ({ view, i }))
    .filter(({ view }) => {
      const long: unknown = view.ownerFingerprint.long;
      return view.status === 'active' && typeof long === 'string' && long.length > 0;
    })
    .sort((a, b) => a.view.createdAt - b.view.createdAt || a.i - b.i);
  const last = new Map<string, string>();
  const links = new Map<number, string>();
  for (const { view, i } of byDate) {
    const key = view.ownerFingerprint.long;
    const older = last.get(key);
    if (older !== undefined) links.set(i, older);
    last.set(key, view.id);
  }
  return links;
}

async function listContacts(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return UI_NOT_SET_UP;
  if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
  try {
    const views: ContactView[] = [];
    const rows: JsonObject[] = [];
    for (const view of await client.contacts.list()) {
      const out = row(view);
      if (out === undefined) continue;
      views.push(view);
      rows.push(out);
    }
    const links = olderSameOwner(views);
    const contacts = rows.map((out, i) => {
      const older = links.get(i);
      return older === undefined ? out : { ...out, olderSameOwner: older };
    });
    return { status: 200, body: { status: 'ok', contacts } };
  } catch {
    // Never the error's text: it could name a path.
    return UI_UNAVAILABLE;
  }
}

const refOf = (request: LocalUiRequest): string | undefined => {
  const ref = request.params['ref'];
  return ref !== undefined && REF.test(ref) ? ref : undefined;
};

async function safetyCode(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return UI_NOT_SET_UP;
  const ref = refOf(request);
  if (ref === undefined) return NOT_FOUND;
  if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
  try {
    const found = await client.contacts.safetyCode(ref);
    if (found.status === 'ok' && typeof found.code === 'string' && CODE.test(found.code)) {
      return { status: 200, body: { status: 'ok', code: found.code } };
    }
    // "Can't show the safety code" (04 §3.6.1 step 5): no reason, no digest.
    return { status: 200, body: { status: 'unavailable' } };
  } catch {
    return UI_UNAVAILABLE;
  }
}

/** The one `alias` query value, or undefined when anything else is there. */
function aliasQuery(query: URLSearchParams): string | undefined {
  for (const key of query.keys()) if (key !== 'alias') return undefined;
  const all = query.getAll('alias');
  if (all.length !== 1) return undefined;
  const alias = all[0] as string;
  return alias.length > 0 && alias.length <= MAX_ALIAS_CHARS ? alias : undefined;
}

/** The refusals the page explains; anything else is "can't rename right now". */
const RENAME_REFUSALS: ReadonlySet<string> = new Set([
  'alias_invalid',
  'alias_taken',
  'contact_unknown',
]);

async function renameCheck(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return UI_NOT_SET_UP;
  const ref = refOf(request);
  if (ref === undefined) return NOT_FOUND;
  const alias = aliasQuery(request.query);
  if (alias === undefined) return UI_INVALID_QUERY;
  try {
    const prepared = await client.contacts.prepareRename(ref, alias);
    if (prepared.status === 'prepared') return { status: 200, body: { status: 'ok' } };
    const reason = RENAME_REFUSALS.has(prepared.reason) ? prepared.reason : 'unavailable';
    return { status: 200, body: { status: 'refused', reason } };
  } catch {
    return UI_UNAVAILABLE;
  }
}

/** A plain object with exactly these keys, or undefined. */
function inputWith(input: JsonValue | undefined, keys: readonly string[]): JsonObject | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const own = Object.keys(input);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k))) return undefined;
  return input as JsonObject;
}

/**
 * Signs a prepared body once with the gate's presence and applies it through core (I-4). The review
 * lines are fixed text (I-5). Errors from `sign` propagate: the gate answers them.
 */
async function signAndApply(
  context: LocalUiContext,
  owner: LocalUiOwnerOperation,
  prepared: Extract<PreparedOwnerAction, { status: 'prepared' }>,
  lines: readonly string[],
): Promise<LocalUiResult> {
  const signatures = await owner.sign({ lines }, [
    { kind: 'owner-action', action: prepared.body as unknown as JsonObject },
  ]);
  const first = signatures[0];
  if (signatures.length !== 1 || first === undefined || first.kind !== 'owner-action') {
    return NOT_APPLIED;
  }
  const outcome = await context.applyOwnerAction(first.signed);
  return outcome.status === 'applied' ? DONE : NOT_APPLIED;
}

const CHECK_LINES = Object.freeze([
  'Mark this contact as Safety code checked.',
  'You compared the 12-digit safety code with them, and it matched.',
]);
const RENAME_LINES = Object.freeze(['Rename this contact on this computer.']);
const REMOVE_LINES = Object.freeze([
  'Remove this contact. Messages from its agent are dropped from now on.',
]);

async function checkContact(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return UI_NOT_SET_UP;
  const ref = refOf(request);
  const input = inputWith(request.input, ['code']);
  const shown = input?.['code'];
  if (ref === undefined || typeof shown !== 'string' || !CODE.test(shown)) return NOT_SIGNED;
  let prepared: PreparedOwnerAction;
  try {
    // The code the owner compared must be the one behind what is signed (04 §3.6.1).
    const now = await client.contacts.safetyCode(ref);
    if (now.status !== 'ok' || now.code !== shown) return NOT_SIGNED;
    prepared = await client.contacts.prepareCheck(ref);
    if (prepared.status !== 'prepared') return NOT_SIGNED;
    const params = (prepared.body as { params?: { contact?: unknown; pairingDigest?: unknown } })
      .params;
    if (
      prepared.body.op !== 'contact.check' ||
      params?.contact !== ref ||
      params.pairingDigest !== now.pairingDigest
    ) {
      return NOT_SIGNED;
    }
  } catch {
    return NOT_SIGNED;
  }
  return signAndApply(context, owner, prepared, CHECK_LINES);
}

async function renameContact(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return UI_NOT_SET_UP;
  const ref = refOf(request);
  const alias = inputWith(request.input, ['alias'])?.['alias'];
  if (
    ref === undefined ||
    typeof alias !== 'string' ||
    alias.length === 0 ||
    alias.length > MAX_ALIAS_CHARS
  ) {
    return NOT_SIGNED;
  }
  let prepared: PreparedOwnerAction;
  try {
    prepared = await client.contacts.prepareRename(ref, alias);
  } catch {
    return NOT_SIGNED;
  }
  if (prepared.status !== 'prepared' || prepared.body.op !== 'contact.rename') return NOT_SIGNED;
  return signAndApply(context, owner, prepared, RENAME_LINES);
}

async function removeContact(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return UI_NOT_SET_UP;
  const ref = refOf(request);
  if (ref === undefined || request.input !== undefined) return NOT_SIGNED;
  let prepared: PreparedOwnerAction;
  try {
    prepared = await client.contacts.prepareRemove(ref);
  } catch {
    return NOT_SIGNED;
  }
  if (prepared.status !== 'prepared' || prepared.body.op !== 'contact.remove') return NOT_SIGNED;
  return signAndApply(context, owner, prepared, REMOVE_LINES);
}

const read = (path: string, handler: LocalUiReadRoute['handler']): LocalUiReadRoute =>
  Object.freeze<LocalUiReadRoute>({ method: 'GET', path, presence: false, handler });

const ownerOp = (path: string, handler: LocalUiOwnerRoute['handler']): LocalUiOwnerRoute =>
  Object.freeze<LocalUiOwnerRoute>({ method: 'POST', path, presence: true, handler });

export const contactsRoutes: readonly LocalUiRoute[] = Object.freeze([
  read('/api/ui/contacts', listContacts),
  read('/api/ui/contacts/:ref/safety-code', safetyCode),
  read('/api/ui/contacts/:ref/rename-check', renameCheck),
  ownerOp('/api/ui/contacts/:ref/check', checkContact),
  ownerOp('/api/ui/contacts/:ref/rename', renameContact),
  ownerOp('/api/ui/contacts/:ref/remove', removeContact),
]);
