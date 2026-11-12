// The page's reads (packages/node/src/local-ui/api/contacts.ts; the shared answers 409 not_set_up
// and 503 unavailable are in its route-types.ts), checked before use. A contact's name is the one
// free-form value: it is kept as a string and only ever rendered as React text, through the ui name
// rule (formatContactName). Every other value is a fixed word, a number or a value of a known shape;
// a row with anything else is left out.

export type NameSource = 'owner' | 'counterparty';
export type Label = 'self-declared' | 'safety-code-checked';
export type ContactState = 'active' | 'blocked' | 'revoked';
export type Pairing = 'pending' | 'complete' | 'mismatch';

export interface ContactRow {
  /** The contact's ID, used only in API paths; never shown. */
  readonly ref: string;
  readonly name: string;
  readonly nameSource: NameSource;
  /** The short fingerprint, for the name rule's fallback only. */
  readonly fingerprint?: string;
  readonly label: Label;
  readonly status: ContactState;
  readonly pairing: Pairing;
  /** Unix seconds. */
  readonly since: number;
  /**
   * M1-UX3-DUP-CONTACTS: the ref of the next older contact with the same owner (the server groups
   * by ID tag and sends only the ref). Never shown.
   */
  readonly olderSameOwner?: string;
  /** W5-INVITE-FEEDBACK: unix seconds of the kept pairing; a later one is a re-pair. Never shown. */
  readonly pairedAt?: number;
  /** W5-INVITE-FEEDBACK: this agent's role in that pairing. Never shown. */
  readonly pairedAs?: 'inviter' | 'invitee';
  /** D-141 (08 §1 C2): the name before a rename, while the note is due; plain text only. */
  readonly formerName?: string;
}

export type ListAnswer =
  | { readonly kind: 'ok'; readonly contacts: readonly ContactRow[] }
  | { readonly kind: 'not_set_up' }
  | { readonly kind: 'error' };

export type CodeAnswer =
  { readonly kind: 'ok'; readonly code: string } | { readonly kind: 'unavailable' };

export type RenameCheck =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'refused';
      readonly reason: 'alias_invalid' | 'alias_taken' | 'contact_unknown' | 'unavailable';
    };

export const LIST_PATH = '/api/ui/contacts';
const REF = /^0x[0-9a-f]{40}$/;
const CODE = /^[0-9]{4} [0-9]{4} [0-9]{4}$/;
const FINGERPRINT = /^[0-9A-Fa-f]{4}(?:[ ·-]?[0-9A-Fa-f]{4}){1,3}$/;
/** Shown in groups of four, upper case, joined by the middle dot (B-11 §7). */
const groupFingerprint = (fp: string): string =>
  (fp.replace(/[ ·-]/g, '').toUpperCase().match(/.{4}/g) ?? []).join('·');
const MAX_NAME = 128;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T =>
  typeof v === 'string' && (set as readonly string[]).includes(v);

function row(v: unknown): ContactRow | undefined {
  if (!isObject(v)) return undefined;
  const { ref, name, nameSource, fingerprint, label, status, pairing, since, olderSameOwner } = v;
  const pairedAt = v['pairedAt'];
  const pairedAs = v['pairedAs'];
  const former = v['formerName'];
  if (typeof ref !== 'string' || !REF.test(ref)) return undefined;
  if (typeof name !== 'string' || name.length > MAX_NAME) return undefined;
  if (!oneOf(nameSource, ['owner', 'counterparty'] as const)) return undefined;
  if (!oneOf(label, ['self-declared', 'safety-code-checked'] as const)) return undefined;
  if (!oneOf(status, ['active', 'blocked', 'revoked'] as const)) return undefined;
  if (!oneOf(pairing, ['pending', 'complete', 'mismatch'] as const)) return undefined;
  if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0) return undefined;
  const fp = typeof fingerprint === 'string' && FINGERPRINT.test(fingerprint) ? fingerprint : null;
  const older =
    typeof olderSameOwner === 'string' && REF.test(olderSameOwner) && olderSameOwner !== ref
      ? olderSameOwner
      : null;
  return {
    ref,
    name,
    nameSource,
    label,
    status,
    pairing,
    since,
    ...(fp === null ? {} : { fingerprint: groupFingerprint(fp) }),
    ...(older === null ? {} : { olderSameOwner: older }),
    ...(typeof pairedAt === 'number' && Number.isSafeInteger(pairedAt) && pairedAt >= 0
      ? { pairedAt }
      : {}),
    ...(pairedAs === 'inviter' || pairedAs === 'invitee' ? { pairedAs } : {}),
    ...(typeof former === 'string' && former !== '' && former.length <= MAX_NAME
      ? { formerName: former }
      : {}),
  };
}

export function parseList(data: unknown): ListAnswer {
  if (!isObject(data) || data.status !== 'ok' || !Array.isArray(data.contacts)) {
    return { kind: 'error' };
  }
  const contacts: ContactRow[] = [];
  for (const item of data.contacts as unknown[]) {
    const r = row(item);
    if (r !== undefined) contacts.push(r);
  }
  return { kind: 'ok', contacts };
}

export function parseCode(data: unknown): CodeAnswer {
  if (isObject(data) && data.status === 'ok' && typeof data.code === 'string') {
    if (CODE.test(data.code)) return { kind: 'ok', code: data.code };
  }
  return { kind: 'unavailable' };
}

export function parseRenameCheck(data: unknown): RenameCheck {
  if (isObject(data) && data.status === 'ok') return { kind: 'ok' };
  if (
    isObject(data) &&
    data.status === 'refused' &&
    oneOf(data.reason, ['alias_invalid', 'alias_taken', 'contact_unknown'] as const)
  ) {
    return { kind: 'refused', reason: data.reason };
  }
  return { kind: 'refused', reason: 'unavailable' };
}

/** `/api/ui/contacts/<ref>/<what>`; throws for a ref of another shape (never a request). */
export function contactPath(ref: string, what: string): string {
  if (!REF.test(ref)) throw new Error('contact ref is malformed');
  return `${LIST_PATH}/${ref}/${what}`;
}

// WP-P2 (design-1112 spec §5): `GET /api/ui/people` (packages/node/src/local-ui/api/people-all.ts),
// every ID. The open ID carries its people (checked by the same `row` as above); another ID carries
// only how many people it has (its names stay sealed in its own store until it is opened, 04 §2.5).
// An ID's `name` is the folder name the switch route takes (never shown); its `label` is the owner's
// own label (plain text).

export const PEOPLE_ALL_PATH = '/api/ui/people';
const ID_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_LABEL = 128;

export interface IdPeople {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  /** The open ID's people; undefined for another ID or when they could not be read. */
  readonly contacts?: readonly ContactRow[];
  /** Another ID's number of people; undefined for the open ID or when it could not be read. */
  readonly count?: number;
}

/** True when this ID's part could not be read just now. */
export const idMissing = (id: IdPeople): boolean =>
  id.current ? id.contacts === undefined : id.count === undefined;

/** The IDs of the read; undefined when the answer is not usable (the page keeps one ID's list). */
export function parsePeopleAll(data: unknown): readonly IdPeople[] | undefined {
  if (!isObject(data) || data.status !== 'ok' || !Array.isArray(data.ids)) return undefined;
  const ids: IdPeople[] = [];
  for (const item of data.ids as unknown[]) {
    if (!isObject(item)) continue;
    const { name, label, current, status, contacts, count } = item;
    if (typeof name !== 'string' || !ID_NAME.test(name)) continue;
    if (ids.some((id) => id.name === name)) continue;
    const shown =
      typeof label === 'string' && label.length > 0 && label.length <= MAX_LABEL ? label : name;
    const open = current === true;
    const base = { name, label: shown, current: open };
    if (status !== 'ok') {
      ids.push(base);
    } else if (open && Array.isArray(contacts)) {
      const rows: ContactRow[] = [];
      for (const c of contacts as unknown[]) {
        const r = row(c);
        if (r !== undefined) rows.push(r);
      }
      ids.push({ ...base, contacts: rows });
    } else if (!open && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) {
      ids.push({ ...base, count });
    } else {
      ids.push(base);
    }
  }
  return ids;
}

export function renameCheckPath(ref: string, alias: string): string {
  return `${contactPath(ref, 'rename-check')}?alias=${encodeURIComponent(alias)}`;
}
