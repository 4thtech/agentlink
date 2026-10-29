// U3-h: one hook that reads the Agents list for the page and the switcher, re-reads on request, and
// carries the switch. The page and the top bar listen to the same window event, so a rename, add or
// remove in a sheet updates the bar at once (b11 §29.5).
import { useCallback, useEffect, useRef, useState } from 'react';
import { createAgentsApi, type AgentsApi, type SwitchOutcome } from './api.js';
import type { AgentsList } from './data.js';

const CHANGED = 'agentlink:agents-changed';

/** Tell every listener (the top bar, the page) to read the list again. */
export function announceAgentsChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

export type AgentsState =
  | { readonly kind: 'loading'; readonly last?: AgentsList }
  | { readonly kind: 'ready'; readonly list: AgentsList }
  | { readonly kind: 'error'; readonly last?: AgentsList };

export interface UseAgents {
  readonly state: AgentsState;
  readonly reload: () => void;
  readonly switchTo: (name: string) => Promise<SwitchOutcome>;
}

export function useAgents(api: AgentsApi | undefined, reloadPage: () => void): UseAgents {
  const [client] = useState<AgentsApi>(() => api ?? createAgentsApi());
  const [state, setState] = useState<AgentsState>({ kind: 'loading' });
  const lastRef = useRef<AgentsList | undefined>(undefined);
  const live = useRef(true);
  const read = useCallback(() => {
    setState((s) =>
      s.kind === 'ready'
        ? s
        : lastRef.current
          ? { kind: 'loading', last: lastRef.current }
          : { kind: 'loading' },
    );
    void client.list().then((result) => {
      if (!live.current) return;
      if (result.kind === 'ok') {
        lastRef.current = result.list;
        setState({ kind: 'ready', list: result.list });
      } else {
        setState(lastRef.current ? { kind: 'error', last: lastRef.current } : { kind: 'error' });
      }
    });
  }, [client]);
  useEffect(() => {
    live.current = true;
    read();
    window.addEventListener(CHANGED, read);
    return () => {
      live.current = false;
      window.removeEventListener(CHANGED, read);
    };
  }, [read]);
  const switchTo = useCallback(
    async (name: string): Promise<SwitchOutcome> => {
      const generation = lastRef.current?.generation;
      if (generation === undefined) return { kind: 'failed' };
      const outcome = await client.switchTo(name, generation);
      // Every page reloads for the agent that is open now (b11 §29.1). A refusal re-reads instead.
      if (outcome.kind === 'done') reloadPage();
      else read();
      return outcome;
    },
    [client, reloadPage, read],
  );
  return { state, reload: read, switchTo };
}

export function listOf(state: AgentsState): AgentsList | undefined {
  return state.kind === 'ready' ? state.list : state.last;
}
