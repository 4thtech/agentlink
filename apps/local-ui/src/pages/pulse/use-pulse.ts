// One polite pulse read for a whole list (UX2-f2; b11 §24.2, §24.5): never one per conversation.
// It reads on mount, again every 60 s while the tab is visible, and once when the tab comes back; a
// hidden tab reads nothing. A failed read leaves the pulse flat (no per-row error, no alert).
//
// "Becomes Active now": a contact that is Active now in this read and was not in the one before. The
// first read has nothing before it, so rows already Active now when the list loads never pulse.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { PULSE_PATH, parsePulse, type Pulse } from './data.js';

export const POLL_MS = 60_000;

export interface PulseState {
  /** The latest good read; absent until one arrives or while reads fail. */
  readonly pulse: Pulse | undefined;
  /** Contacts that became Active now in the latest read. */
  readonly arrivals: ReadonlySet<string>;
  /** Counts good reads, so a row can tell one arrival from the next. */
  readonly seq: number;
  /** Read now (the list's Refresh button). */
  readonly refresh: () => void;
}

const NONE: ReadonlySet<string> = new Set();

export function usePulse(api: ApiClient): PulseState {
  const [state, setState] = useState<{
    pulse: Pulse | undefined;
    arrivals: ReadonlySet<string>;
    seq: number;
  }>({ pulse: undefined, arrivals: NONE, seq: 0 });
  const before = useRef<Pulse | undefined>(undefined);
  const live = useRef(true);
  const reading = useRef(false);

  const read = useCallback(async (): Promise<void> => {
    if (reading.current) return;
    reading.current = true;
    try {
      const result = await api.get<unknown>(PULSE_PATH);
      if (!live.current) return;
      const pulse = result.kind === 'ok' ? parsePulse(result.data) : undefined;
      if (pulse === undefined) {
        setState((s) => (s.pulse === undefined ? s : { ...s, pulse: undefined, arrivals: NONE }));
        return;
      }
      const arrivals = new Set<string>();
      const prev = before.current;
      if (prev !== undefined) {
        for (const c of pulse.contacts.values()) {
          if (
            c.activity === 'active_now' &&
            prev.contacts.get(c.contactId)?.activity !== 'active_now'
          ) {
            arrivals.add(c.contactId);
          }
        }
      }
      before.current = pulse;
      setState((s) => ({ pulse, arrivals, seq: s.seq + 1 }));
    } finally {
      reading.current = false;
    }
  }, [api]);

  useEffect(() => {
    live.current = true;
    void read();
    const timer = setInterval(() => {
      if (!document.hidden) void read();
    }, POLL_MS);
    const onVisible = (): void => {
      if (!document.hidden) void read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [read]);

  const refresh = useCallback(() => void read(), [read]);
  return { pulse: state.pulse, arrivals: state.arrivals, seq: state.seq, refresh };
}
