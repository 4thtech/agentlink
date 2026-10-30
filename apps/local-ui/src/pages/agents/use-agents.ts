// U3-h: one hook that reads the Agents list for the page and the switcher, re-reads on request, and
// carries the switch. The page and the top bar listen to the same window event, so a rename, add or
// remove in a sheet updates the bar at once (b11 §29.5).
// W4-SHELL: a switch never reloads the page. The answer to the switch carries the new generation;
// the generation guard hands it to the router, which mounts every view again for the agent that is
// open now (api/generation.ts, router.tsx). The last list read is kept, so a view mounted again
// shows the last known label until its own read answers (b11 §29.1 "Loading"), and the label of the
// agent switched to is announced once ("Now showing {label}", §29.9).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createAgentsApi, type AgentsApi, type SwitchOutcome } from './api.js';
import type { AgentsList } from './data.js';
import { AGENTS_STRINGS as S } from './strings.js';

const CHANGED = 'agentlink:agents-changed';

/** The last list any view read (module state: it outlives a view mounted again after a switch). */
let lastList: AgentsList | undefined;

/** For tests: forget the last list and the note. */
export function resetAgentsCacheForTests(): void {
  lastList = undefined;
  note = '';
}

let note = '';
const noteListeners = new Set<() => void>();

/** "Now showing {label}" after a switch (b11 §29.9), read by the router's polite status line. */
export function noteSwitched(text: string): void {
  note = text;
  for (const l of noteListeners) l();
}

export function useSwitchedNote(): string {
  return useSyncExternalStore(
    (on) => {
      noteListeners.add(on);
      return () => {
        noteListeners.delete(on);
      };
    },
    () => note,
  );
}

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

/**
 * `afterSwitch` runs after a switch the server took (default: nothing more; the generation guard
 * swaps the views). A test passes its own.
 */
export function useAgents(api: AgentsApi | undefined, afterSwitch?: () => void): UseAgents {
  const [client] = useState<AgentsApi>(() => api ?? createAgentsApi());
  const [state, setState] = useState<AgentsState>(() =>
    lastList === undefined ? { kind: 'loading' } : { kind: 'loading', last: lastList },
  );
  const lastRef = useRef<AgentsList | undefined>(lastList);
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
        lastList = result.list;
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
      const label = lastRef.current?.agents.find((a) => a.name === name)?.label;
      const outcome = await client.switchTo(name, generation);
      // Every view shows the agent that is open now (b11 §29.1), without a reload: the guard saw
      // the new generation on this answer. Every listener reads the list again; a refusal too.
      if (outcome.kind === 'done') {
        if (label !== undefined) noteSwitched(S.nowShowing(label));
        afterSwitch?.();
      }
      announceAgentsChanged();
      return outcome;
    },
    [client, afterSwitch],
  );
  return { state, reload: read, switchTo };
}

export function listOf(state: AgentsState): AgentsList | undefined {
  return state.kind === 'ready' ? state.list : state.last;
}
