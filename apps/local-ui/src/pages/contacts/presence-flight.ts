// REL051-UF3 (R1-UI-06): one Touch ID question per press. A button that asks for owner presence is
// single-flight: the first click starts the sensor gesture, every later click is ignored and the
// button shows as disabled until the gesture and the request it confirms have settled. A double
// click used to ask twice, because the caller's own `busy` only turned on after the gesture.
//
// `busy` is the caller's "the request is being sent" state. The guard is a ref, so a second click
// that arrives before React has drawn the disabled button is still ignored; it opens again once
// neither the gesture (`asking`) nor the request (`busy`) is running.
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PresenceFlight {
  /** The sensor gesture is running: show the button disabled. */
  readonly asking: boolean;
  /** Call first on a click: false when a gesture or its request is already running (ignore it). */
  readonly start: () => boolean;
  /**
   * The gesture ended. Call it in the same callback that starts the request (sets `busy`), so the
   * button stays closed until that request is done.
   */
  readonly done: () => void;
}

export function usePresenceFlight(busy: boolean): PresenceFlight {
  const flight = useRef(false);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!busy && !asking) flight.current = false;
  }, [busy, asking]);
  const start = useCallback((): boolean => {
    if (flight.current) return false;
    flight.current = true;
    setAsking(true);
    return true;
  }, []);
  const done = useCallback((): void => setAsking(false), []);
  return { asking, start, done };
}
