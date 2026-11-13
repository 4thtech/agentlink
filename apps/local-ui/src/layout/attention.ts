// N5 (PLAN-NOTIFY §3.2, §3.5; D4): the browser's own signs that something waits.
//
// - The tab title carries the bell's number: "(3) Home · AgentLink", "9+" above nine. The page part
//   is what the route announcement sets (layout/index.tsx); this module only adds the number.
// - The favicon shows a dot while approvals wait (a second icon file of the bundle; no data: URL,
//   CSP img-src 'self'), and the plain mark otherwise.
// Only numbers reach the title; never a name or anything a contact wrote (11 §5.7).
import dotIcon from './favicon-dot.svg?url';

let pageTitle = 'AgentLink';
let unread = 0;
let approvals = 0;
let plainIcon: string | undefined;

/** "(n) " for the title, "9+" above nine; empty for none. */
export function countPrefix(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return `(${n > 9 ? '9+' : String(Math.floor(n))}) `;
}

function iconLink(): HTMLLinkElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

function render(): void {
  if (typeof document === 'undefined') return;
  document.title = `${countPrefix(unread)}${pageTitle}`;
  const link = iconLink();
  if (link === null) return;
  plainIcon ??= link.getAttribute('href') ?? undefined;
  const want = approvals > 0 ? dotIcon : plainIcon;
  if (want !== undefined && link.getAttribute('href') !== want) link.setAttribute('href', want);
  link.dataset['attention'] = approvals > 0 ? 'approvals' : 'none';
}

/** The page's own title (without the number). */
export function setPageTitle(title: string): void {
  pageTitle = title;
  render();
}

/** The bell's number and the approvals waiting. */
export function setAttention(next: { readonly unread: number; readonly approvals: number }): void {
  unread = next.unread;
  approvals = next.approvals;
  render();
}

/** Test seam. */
export function resetAttentionForTests(): void {
  pageTitle = 'AgentLink';
  unread = 0;
  approvals = 0;
  plainIcon = undefined;
}
