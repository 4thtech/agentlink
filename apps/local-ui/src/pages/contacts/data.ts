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
const FINGERPRINT = /^[0-9A-F]{4}·[0-9A-F]{4}$/;
const MAX_NAME = 128;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T =>
  typeof v === 'string' && (set as readonly string[]).includes(v);

function row(v: unknown): ContactRow | undefined {
  if (!isObject(v)) return undefined;
  const { ref, name, nameSource, fingerprint, label, status, pairing, since } = v;
  if (typeof ref !== 'string' || !REF.test(ref)) return undefined;
  if (typeof name !== 'string' || name.length > MAX_NAME) return undefined;
  if (!oneOf(nameSource, ['owner', 'counterparty'] as const)) return undefined;
  if (!oneOf(label, ['self-declared', 'safety-code-checked'] as const)) return undefined;
  if (!oneOf(status, ['active', 'blocked', 'revoked'] as const)) return undefined;
  if (!oneOf(pairing, ['pending', 'complete', 'mismatch'] as const)) return undefined;
  if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0) return undefined;
  const fp = typeof fingerprint === 'string' && FINGERPRINT.test(fingerprint) ? fingerprint : null;
  return {
    ref,
    name,
    nameSource,
    label,
    status,
    pairing,
    since,
    ...(fp === null ? {} : { fingerprint: fp }),
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

export function renameCheckPath(ref: string, alias: string): string {
  return `${contactPath(ref, 'rename-check')}?alias=${encodeURIComponent(alias)}`;
}
