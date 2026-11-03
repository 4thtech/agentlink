// F25 (owner test of 0.4.10): when the app on this computer stops, the page says so in one plain
// line instead of "Try again in a minute". The host tells open pages first (the `closing` event on
// the live stream); a host that stops answering after the page had loaded counts as closed too.
// A page that never reached the host keeps the usual offline words. Nothing here holds data.

/** 11 §5: plain words, no link, no number. */
export const HOST_CLOSED_TEXT = 'AgentLink closed. Run agentlink to open it again.';

/** Failed requests in a row (after a good one) that mean the host is gone. */
const FAILURES_TO_CLOSE = 2;

let reached = false;
let closed = false;
let failures = 0;
const listeners = new Set<() => void>();

export function isHostClosed(): boolean {
  return closed;
}

export function markHostClosed(): void {
  if (closed) return;
  closed = true;
  for (const l of [...listeners]) l();
}

/** A request got an answer (any status): the host is there. */
export function noteHostReached(): void {
  reached = true;
  failures = 0;
}

/** A request could not connect at all (not a status). Closed only after a good one and a repeat. */
export function noteHostUnreachable(): void {
  if (!reached) return;
  failures += 1;
  if (failures >= FAILURES_TO_CLOSE) markHostClosed();
}

export function subscribeHostClosed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetHostClosedForTests(): void {
  reached = false;
  closed = false;
  failures = 0;
  listeners.clear();
}
