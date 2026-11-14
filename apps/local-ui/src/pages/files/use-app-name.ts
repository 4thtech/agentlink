// The name of the AI app the open ID works from ("Claude Code"), for the fixed per-app tip (11 §5.7).
// Read from the live store the shell already keeps; undefined when no AI app is known. Display only.
import { useSyncExternalStore } from 'react';
import { getLive, subscribeLive } from '../../api/live.js';

const EMPTY = { list: undefined, agents: [], error: false } as const;

export function useAppName(): string | undefined {
  const snap = useSyncExternalStore(subscribeLive, getLive, () => EMPTY);
  return snap.agents.find((a) => a.current)?.apps[0]?.app;
}
