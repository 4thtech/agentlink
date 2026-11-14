// NOTIFY-DEDUPE (S1): a file and its message from one person are ONE alert, not two. A file sent with
// a note arrives as a file and a message (two events, possibly a look apart), so the second alert for
// the same person within a short window is dropped; what the first said ("from Ana") covers it.
//
// Pure apart from the small memory the caller keeps (`recent`, in memory only; person ID, kind, time).
// Only alerts the owner's switches let through are remembered, so a switch that is off never hides
// the other kind.

/** The shortest gap after which a person's file or message alerts on its own again. */
export const FILE_MESSAGE_WINDOW_MS = 20_000;

export interface PersonNews {
  readonly kind: string;
  /** The person (a contact ID); news without one is never touched. */
  readonly ref?: string;
}

/** Who was last alerted about, for the window. */
export type RecentAlerts = Map<
  string,
  { readonly kind: 'messages' | 'files'; readonly at: number }
>;

/**
 * `news` without the second alert for a person's file plus message. `allowed(kind)` is whether the
 * owner's switch lets that kind through. Within one batch the file's alert wins over the message's.
 */
export function dedupeFileAndMessage<T extends PersonNews>(
  news: readonly T[],
  allowed: (kind: 'messages' | 'files') => boolean,
  recent: RecentAlerts,
  nowMs: number,
): T[] {
  for (const [ref, last] of recent) {
    if (nowMs - last.at >= FILE_MESSAGE_WINDOW_MS) recent.delete(ref);
  }
  const ordered = [...news].sort((a, b) => Number(b.kind === 'files') - Number(a.kind === 'files'));
  const keep = new Set<T>();
  for (const n of ordered) {
    const kind = n.kind;
    if (n.ref === undefined || (kind !== 'messages' && kind !== 'files') || !allowed(kind)) {
      keep.add(n);
      continue;
    }
    const last = recent.get(n.ref);
    if (last !== undefined && last.kind !== kind) continue;
    recent.set(n.ref, { kind, at: nowMs });
    keep.add(n);
  }
  return news.filter((n) => keep.has(n));
}
