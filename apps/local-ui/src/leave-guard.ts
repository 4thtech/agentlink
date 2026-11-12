// UX1113-QA2 N14: a page can ask before the person leaves it while something would be lost (a
// recovery kit save in progress, or its code and checklist still on screen). Two ways out are guarded:
// closing or reloading the window (`beforeunload`, the browser's own question) and moving inside the
// app (router.tsx `navigate`, which asks with `confirm`). Holds one fixed sentence, never a code.
import { useEffect } from 'react';

let message: string | undefined;

function onBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // Older browsers need a returnValue to show their question; its text is not shown.
  event.returnValue = '';
}

/** Turns the guard on with `text`, or off with undefined. */
export function setLeaveGuard(text: string | undefined): void {
  if (text !== undefined && message === undefined) {
    window.addEventListener('beforeunload', onBeforeUnload);
  }
  if (text === undefined && message !== undefined) {
    window.removeEventListener('beforeunload', onBeforeUnload);
  }
  message = text;
}

/** True when the person may leave the page now (no guard, or they said yes to leaving). */
export function mayLeave(): boolean {
  if (message === undefined) return true;
  let leave: boolean;
  try {
    leave = window.confirm(message);
  } catch {
    leave = true;
  }
  if (leave) setLeaveGuard(undefined);
  return leave;
}

/** The guard while `text` is given; off again when it is undefined or the view unmounts. */
export function useLeaveGuard(text: string | undefined): void {
  useEffect(() => {
    setLeaveGuard(text);
    return () => setLeaveGuard(undefined);
  }, [text]);
}
