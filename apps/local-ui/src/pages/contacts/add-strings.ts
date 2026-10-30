// The People page's line after an invite was accepted (b11 §21.4). W4-WIRE-2: the Add contact sheet
// that used the rest of these words is retired (Decision 52 (3)); its paste words live with the
// Invite screen (pages/invite/strings.ts, PASTE_STRINGS).

/** After an accepted invite, while the other agent answers. */
export function connectingTo(name: string): string {
  return `Connecting to ${name}…`;
}
