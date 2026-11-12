// What a finished restore leaves for step 4 (UX1113-R3). The restore may open the first restored ID, and
// the app then swaps the shell and the page for the ID that is open now (router.tsx, useAgentEpoch):
// the wizard mounts again. The result of the restore, including the new master code that is shown once,
// therefore lives here, in memory of this page only, until "Go to Home" or Cancel. It is never written
// to storage, a URL or an attribute, and a reload of the page loses it by design.
import { useSyncExternalStore } from 'react';

export interface RestoreOutcome {
  readonly restored: readonly string[];
  readonly failed: readonly string[];
  /** Shown once, only when a new owner was made. */
  readonly masterCode: string | undefined;
  readonly touchId: boolean;
  /** The kit's date, seconds since 1970. */
  readonly kitDate: number | undefined;
}

let current: RestoreOutcome | undefined;
const listeners = new Set<() => void>();

export function setOutcome(next: RestoreOutcome | undefined): void {
  current = next;
  for (const l of [...listeners]) l();
}

export const getOutcome = (): RestoreOutcome | undefined => current;

export function useOutcome(): RestoreOutcome | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getOutcome,
    getOutcome,
  );
}

// First run answered "finish_restore": restored IDs wait for their owner, so the wizard says
// "Finish restoring" and asks for the kit again (spec §6.6). A flag in memory, never stored.
let finishing = false;
export const setFinishRestore = (value: boolean): void => {
  finishing = value;
};
export const takeFinishRestore = (): boolean => {
  const was = finishing;
  finishing = false;
  return was;
};
