// WP-D10: when the phase-1 update check runs. Once shortly after launch, then once a day while the app
// runs; one pass at a time. A pass that finds nothing, or is refused, stays quiet: the only thing the
// person ever sees is "Update available" → "Open the installer" / "Later" (index.ts).
import { runUpdateCheck, type UpdateOutcome, type UpdaterDeps } from './index.js';

export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateTimers {
  setTimeout(callback: () => void, ms: number): unknown;
}

/** Starts the schedule. `run` is injectable for tests. Returns nothing; it runs until the app quits. */
export function scheduleUpdateChecks(
  deps: UpdaterDeps,
  timers: UpdateTimers,
  run: (deps: UpdaterDeps) => Promise<UpdateOutcome> = runUpdateCheck,
): void {
  let busy = false;
  const tick = (): void => {
    if (!busy) {
      busy = true;
      void run(deps)
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }
    timers.setTimeout(tick, CHECK_INTERVAL_MS);
  };
  timers.setTimeout(tick, FIRST_CHECK_DELAY_MS);
}
