// M1-11c-a5: the Rules page's API (08 §1; 06 §3; 11 §5, §6.2; D-118, D-119; I-4, I-5, I-7).
//
// - `GET /api/ui/rules`: the policy in force as the page shows it. Values of the page's own fields
//   and counts; never an agent ID, a folder path or the proof network (UX north star).
// - `GET /api/ui/rules/review?edit=`: the edit (base64url JSON `{ base, patch, keepDeliveryReceipts? }`)
//   goes to core's `preparePolicyEdit` (M1-11r-b). The patch may name only the fields this page edits
//   (EDITABLE): folders, storage, the proof network, contact lists and contact rules are other pages'
//   (Files, Advanced, RU-1). The server keeps the unsigned body it got, for at most its lifetime, and
//   answers its body hash and the warning codes. Preparing signs, writes and grants nothing.
// - `POST /api/ui/rules` (presence, input `{ review, acknowledged }`): D-119. The handler signs only a
//   body this server prepared, named by its hash, before it expires, once, and only when
//   `acknowledged` is exactly that body's warning codes. Anything else returns without signing, and
//   the central gate answers 409 `refused` (approval-server.ts): the owner reviews again. Core's
//   `apply` then verifies the owner signature (I-4).
//
// Fixed answers only, never an error's text or an input value (I-5, I-7).
import type { EffectivePolicy, PreparedPolicyEdit } from '@4thtech-io/core';
import {
  canonicalize,
  decodeBase64url,
  decodeUtf8,
  encodeHex,
  encodeUtf8,
  parseJson,
  sha256,
  type JsonObject,
  type JsonValue,
} from '@4thtech-io/crypto';
import type { LocalUiContext } from '../context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
  LocalUiRequest,
  LocalUiResult,
  LocalUiRoute,
} from '../route-types.js';

const answer = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

// The shared read answers (409 not_set_up, 400 invalid_query, 503 unavailable: the same codes as the
// Activity and Proofs pages, #417 and #418), kept here until one of those lands in route-types.ts.
const NOT_SET_UP = answer(409, 'not_set_up');
const INVALID_QUERY = answer(400, 'invalid_query');
const UNAVAILABLE = answer(503, 'unavailable');
/** The edit names a field this page does not edit, or core refused the patch. */
const INVALID_EDIT = answer(400, 'invalid_edit');
/** The rules changed since the page loaded them (core `stale_version`, or apply `version_not_newer`). */
const STALE = answer(409, 'stale');
/** The rules fail closed: the way back is `agentlink policy recover` (D-100; LS-1). */
const RULES_NOT_VALID = answer(409, 'rules_not_valid');
/** Signed, but core did not apply it. */
const NOT_SAVED = answer(409, 'not_saved');
/** A handler that refuses before signing: the gate answers 409 `refused` whatever this says. */
const NOT_SIGNED = answer(409, 'refused');

/** The fields this page edits, per policy section (06 §3). Anything else is invalid_edit. */
const EDITABLE: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  proofs: new Set(['notarize', 'dailyBudgetUSD', 'perActionMaxUSD', 'allowKeyDisclosure']),
  contacts: new Set(['acceptInvites', 'unknownSenders']),
  files: new Set(['maxSendSizeMB', 'maxReceiveSizeMB']),
  commitments: new Set(['accept', 'autoAcceptDirection', 'autoAcceptMaxUSD', 'autoAcceptMinUSD']),
});

/** Longest `edit` parameter: base64url of a small JSON object. */
const MAX_EDIT_CHARS = 4096;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const HASH = /^[0-9a-f]{64}$/;
/** Prepared bodies kept per server: a few tabs at most; the oldest goes first. */
const MAX_PENDING = 4;
const MAX_ACKNOWLEDGED = 64;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * D-119: true only when `given` is a list naming each `required` code exactly once and nothing
 * else (order free). A copy of this check may also live in the Files page's API (M1-11c-a3); they
 * are kept separate to avoid a merge collision and are to be shared in a follow-up.
 */
export function acknowledgedExactly(required: readonly string[], given: unknown): boolean {
  if (!Array.isArray(given) || given.length !== required.length) return false;
  if (given.length > MAX_ACKNOWLEDGED) return false;
  const seen = new Set<string>();
  for (const code of given as unknown[]) {
    if (typeof code !== 'string' || !required.includes(code) || seen.has(code)) return false;
    seen.add(code);
  }
  return seen.size === new Set(required).size;
}

// --- the prepared bodies this server holds --------------------------------------------------------

interface Pending {
  readonly body: JsonObject;
  readonly jcs: string;
  readonly version: number;
  readonly codes: readonly string[];
  readonly keepDeliveryReceipts: boolean;
  /** Unix seconds: the body's own `expiresAt`. */
  readonly expiresAt: number;
}

/** One map per server context, so a review from one server is unknown to another. */
const pendingByContext = new WeakMap<LocalUiContext, Map<string, Pending>>();

function pendingOf(context: LocalUiContext): Map<string, Pending> {
  let map = pendingByContext.get(context);
  if (map === undefined) {
    map = new Map();
    pendingByContext.set(context, map);
  }
  return map;
}

const nowSeconds = (context: LocalUiContext): number => Math.floor(context.now() / 1000);

function remember(context: LocalUiContext, hash: string, pending: Pending): void {
  const map = pendingOf(context);
  const now = nowSeconds(context);
  for (const [key, p] of map) if (p.expiresAt <= now) map.delete(key);
  while (map.size >= MAX_PENDING) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
  map.set(hash, pending);
}

/** Takes the pending body out (one review signs at most once, whatever happens next). */
function take(context: LocalUiContext, hash: string): Pending | undefined {
  const map = pendingOf(context);
  const pending = map.get(hash);
  map.delete(hash);
  return pending;
}

const bodyHash = (jcs: string): string => encodeHex(sha256(encodeUtf8(jcs)));

// --- GET /api/ui/rules ----------------------------------------------------------------------------

type Doc = Extract<EffectivePolicy, { mode: 'signed' }>['policy'];

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** The page's view: the page's own values and counts (no IDs, paths or networks). */
function view(policy: Doc): JsonObject {
  const p = policy as unknown as {
    proofs: Record<string, unknown>;
    contacts: Record<string, unknown>;
    files: Record<string, unknown>;
    receipts: Record<string, unknown>;
    commitments: Record<string, unknown>;
    contactRules: unknown;
  };
  const allowed = p.contacts.allowed;
  return {
    proofs: {
      notarize: p.proofs.notarize as string,
      dailyBudgetUSD: p.proofs.dailyBudgetUSD as string,
      perActionMaxUSD: p.proofs.perActionMaxUSD as string,
      allowKeyDisclosure: p.proofs.allowKeyDisclosure as string,
    },
    contacts: {
      acceptInvites: p.contacts.acceptInvites as string,
      unknownSenders: p.contacts.unknownSenders as string,
      allowed: allowed === 'paired' ? 'paired' : 'listed',
      listed: count(allowed),
    },
    files: {
      maxSendSizeMB: p.files.maxSendSizeMB as number,
      maxReceiveSizeMB: p.files.maxReceiveSizeMB as number,
      allowedFolders: count(p.files.allowedFolders),
    },
    receipts: { autoDelivered: p.receipts.autoDelivered === true },
    commitments: {
      accept: p.commitments.accept as string,
      autoAcceptDirection: p.commitments.autoAcceptDirection as string,
      autoAcceptMaxUSD: p.commitments.autoAcceptMaxUSD as string,
      autoAcceptMinUSD: (p.commitments.autoAcceptMinUSD ?? null) as string | null,
      autoAcceptContacts: count(p.commitments.autoAcceptContacts),
    },
    contactRules: count(p.contactRules),
  };
}

async function readRules(context: LocalUiContext): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return NOT_SET_UP;
  let effective: EffectivePolicy;
  try {
    effective = await client.policy.load();
  } catch {
    return UNAVAILABLE;
  }
  if (effective.mode === 'fail_closed') return { status: 200, body: { status: 'not_valid' } };
  return {
    status: 200,
    body: {
      status: 'ok',
      version: effective.mode === 'signed' ? effective.version : 0,
      rules: view(effective.policy),
    },
  };
}

// --- GET /api/ui/rules/review ---------------------------------------------------------------------

interface Edit {
  readonly base: number;
  readonly patch: JsonObject;
  readonly keepDeliveryReceipts?: boolean;
}

/** The `edit` query value, decoded; undefined when malformed (invalid_query). */
function decodeEdit(query: URLSearchParams): unknown {
  for (const key of query.keys()) if (key !== 'edit') return undefined;
  const values = query.getAll('edit');
  const raw = values[0];
  if (values.length !== 1 || raw === undefined) return undefined;
  if (raw.length === 0 || raw.length > MAX_EDIT_CHARS || !BASE64URL.test(raw)) return undefined;
  try {
    return parseJson(decodeUtf8(decodeBase64url(raw)));
  } catch {
    return undefined;
  }
}

/** The edit, when it is exactly `{ base, patch, keepDeliveryReceipts? }` on the page's own fields. */
function checkEdit(value: unknown): Edit | undefined {
  if (!isObject(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (key !== 'base' && key !== 'patch' && key !== 'keepDeliveryReceipts') return undefined;
  }
  const { base, patch, keepDeliveryReceipts } = value;
  if (typeof base !== 'number' || !Number.isSafeInteger(base) || base < 0) return undefined;
  if (keepDeliveryReceipts !== undefined && typeof keepDeliveryReceipts !== 'boolean') {
    return undefined;
  }
  if (!isObject(patch)) return undefined;
  let fields = 0;
  for (const [section, part] of Object.entries(patch)) {
    const allowed = Object.hasOwn(EDITABLE, section) ? EDITABLE[section] : undefined;
    if (allowed === undefined || !isObject(part)) return undefined;
    for (const field of Object.keys(part)) {
      if (!allowed.has(field)) return undefined;
      fields += 1;
    }
  }
  if (fields === 0) return undefined;
  return {
    base,
    patch: patch as JsonObject,
    ...(keepDeliveryReceipts === undefined ? {} : { keepDeliveryReceipts }),
  };
}

async function reviewEdit(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return NOT_SET_UP;
  const decoded = decodeEdit(request.query);
  if (decoded === undefined) return INVALID_QUERY;
  const edit = checkEdit(decoded);
  if (edit === undefined) return INVALID_EDIT;
  let prepared: PreparedPolicyEdit;
  try {
    prepared = await client.policy.prepareEdit(edit.patch, {
      baseVersion: edit.base,
      ...(edit.keepDeliveryReceipts === undefined
        ? {}
        : { keepDeliveryReceipts: edit.keepDeliveryReceipts }),
    });
  } catch {
    return UNAVAILABLE;
  }
  if (prepared.status !== 'prepared') {
    switch (prepared.reason) {
      case 'patch_invalid':
        return INVALID_EDIT;
      case 'stale_version':
        return STALE;
      case 'policy_not_valid':
        return RULES_NOT_VALID;
      default:
        return NOT_SET_UP;
    }
  }
  // Every code core returned is shown and must be acknowledged. Only how many contacts a warning
  // names leaves, never who (UX north star: no agent IDs on this page).
  const warnings: JsonObject[] = prepared.warnings.map((w) => {
    const contacts = w.contacts?.length ?? 0;
    return contacts > 0 ? { code: w.code, contacts } : { code: w.code };
  });
  const codes = [...new Set(prepared.warnings.map((w) => w.code))];
  const hash = bodyHash(prepared.jcs);
  remember(context, hash, {
    body: prepared.body as unknown as JsonObject,
    jcs: prepared.jcs,
    version: prepared.version,
    codes,
    keepDeliveryReceipts: prepared.keepDeliveryReceipts,
    expiresAt: prepared.body.expiresAt,
  });
  return {
    status: 200,
    body: {
      status: 'review',
      review: hash,
      warnings,
      askKeepDeliveryReceipts: prepared.askKeepDeliveryReceipts,
    },
  };
}

// --- M1-PAY-CONFIRM-a: a reviewed body for the paid-action confirmation ---------------------------

/** A reviewed rules body, taken for the confirmation sheet's begin (04 §2.5.3). */
export interface ReviewedRulesEdit {
  readonly body: JsonObject;
  readonly version: number;
  readonly keepDeliveryReceipts: boolean;
}

/**
 * Takes the body this server prepared and the page reviewed, under the same rules as a save
 * (D-119): named by its hash, before it expires, once, and only when `acknowledged` is exactly its
 * warning codes. Undefined otherwise (the owner reviews again). It signs nothing: the
 * paid-action confirmation signs it after the owner's verification (approval-server.ts).
 */
export function takeReviewedRules(
  context: LocalUiContext,
  review: unknown,
  acknowledged: unknown,
): ReviewedRulesEdit | undefined {
  if (typeof review !== 'string' || !HASH.test(review)) return undefined;
  const pending = take(context, review);
  if (pending === undefined) return undefined;
  if (pending.expiresAt <= nowSeconds(context)) return undefined;
  if (!acknowledgedExactly(pending.codes, acknowledged)) return undefined;
  if (bodyHash(canonicalize(pending.body)) !== review) return undefined;
  return {
    body: pending.body,
    version: pending.version,
    keepDeliveryReceipts: pending.keepDeliveryReceipts,
  };
}

// --- POST /api/ui/rules ---------------------------------------------------------------------------

/** What the owner's presence prompt context shows (fixed text, I-5; the page was the review). */
const REVIEW_LINES = Object.freeze(['Save the changes to your rules that you reviewed.']);

async function saveEdit(
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return NOT_SIGNED;
  const input: JsonValue | undefined = request.input;
  if (!isObject(input)) return NOT_SIGNED;
  for (const key of Object.keys(input)) {
    if (key !== 'review' && key !== 'acknowledged') return NOT_SIGNED;
  }
  const { review, acknowledged } = input;
  if (typeof review !== 'string' || !HASH.test(review)) return NOT_SIGNED;
  const pending = take(context, review);
  if (pending === undefined) return NOT_SIGNED;
  if (pending.expiresAt <= nowSeconds(context)) return NOT_SIGNED;
  // D-119: every warning of exactly this body, acknowledged, and nothing else.
  if (!acknowledgedExactly(pending.codes, acknowledged)) return NOT_SIGNED;
  // Defence in depth: the kept body is still the one its hash names.
  if (bodyHash(canonicalize(pending.body)) !== review) return NOT_SIGNED;

  const signatures = await owner.sign({ lines: REVIEW_LINES }, [
    { kind: 'owner-action', action: pending.body },
  ]);
  const signed = signatures[0];
  if (
    signatures.length !== 1 ||
    signed?.kind !== 'owner-action' ||
    bodyHash(canonicalize(signed.signed.body)) !== review
  ) {
    return answer(500, 'failed');
  }
  const outcome = await context.applyOwnerAction(signed.signed);
  if (outcome.status !== 'applied') {
    return outcome.reason === 'version_not_newer' ? STALE : NOT_SAVED;
  }
  if (pending.keepDeliveryReceipts) {
    // D-109: the owner kept receipts on; record it so the next edit does not ask again. A failure
    // only means the owner is asked again later (it grants nothing).
    await client.policy.recordReceiptsKept(pending.version).catch(() => false);
  }
  return { status: 200, body: { status: 'saved', version: pending.version } };
}

export const rulesRoutes: readonly LocalUiRoute[] = Object.freeze([
  Object.freeze<LocalUiReadRoute>({
    method: 'GET',
    path: '/api/ui/rules',
    presence: false,
    handler: (context) => readRules(context),
  }),
  Object.freeze<LocalUiReadRoute>({
    method: 'GET',
    path: '/api/ui/rules/review',
    presence: false,
    handler: reviewEdit,
  }),
  Object.freeze<LocalUiOwnerRoute>({
    method: 'POST',
    path: '/api/ui/rules',
    presence: true,
    handler: saveEdit,
  }),
]);
