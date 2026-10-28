// UX2-d2 (b11 §21.3, Closing): the invites this app created, as pending rows: "Waiting for Marko to
// accept" with the days left. The server has no read of open invites yet, so the rows are kept in
// this page's memory while the app is open: the name the owner typed and the expiry, never the link
// or the share text (b11 §21.5). Nothing is stored in the browser; a reload drops the rows, and the
// contact itself shows up in the list once their agent answers.
export interface PendingInvite {
  readonly id: number;
  /** The name the owner typed, if any (the owner's own word, rendered as text). */
  readonly name: string | undefined;
  /** Unix milliseconds. */
  readonly createdAt: number;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

let rows: readonly PendingInvite[] = [];
let next = 1;

/** The open invites, newest first, without the expired ones. */
export function pendingInvites(now: number = Date.now()): readonly PendingInvite[] {
  rows = rows.filter((r) => r.expiresAt > now);
  return rows;
}

export function addPendingInvite(name: string | undefined, expiresAt: number): PendingInvite {
  const row: PendingInvite = { id: next, name, createdAt: Date.now(), expiresAt };
  next += 1;
  rows = [row, ...rows];
  return row;
}

/** For tests: start with no rows. */
export function forgetPendingInvites(): void {
  rows = [];
}
