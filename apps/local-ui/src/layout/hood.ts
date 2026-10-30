// W4-SHELL-V2: turning Under the hood on or off is one morph of the same screen (a View Transition
// from the U0 kit; under reduced motion the kit makes it a fade). Every control uses this one call:
// the top bar switch, Cmd+Shift+U, Cmd+K and Settings › Appearance. The app keeps the value
// (prefs/ui-settings.ts saves every change of the preference).
import { startViewTransition } from '@4thtech-io/ui';
import { flushSync } from 'react-dom';
import { setUnderTheHood } from '../prefs/index.js';

export function toggleHood(on: boolean): void {
  startViewTransition(() => flushSync(() => setUnderTheHood(on)));
}

/** Runs a shell state change (the rail expanding) as one View Transition of the U0 kit. */
export function morph(update: () => void): void {
  startViewTransition(() => flushSync(update));
}
