// The Rules page's data (packages/node/src/local-ui/api/rules.ts): the server's answers checked
// before use (every value a known word, a number or a dollar amount; anything else is "can't load"),
// the owner's draft, and the patch built from it. The patch names only the fields the owner changed;
// the server and core build and sign the whole document (the browser never signs, D-118).

export type Rule3 = 'allow' | 'approval' | 'deny';

export interface RulesView {
  readonly proofs: {
    readonly notarize: Rule3;
    readonly dailyBudgetUSD: string;
    readonly perActionMaxUSD: string;
    readonly allowKeyDisclosure: 'approval' | 'deny';
  };
  readonly contacts: {
    readonly acceptInvites: 'approval' | 'auto';
    readonly unknownSenders: 'queue' | 'drop';
    readonly allowed: 'paired' | 'listed';
    readonly listed: number;
  };
  readonly files: {
    readonly maxSendSizeMB: number;
    readonly maxReceiveSizeMB: number;
  };
  readonly receipts: { readonly autoDelivered: boolean };
  readonly commitments: {
    readonly accept: Rule3;
    readonly autoAcceptDirection: 'buy' | 'sell';
    readonly autoAcceptMaxUSD: string;
    readonly autoAcceptMinUSD: string | null;
    readonly autoAcceptContacts: number;
  };
}

export type RulesAnswer =
  | { readonly kind: 'ok'; readonly version: number; readonly rules: RulesView }
  | { readonly kind: 'not_valid' }
  | { readonly kind: 'not_set_up' }
  | { readonly kind: 'unavailable' };

export interface ReviewWarning {
  readonly code: string;
  readonly contacts?: number;
}

export interface Review {
  readonly review: string;
  readonly warnings: readonly ReviewWarning[];
  readonly askKeepDeliveryReceipts: boolean;
}

export const RULES_PATH = '/api/ui/rules';

/** A core USD amount (06 §3): no trailing zero, at most 6 decimals. */
const USD = /^(0|[1-9][0-9]{0,8})(\.[0-9]{0,5}[1-9])?$/;
const HASH = /^[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z_]{1,63}$/;
const MB_MAX = 10_240;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T =>
  typeof v === 'string' && (values as readonly string[]).includes(v);
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100_000;
const size = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MB_MAX;
const usd = (v: unknown): v is string => typeof v === 'string' && USD.test(v);

const RULE3: readonly Rule3[] = ['allow', 'approval', 'deny'];

function parseView(v: unknown): RulesView | undefined {
  if (!isObject(v)) return undefined;
  const { proofs: p, contacts: c, files: f, receipts: r, commitments: m } = v;
  if (!isObject(p) || !isObject(c) || !isObject(f) || !isObject(r) || !isObject(m))
    return undefined;
  if (
    !oneOf(p.notarize, RULE3) ||
    !usd(p.dailyBudgetUSD) ||
    !usd(p.perActionMaxUSD) ||
    !oneOf(p.allowKeyDisclosure, ['approval', 'deny'] as const) ||
    !oneOf(c.acceptInvites, ['approval', 'auto'] as const) ||
    !oneOf(c.unknownSenders, ['queue', 'drop'] as const) ||
    !oneOf(c.allowed, ['paired', 'listed'] as const) ||
    !count(c.listed) ||
    !size(f.maxSendSizeMB) ||
    !size(f.maxReceiveSizeMB) ||
    typeof r.autoDelivered !== 'boolean' ||
    !oneOf(m.accept, RULE3) ||
    !oneOf(m.autoAcceptDirection, ['buy', 'sell'] as const) ||
    !usd(m.autoAcceptMaxUSD) ||
    !(m.autoAcceptMinUSD === null || usd(m.autoAcceptMinUSD)) ||
    !count(m.autoAcceptContacts)
  ) {
    return undefined;
  }
  return {
    proofs: {
      notarize: p.notarize,
      dailyBudgetUSD: p.dailyBudgetUSD,
      perActionMaxUSD: p.perActionMaxUSD,
      allowKeyDisclosure: p.allowKeyDisclosure,
    },
    contacts: {
      acceptInvites: c.acceptInvites,
      unknownSenders: c.unknownSenders,
      allowed: c.allowed,
      listed: c.listed,
    },
    files: { maxSendSizeMB: f.maxSendSizeMB, maxReceiveSizeMB: f.maxReceiveSizeMB },
    receipts: { autoDelivered: r.autoDelivered },
    commitments: {
      accept: m.accept,
      autoAcceptDirection: m.autoAcceptDirection,
      autoAcceptMaxUSD: m.autoAcceptMaxUSD,
      autoAcceptMinUSD: m.autoAcceptMinUSD,
      autoAcceptContacts: m.autoAcceptContacts,
    },
  };
}

export function parseRules(data: unknown): RulesAnswer {
  if (!isObject(data)) return { kind: 'unavailable' };
  if (data.status === 'not_valid') return { kind: 'not_valid' };
  if (data.status !== 'ok') return { kind: 'unavailable' };
  const { version } = data;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    return { kind: 'unavailable' };
  }
  const rules = parseView(data.rules);
  return rules === undefined ? { kind: 'unavailable' } : { kind: 'ok', version, rules };
}

export function parseReview(data: unknown): Review | undefined {
  if (!isObject(data) || data.status !== 'review') return undefined;
  const { review, warnings, askKeepDeliveryReceipts } = data;
  if (typeof review !== 'string' || !HASH.test(review)) return undefined;
  if (typeof askKeepDeliveryReceipts !== 'boolean' || !Array.isArray(warnings)) return undefined;
  const out: ReviewWarning[] = [];
  for (const w of warnings as unknown[]) {
    // A warning the page can't read is never dropped: the save would be refused without it.
    if (!isObject(w) || typeof w.code !== 'string' || !CODE.test(w.code)) return undefined;
    out.push(count(w.contacts) ? { code: w.code, contacts: w.contacts } : { code: w.code });
  }
  return { review, warnings: out, askKeepDeliveryReceipts };
}

// --- the owner's draft ------------------------------------------------------------------------------

export interface Draft {
  readonly notarize: Rule3;
  readonly dailyBudgetUSD: string;
  readonly perActionMaxUSD: string;
  readonly acceptInvites: 'approval' | 'auto';
  readonly accept: Rule3;
  readonly unknownSenders: 'queue' | 'drop';
  readonly allowKeyDisclosure: 'approval' | 'deny';
  readonly maxSendSizeMB: string;
  readonly maxReceiveSizeMB: string;
  readonly buyOn: boolean;
  readonly buyMaxUSD: string;
  readonly sellOn: boolean;
  readonly sellMinUSD: string;
}

/** Buy auto-accept as core reads it: live, with listed contacts and a maximum above 0. */
export const buyOn = (v: RulesView): boolean =>
  v.commitments.accept !== 'deny' &&
  v.commitments.autoAcceptDirection === 'buy' &&
  v.commitments.autoAcceptContacts > 0 &&
  v.commitments.autoAcceptMaxUSD !== '0';

/** Sell auto-accept: live with a minimum set. */
export const sellOn = (v: RulesView): boolean =>
  v.commitments.accept !== 'deny' &&
  v.commitments.autoAcceptDirection === 'sell' &&
  v.commitments.autoAcceptMinUSD !== null;

export function draftOf(v: RulesView): Draft {
  return {
    notarize: v.proofs.notarize,
    dailyBudgetUSD: v.proofs.dailyBudgetUSD,
    perActionMaxUSD: v.proofs.perActionMaxUSD,
    acceptInvites: v.contacts.acceptInvites,
    accept: v.commitments.accept,
    unknownSenders: v.contacts.unknownSenders,
    allowKeyDisclosure: v.proofs.allowKeyDisclosure,
    maxSendSizeMB: String(v.files.maxSendSizeMB),
    maxReceiveSizeMB: String(v.files.maxReceiveSizeMB),
    buyOn: buyOn(v),
    buyMaxUSD: v.commitments.autoAcceptMaxUSD === '0' ? '' : v.commitments.autoAcceptMaxUSD,
    sellOn: sellOn(v),
    sellMinUSD: v.commitments.autoAcceptMinUSD ?? '',
  };
}

/** The owner's dollar entry ("5", "0.50", "$10.5") as core's amount, or undefined. */
export function toUsd(text: string): string | undefined {
  const m = /^\s*\$?\s*([0-9]{1,9})(?:\.([0-9]{1,2}))?\s*$/.exec(text);
  if (m === null) return undefined;
  const whole = String(Number(m[1]));
  const frac = (m[2] ?? '').replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}

/** `$50.00` for the sell warning; undefined while the entry is not an amount. */
export function dollars(text: string): string | undefined {
  const amount = toUsd(text);
  if (amount === undefined) return undefined;
  const [whole, frac = ''] = amount.split('.');
  return `$${whole ?? '0'}.${frac.padEnd(2, '0')}`;
}

/** The owner's size entry in MB, or undefined. */
export function toSize(text: string): number | undefined {
  if (!/^\s*[0-9]{1,5}\s*$/.test(text)) return undefined;
  const n = Number(text.trim());
  return n >= 1 && n <= MB_MAX ? n : undefined;
}

export interface DraftCheck {
  readonly patch: Record<string, Record<string, unknown>>;
  /** How many settings the owner changed (the unsaved-changes bar). */
  readonly changes: number;
  /** Fields whose entry is not valid, by draft key. */
  readonly invalid: ReadonlySet<keyof Draft>;
}

/** The patch for `draft` over `view`: only what changed, in core's form. */
export function checkDraft(view: RulesView, draft: Draft): DraftCheck {
  const patch: Record<string, Record<string, unknown>> = {};
  const invalid = new Set<keyof Draft>();
  let changes = 0;
  const set = (section: string, field: string, value: unknown): void => {
    (patch[section] ??= {})[field] = value;
  };
  const pick = <T>(changed: boolean, section: string, field: string, value: T): void => {
    if (!changed) return;
    changes += 1;
    set(section, field, value);
  };

  pick(draft.notarize !== view.proofs.notarize, 'proofs', 'notarize', draft.notarize);
  const amount = (key: 'dailyBudgetUSD' | 'perActionMaxUSD'): void => {
    const value = toUsd(draft[key]);
    if (value === undefined) {
      invalid.add(key);
      return;
    }
    pick(value !== view.proofs[key], 'proofs', key, value);
  };
  amount('dailyBudgetUSD');
  amount('perActionMaxUSD');
  pick(
    draft.allowKeyDisclosure !== view.proofs.allowKeyDisclosure,
    'proofs',
    'allowKeyDisclosure',
    draft.allowKeyDisclosure,
  );
  pick(
    draft.acceptInvites !== view.contacts.acceptInvites,
    'contacts',
    'acceptInvites',
    draft.acceptInvites,
  );
  pick(
    draft.unknownSenders !== view.contacts.unknownSenders,
    'contacts',
    'unknownSenders',
    draft.unknownSenders,
  );
  for (const key of ['maxSendSizeMB', 'maxReceiveSizeMB'] as const) {
    const value = toSize(draft[key]);
    if (value === undefined) invalid.add(key);
    else pick(value !== view.files[key], 'files', key, value);
  }
  pick(draft.accept !== view.commitments.accept, 'commitments', 'accept', draft.accept);

  // Auto-accept: one direction at a time (06 §3). Turning one on picks its direction; turning the
  // live one off clears its bound.
  const c = view.commitments;
  let direction = c.autoAcceptDirection;
  let max = c.autoAcceptMaxUSD;
  let min = c.autoAcceptMinUSD;
  const wasBuy = buyOn(view);
  const wasSell = sellOn(view);
  if (draft.buyOn) {
    const value = toUsd(draft.buyMaxUSD);
    if (value === undefined || value === '0') invalid.add('buyMaxUSD');
    else {
      direction = 'buy';
      max = value;
    }
  } else if (wasBuy) max = '0';
  if (draft.sellOn) {
    const value = toUsd(draft.sellMinUSD);
    if (value === undefined || value === '0') invalid.add('sellMinUSD');
    else {
      direction = 'sell';
      min = value;
    }
  } else if (wasSell) min = null;
  if (draft.buyOn !== wasBuy) changes += 1;
  if (draft.sellOn !== wasSell) changes += 1;
  if (direction !== c.autoAcceptDirection) set('commitments', 'autoAcceptDirection', direction);
  if (max !== c.autoAcceptMaxUSD) {
    set('commitments', 'autoAcceptMaxUSD', max);
    if (draft.buyOn === wasBuy) changes += 1;
  }
  if (min !== c.autoAcceptMinUSD) {
    set('commitments', 'autoAcceptMinUSD', min);
    if (draft.sellOn === wasSell) changes += 1;
  }
  return { patch, changes, invalid };
}

const toBase64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** base64url of the UTF-8 JSON of `value`. */
export const encodeJson = (value: unknown): string =>
  toBase64url(new TextEncoder().encode(JSON.stringify(value)));

/** The review URL for an edit made on `version`. */
export function reviewPath(
  version: number,
  patch: Record<string, Record<string, unknown>>,
  keepDeliveryReceipts?: boolean,
): string {
  const edit = {
    base: version,
    patch,
    ...(keepDeliveryReceipts === undefined ? {} : { keepDeliveryReceipts }),
  };
  return `${RULES_PATH}/review?edit=${encodeJson(edit)}`;
}
