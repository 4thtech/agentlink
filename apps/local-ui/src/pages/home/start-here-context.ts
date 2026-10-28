// What the shell shares with the pages about Start here (UX2-g; B-11 §27.4): the card's model for
// Home, the dot for the sidebar and "has step 2 happened" for the empty states. Pages outside the
// shell (tests, a lone page) see `null` and keep their own empty states.
import { createContext, useContext } from 'react';
import type { StartView, StepId } from './start-here.js';

export type StartPhase = 'loading' | 'hidden' | 'shown' | 'allset' | 'leaving';

export interface StartHereModel {
  readonly phase: StartPhase;
  /** The derived steps; null while loading or hidden. */
  readonly view: StartView | null;
  /** The polite live-region text: a step done while you watch, or "You're all set." */
  readonly announce: string;
  /** Step 2 happened: true or false when known, undefined while the contacts read has no answer. */
  readonly inviteDone: boolean | undefined;
  /** Steps that became done while you watch (they draw their check once). */
  readonly fresh?: readonly StepId[];
  /** Read everything again now (the AI apps "Try again"). */
  readonly retry?: () => void;
}

export const StartHereContext = createContext<StartHereModel | null>(null);

export function useStartHereContext(): StartHereModel | null {
  return useContext(StartHereContext);
}

/** True while the card is part of Home: the dot in the sidebar follows it. */
export function startHereShown(model: StartHereModel | null): boolean {
  return (
    model !== null &&
    (model.phase === 'shown' || model.phase === 'allset' || model.phase === 'leaving')
  );
}

/** The empty states show their "Invite someone first" line only while step 2 is known not done. */
export function inviteStillToDo(model: StartHereModel | null): boolean {
  return model !== null && model.inviteDone === false;
}
