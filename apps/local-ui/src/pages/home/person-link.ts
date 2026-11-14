// NOTIFY-DEEPLINK: a click on a message or file notification opens Home at `/#person=<id>`. The id is
// an opaque local contact ID, in the fragment so it never reaches the server. Home checks it against
// its own people before it opens anything; anything else is ignored (never a path, never content).
const PERSON_HASH = /^#person=(0x[0-9a-f]{40})$/;

/** The contact ID the address asks to open, or undefined (no, or any other, fragment). */
export function personFromHash(hash: string): string | undefined {
  return PERSON_HASH.exec(hash)?.[1];
}

/** Removes the fragment from the address (the person is open; a reload must not reopen it). */
export function clearPersonHash(): void {
  try {
    history.replaceState(history.state, '', location.pathname + location.search);
  } catch {
    // Best effort.
  }
}
