// W5-SAFETY-STEP: one rule for "this contact's safety code can be compared", shared by Home's Get
// started step and the contact's detail panel, so the two never disagree; and the deep link from
// Home to that contact's code. The link holds a contact's reference only (the same one the page's
// own API paths use), never a code. Completion stays the owner-signed "They match" (I-4): nothing
// here records anything.
import { INTERIM_PEOPLE_PATH } from '../../nav.js';
import type { ContactRow } from './data.js';

export const CHECK_PARAM = 'check';

/** Active, answered, and not yet checked: the code is shown and "They match" is offered. */
export function canCompareCode(c: Pick<ContactRow, 'status' | 'pairing' | 'label'>): boolean {
  return c.status === 'active' && c.pairing === 'complete' && c.label === 'self-declared';
}

/** The first contact whose code can be compared, oldest first (the one Home's step points at). */
export function firstToCompare(rows: readonly ContactRow[]): ContactRow | undefined {
  return rows.filter(canCompareCode).sort((a, b) => a.since - b.since)[0];
}

/** `/contacts?check=<ref>`: opens that contact's panel at its safety code. */
export function checkHref(ref: string): string {
  return `${INTERIM_PEOPLE_PATH}?${CHECK_PARAM}=${encodeURIComponent(ref)}`;
}

/** The contact asked for by `?check=<ref>` (a pure read; `clearCheckParam` drops it from the address). */
export function peekCheckRef(): string | undefined {
  if (typeof location === 'undefined') return undefined;
  const ref = new URLSearchParams(location.search).get(CHECK_PARAM);
  if (ref === null) return undefined;
  const lower = ref.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(lower) ? lower : undefined;
}

/** Leaves the address clean once the panel is open: it holds nothing about it afterwards. */
export function clearCheckParam(): void {
  if (typeof location === 'undefined' || !new URLSearchParams(location.search).has(CHECK_PARAM)) {
    return;
  }
  history.replaceState(history.state, '', location.pathname + location.hash);
}
