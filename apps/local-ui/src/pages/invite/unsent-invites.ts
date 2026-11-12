// W5-INVITE-FEEDBACK kept the public IDs of invites that never left the screen in this tab
// (sessionStorage) so a reload could cancel them. REL051-B2 (owner test, 13 Nov): the app now keeps
// every open invite's link, so such an invite waits under Home and People (Copy link, Cancel invite)
// and nothing is cancelled for the owner. Only the key an older build may have left is cleared.

export const UNSENT_INVITES_KEY = 'agentlink.unsentInvites';

/** Clears what an older build kept in this tab; cancels nothing. */
export function clearUnsentInvites(): void {
  try {
    sessionStorage.removeItem(UNSENT_INVITES_KEY);
  } catch {
    // No storage: nothing to clear.
  }
}
