// The app's one connection state (N2): recorded by the shell's health read, read by the status bar,
// the top bar, the status strip, Home and the notices. "Connected" appears only when the local
// server's health read says the agent is running (M1-11s-a-d, health.ts); until the first answer
// the state is "unknown" (shown as "Checking…", at most 4 s). The browser's offline event shows
// "Not connected" and wins over the health read while the browser stays offline; the online event
// goes back to "unknown", never straight to "connected": the next health read decides.
import { useEffect, useState } from 'react';
import type { HealthState } from './health.js';

export type ConnectionState = 'unknown' | 'offline' | HealthState;

let current: ConnectionState = 'unknown';
const listeners = new Set<() => void>();

/** Record the connection state (called by whatever learns it: the server health read). */
export function setConnectionState(next: ConnectionState): void {
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

/** The state right now (not reactive; for code that is not rendering). */
export function getConnectionState(): ConnectionState {
  return current;
}

export function useConnectionState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(current);
  useEffect(() => {
    const sync = (): void => setState(current);
    const onOffline = (): void => setConnectionState('offline');
    const onOnline = (): void => {
      if (current === 'offline') setConnectionState('unknown');
    };
    listeners.add(sync);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    sync();
    return () => {
      listeners.delete(sync);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);
  return state;
}
