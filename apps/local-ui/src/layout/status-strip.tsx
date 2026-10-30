// W4-SHELL-V2 (W4 UX v2 Layer 3 "Live status strip"; prototype v23 A10/A11): under the top bar while
// Under the hood is on. Per AI app a dot and the agent in it, then the relay connection. It reads the
// same shared live store as the agent chip (api/live.ts) and the shell's connection state; it never
// polls on its own. Latency, the outgoing queue, credits and the last proof join when their reads
// exist (K1 live status, U6 Advanced); until then they are not shown (never a made-up value).
// App and agent names are text only (I-5).
import { useSyncExternalStore, type ReactElement } from 'react';
import { getLive, subscribeLive, LIVE_WORDS, type LiveState } from '../api/live.js';
import { SHELL_STRINGS as S } from '../strings.js';
import type { ConnectionState } from './index.js';
import { VT_CLASS } from './motion.js';

export interface StripItem {
  readonly label: string;
  readonly value: string;
  readonly state: LiveState;
}

const RANK: Readonly<Record<LiveState, number>> = {
  working: 0,
  ready: 1,
  idle: 2,
  paused: 3,
  off: 4,
  none: 5,
  removing: 6,
};

/** One item per AI app (the busiest agent in it), then the relay. */
export function stripItems(
  agents: ReturnType<typeof getLive>['agents'],
  connection: ConnectionState,
): StripItem[] {
  const best = new Map<string, { state: LiveState; agent: string }>();
  for (const a of agents) {
    for (const app of a.apps) {
      const seen = best.get(app.app);
      if (seen === undefined || RANK[app.state] < RANK[seen.state]) {
        best.set(app.app, { state: app.state, agent: a.label });
      }
    }
  }
  const items: StripItem[] = [...best].map(([app, { state, agent }]) => ({
    label: app,
    value:
      state === 'working' || state === 'ready' || state === 'paused'
        ? `${agent} ${LIVE_WORDS[state].toLowerCase()}`
        : LIVE_WORDS.off.toLowerCase(),
    state,
  }));
  const relayUp = connection === 'connected';
  items.push({
    label: 'Relay',
    value: relayUp ? 'connected' : connection === 'unknown' ? 'checking' : 'not connected',
    state: relayUp ? 'ready' : 'off',
  });
  return items;
}

export function StatusStrip({ connection }: { readonly connection: ConnectionState }): ReactElement {
  const live = useSyncExternalStore((on) => subscribeLive(on), getLive, getLive);
  const items = stripItems(live.agents, connection);
  return (
    <div className={`al-strip ${VT_CLASS.strip}`} role="region" aria-label={S.liveStatus}>
      <ul className="al-strip-list al-text-code">
        {items.map((item) => (
          <li key={item.label} className="al-strip-item">
            <span className={`al-ldot is-${item.state}`} aria-hidden="true" />
            <span className="al-strip-label">{item.label}</span>
            <span className="al-strip-value">{item.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
