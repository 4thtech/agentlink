// W5-INVITE-FEEDBACK kept the public IDs of invites that never left the screen in this tab
// (sessionStorage) so a reload could cancel them. REL051-B2 (owner test, 13 Nov): the app now keeps
// every open invite's link, so such an invite waits under Home and People (Copy link, Cancel invite)
// and nothing is cancelled for the owner; the key an older build may have left is only cleared.
//
// IR-REL051-B2-1 (4), the double-create guard: the Invite screen remembers in this tab the public ID
// (and the owner's own name for it) of the invite it shows, so a reload shows that same invite again
// (read with the link route) instead of making another 7-day invite. Leaving the screen in the app
// (Done, Back) forgets it, so the next "Invite someone" is a new invite. Never a link or a secret.

export const UNSENT_INVITES_KEY = 'agentlink.unsentInvites';
export const SCREEN_INVITE_KEY = 'agentlink.screenInvite';
const INVITE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_LABEL = 64;

/** Clears what an older build kept in this tab; cancels nothing. */
export function clearUnsentInvites(): void {
  try {
    sessionStorage.removeItem(UNSENT_INVITES_KEY);
  } catch {
    // No storage: nothing to clear.
  }
}

export interface ScreenInvite {
  readonly id: string;
  readonly label: string;
}

/** The invite the Invite screen showed before this load of the tab, or undefined. */
export function screenInvite(): ScreenInvite | undefined {
  try {
    const raw = sessionStorage.getItem(SCREEN_INVITE_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { id, label } = parsed as Record<string, unknown>;
    if (typeof id !== 'string' || !INVITE_ID.test(id)) return undefined;
    if (typeof label !== 'string' || label.length > MAX_LABEL) return undefined;
    return { id, label };
  } catch {
    return undefined;
  }
}

export function rememberScreenInvite(id: string, label: string): void {
  if (!INVITE_ID.test(id) || label.length > MAX_LABEL) return;
  try {
    sessionStorage.setItem(SCREEN_INVITE_KEY, JSON.stringify({ id, label }));
  } catch {
    // No storage: a reload makes a new invite (it waits on Home and People).
  }
}

export function forgetScreenInvite(): void {
  try {
    sessionStorage.removeItem(SCREEN_INVITE_KEY);
  } catch {
    // No storage: nothing to forget.
  }
}
