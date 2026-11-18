// OWNER-FB-0512: the shell asked the core for an in-place person open (no session link is minted, the
// URL carries a placeholder token). This decides what a `ready` means for that open.
export interface InPlaceAsk {
  readonly route: string;
  readonly target: string;
}

export type InPlaceReply =
  /** Not the answer to the ask (another page's `ready`): load it as usual; the ask stays open. */
  | 'other'
  /** The answer, and the window can move in place: load it as usual; the ask is done. */
  | 'answered'
  /** The answer, but the window cannot move in place any more: ask again for a full load. */
  | 'reask';

/** What a `ready` with this session URL means for the pending ask (null: none). */
export function inPlaceReply(
  asked: InPlaceAsk | null,
  sessionUrl: string,
  canOpenInPlace: boolean,
): InPlaceReply {
  if (asked === null) return 'other';
  let hash: string;
  try {
    hash = new URL(sessionUrl).hash;
  } catch {
    return 'other';
  }
  if (hash !== `#person=${asked.target}` && hash !== `#person=${asked.target}&files`) {
    return 'other';
  }
  return canOpenInPlace ? 'answered' : 'reask';
}
