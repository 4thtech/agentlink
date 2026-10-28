// UI-REFRESH-o-b: the Approvals badge in the sidebar (B-11 §3, §16 Approvals row): how many requests
// wait for the owner. The layout reads the list once per page (GET only); the Approvals pages then
// keep it in step: the list page says how many still wait, and an applied decision counts one down
// at once. A failed decision says nothing, so the number does not move. Only a number travels here,
// never anything a request or the agent wrote (I-5); a failure is just no badge, never a gate.
import { useEffect, useState } from 'react';
import { createApprovalsClient } from './client.js';

const EVENT = 'agentlink:approvals-waiting';
const SKIP = new Set(['/first-run']);

type Change = { readonly waiting: number } | { readonly decided: number };

const count = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;

function send(change: Change): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<Change>(EVENT, { detail: change }));
}

/** The list page: this many requests still wait for the owner. */
export function announceWaiting(waiting: number): void {
  if (count(waiting) !== undefined) send({ waiting });
}

/** Applied decisions (approve or deny): the badge counts down by this many. */
export function announceDecided(decided: number): void {
  if (count(decided) !== undefined && decided > 0) send({ decided });
}

async function readWaiting(): Promise<number> {
  const answer = await createApprovalsClient().list();
  return answer.kind === 'ok' ? answer.items.length : 0;
}

/** The number for the badge. `override` is a test seam that returns the count directly. */
export function useApprovalsWaiting(path: string, override?: () => Promise<number>): number {
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    if (SKIP.has(path)) return undefined;
    let live = true;
    (override ?? readWaiting)().then(
      (n) => live && setWaiting(count(n) ?? 0),
      () => live && setWaiting(0),
    );
    return () => {
      live = false;
    };
  }, [path, override]);

  useEffect(() => {
    const onChange = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail !== 'object' || detail === null) return;
      const w = count((detail as { waiting?: unknown }).waiting);
      const d = count((detail as { decided?: unknown }).decided);
      if (w !== undefined) setWaiting(w);
      else if (d !== undefined) setWaiting((n) => Math.max(0, n - d));
    };
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);

  return waiting;
}
