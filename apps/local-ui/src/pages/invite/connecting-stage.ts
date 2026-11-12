// REL051-CF1 (R1-CLASS-01, -06; 08 §1; 04 §3.6): what an accept that waits for the inviter's answer
// says, from how long it has waited (`startedAt`, from the server's staged row, so it holds after a
// reload or a restart). Shared by People and Home.
//
// - blocked (REL051-B1): "You blocked {name}. Unblock to connect."
// - the first CONNECTING_HINT_MS: "Connecting to {name}…" (or, while it has not left this computer,
//   the existing "Waiting for {name} to come online" line);
// - then: "Waiting for {name}'s AgentLink to come online. It connects by itself; you can close this.";
// - from CONNECTING_NO_ANSWER_MS: "No answer from {name} yet. If this invite was already used or
//   cancelled, it won't connect. Ask {name} for a new one."
// The protocol has no refusal message (04 §3.6: a second answer is refused at the inviter only), so
// this side cannot tell "used or cancelled" from "the inviter is away": the line says both, and never
// who else answered. The row never ends by itself: it stays until it completes, lapses with the
// invite, or the owner cancels it.
import { useEffect, useState } from 'react';
import type { ConnectingRow } from '../contacts/invite-api.js';
import { FEEDBACK_STRINGS as F } from './strings.js';

/** After this long with no answer, the "still waiting" hint (R1-CLASS-06). */
export const CONNECTING_HINT_MS = 10_000;
/** After this long with no answer, "no answer: ask for a new invite" (R1-CLASS-01). */
export const CONNECTING_NO_ANSWER_MS = 120_000;

export type ConnectingStage = 'blocked' | 'connecting' | 'notSent' | 'waiting' | 'noAnswer';

export function connectingStage(row: ConnectingRow, nowMs: number): ConnectingStage {
  if (row.blocked === true) return 'blocked';
  const waited = row.startedAt === undefined ? undefined : nowMs - row.startedAt;
  if (waited !== undefined && waited >= CONNECTING_NO_ANSWER_MS) return 'noAnswer';
  if (!row.sent) return 'notSent';
  if (waited !== undefined && waited >= CONNECTING_HINT_MS) return 'waiting';
  return 'connecting';
}

/** The row's line for `stage`; the name is text only (I-5). */
export function connectingLine(row: ConnectingRow, nowMs: number): string {
  switch (connectingStage(row, nowMs)) {
    case 'blocked':
      return F.youBlocked(row.name);
    case 'notSent':
      return F.waitingOnline(row.name);
    case 'waiting':
      return F.waitingAnswer(row.name);
    case 'noAnswer':
      return F.noAnswer(row.name);
    default:
      return F.connecting(row.name);
  }
}

/** How often a shown row looks at the clock again. */
const TICK_MS = 5_000;

/**
 * The current time, updated every few seconds while a row can still move to a later stage (it has a
 * start time and is not past the bound), so the line changes while the page stays open.
 */
export function useConnectingNow(row: ConnectingRow): number {
  const [now, setNow] = useState(() => Date.now());
  const done =
    row.blocked === true ||
    row.startedAt === undefined ||
    now - row.startedAt >= CONNECTING_NO_ANSWER_MS;
  useEffect(() => {
    if (done) return undefined;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [done]);
  return now;
}
