// N2: what the app says about the network, in one place (docs/design/notices.md).
//
// - `useHealth()`: the one health word. The state, its words and whether the network has been down
//   long enough to say so.
// - The offline banner appears only after HEALTH_GRACE_MS (5 s) of being offline: a short blip says
//   nothing. It goes away by itself when the network is back.
// - "Back online" is a toast, raised once, and only when the banner had been shown.
import { Banner, HEALTH_GRACE_MS } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { notify } from '../notices/index.js';
import { STATE_STRINGS } from '../states/strings.js';
import { useConnectionState, type ConnectionState } from './connection.js';
import { healthWord, isNetworkDown, type HealthWord } from './health-word.js';

/** True once `down` has been true for `ms` without a break; false as soon as it ends. */
export function useDownFor(down: boolean, ms: number = HEALTH_GRACE_MS): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!down) {
      setShown(false);
      return undefined;
    }
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [down, ms]);
  return shown;
}

export interface HealthView {
  readonly state: ConnectionState;
  readonly words: HealthWord;
  /** The network cannot be reached right now. */
  readonly down: boolean;
  /** It has been down for more than the grace period: time to say so. */
  readonly offlineShown: boolean;
}

/** The app's one health word (N2): the state, its words, and whether to show the offline notice. */
export function useHealth(): HealthView {
  const state = useConnectionState();
  const down = isNetworkDown(state);
  return { state, words: healthWord(state), down, offlineShown: useDownFor(down) };
}

/**
 * The compact offline banner, after the grace period. `also` is another reason to say so (Home's
 * own read failing), with its own words.
 */
export function HealthBanner({
  also = false,
  children,
}: {
  readonly also?: boolean;
  readonly children?: ReactNode;
}): ReactElement | null {
  const { down } = useHealth();
  const shown = useDownFor(down || also);
  if (!shown) return null;
  return (
    <Banner tone="offline" compact>
      {also && !down && children !== undefined ? children : STATE_STRINGS.networkOffline}
    </Banner>
  );
}

/** Raises "Back online" once when the network returns after the offline banner had shown. Renders nothing. */
export function BackOnlineToast(): null {
  const { state, offlineShown } = useHealth();
  const owed = useRef(false);
  useEffect(() => {
    if (offlineShown) owed.current = true;
  }, [offlineShown]);
  useEffect(() => {
    if (state === 'connected' && owed.current) {
      owed.current = false;
      notify({ tone: 'success', text: STATE_STRINGS.networkBack(0) });
    }
  }, [state]);
  return null;
}
