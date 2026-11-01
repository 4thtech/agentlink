// W5-INVITE-FEEDBACK "stop the double-create" (owner test of 0.4.6, 1 Nov: two invites 10 s apart,
// the first never used and never cancelled). The Invite panel cancels a link that never left the
// screen when it goes away, but a reload or a closed tab never unmounts it. So this tab remembers
// (sessionStorage) the public IDs of the invites that did not leave the screen: the panel cancels
// them with a keepalive request when the page hides, and any left over when it opens next.
// Only public invite IDs (22 base64url characters) are kept: never a link or a secret.

export const UNSENT_INVITES_KEY = 'agentlink.unsentInvites';
const INVITE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_KEPT = 16;

function read(): string[] {
  try {
    const raw = sessionStorage.getItem(UNSENT_INVITES_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && INVITE_ID.test(v));
  } catch {
    return [];
  }
}

function write(ids: readonly string[]): void {
  try {
    if (ids.length === 0) sessionStorage.removeItem(UNSENT_INVITES_KEY);
    else sessionStorage.setItem(UNSENT_INVITES_KEY, JSON.stringify(ids.slice(-MAX_KEPT)));
  } catch {
    // No storage: the unmount cancel still covers in-app navigation.
  }
}

/** The IDs kept from earlier loads of this tab. */
export function unsentInvites(): readonly string[] {
  return read();
}

export function rememberUnsent(id: string): void {
  if (!INVITE_ID.test(id)) return;
  write([...read().filter((x) => x !== id), id]);
}

export function forgetUnsent(id: string): void {
  write(read().filter((x) => x !== id));
}
