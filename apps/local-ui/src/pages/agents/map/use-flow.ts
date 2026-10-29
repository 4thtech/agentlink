// U3-map: the flow read, polled every 3 s while the tab is visible and not at all while it is hidden
// (b11 §32.3, §32.4). The first read looks 24 hours back (to know each line's direction); later reads
// send the answer's cursor. A failed read stops the streams and keeps the last view dimmed.
import { useCallback, useEffect, useRef, useState } from 'react';
import { firstSince, type FlowApi } from './api.js';
import { mergeFlow, type ContactFlow } from './data.js';

export const FLOW_POLL_MS = 3_000;

export interface FlowState {
  readonly flow: ReadonlyMap<string, ContactFlow>;
  /** The server's clock in unix seconds, kept in step between reads. */
  readonly nowSec: () => number;
  readonly loaded: boolean;
  readonly failed: boolean;
  readonly retry: () => void;
}

const EMPTY: ReadonlyMap<string, ContactFlow> = new Map();
const localSec = (): number => Math.floor(Date.now() / 1000);

export function useFlow(api: FlowApi): FlowState {
  const [state, setState] = useState<{
    flow: ReadonlyMap<string, ContactFlow>;
    loaded: boolean;
    failed: boolean;
  }>({ flow: EMPTY, loaded: false, failed: false });
  const cursor = useRef<number | undefined>(undefined);
  const offset = useRef(0);
  const flowRef = useRef<ReadonlyMap<string, ContactFlow>>(EMPTY);
  const live = useRef(true);
  const reading = useRef(false);

  const read = useCallback(async (): Promise<void> => {
    if (reading.current) return;
    reading.current = true;
    try {
      const result = await api.read(cursor.current ?? firstSince(localSec()));
      if (!live.current) return;
      if (result.kind !== 'ok') {
        setState((s) => ({ ...s, loaded: true, failed: true }));
        return;
      }
      cursor.current = result.flow.cursor;
      offset.current = result.flow.now - localSec();
      flowRef.current = mergeFlow(flowRef.current, result.flow.items);
      setState({ flow: flowRef.current, loaded: true, failed: false });
    } finally {
      reading.current = false;
    }
  }, [api]);

  useEffect(() => {
    live.current = true;
    void read();
    const timer = setInterval(() => {
      if (!document.hidden) void read();
    }, FLOW_POLL_MS);
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

  const nowSec = useCallback((): number => localSec() + offset.current, []);
  const retry = useCallback(() => void read(), [read]);
  return { ...state, nowSec, retry };
}
