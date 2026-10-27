// M1-UX3-DUP-CONTACTS: "Keep both" on the second-connection notice. Kept in this browser's
// localStorage only, as pairs of contact refs (IDs the page already has; never a name or a
// fingerprint). Nothing is written to the server. Storage can be missing or blocked: every access
// is wrapped, and the page then remembers the choice only while it is open.
export const KEPT_KEY = 'agentlink.contacts.duplicates-kept.v1';

const REF = /^0x[0-9a-f]{40}$/;
const MAX_PAIRS = 200;

const pair = (newer: string, older: string): string => `${newer}:${older}`;

function isPair(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const [a, b, rest] = v.split(':');
  return rest === undefined && a !== undefined && b !== undefined && REF.test(a) && REF.test(b);
}

export function loadKept(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(KEPT_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(isPair).slice(-MAX_PAIRS));
  } catch {
    return new Set();
  }
}

export function isKept(kept: ReadonlySet<string>, newer: string, older: string): boolean {
  return kept.has(pair(newer, older));
}

/** Remember "Keep both" for this pair; returns the new set even when storage is blocked. */
export function keep(kept: ReadonlySet<string>, newer: string, older: string): ReadonlySet<string> {
  const next = new Set(kept);
  next.add(pair(newer, older));
  try {
    localStorage.setItem(KEPT_KEY, JSON.stringify([...next].slice(-MAX_PAIRS)));
  } catch {
    // No storage: the choice lives only in this page's memory.
  }
  return next;
}
