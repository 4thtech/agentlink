// W4-SHELL-V2 (W4 UX v2 Layer 3 "Live status strip"; prototype v23 A10/A11): under the top bar while
// Under the hood is on. Per AI app its heartbeat (a dot; Working pulses) and the agent in it, then
// AgentLink itself. It reads the same shared live store as the agent chip (api/live.ts; W4-SHELL-LIVE:
// the events stream) and the shell's connection state ("AgentLink running"); it never polls on its
// own. The relay link and its latency, the outgoing queue, credits and the last proof have no read
// the page can follow yet (credits are a chain read on Proofs & credits): they are not shown, never
// a made-up value. Its height is fixed and it shows no item until the first answer, so the apps never
// push an item along (layout shift). App and agent names are text only (I-5).
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import type { ApiResult } from '../api/client.js';
import { parseRelays } from '../pages/advanced/relays.js';
import { parseHealth, readHealth } from './health.js';
import { subscribeHealth } from './health-feed.js';
import { getLive, subscribeLive, LIVE_WORDS, type LiveState } from '../api/live.js';
import { LiveDot } from './agent-switcher.js';
import { SHELL_STRINGS as S } from '../strings.js';
import type { ConnectionState } from './index.js';
import { VT_CLASS } from '@4thtech-io/ui';

export interface StripItem {
  readonly label: string;
  readonly value: string;
  /** Absent for a plain fact (no dot). */
  readonly state?: LiveState;
}

/**
 * N19 (spec §2.3): the server's own facts from the health read it already answers: version, the port
 * the page is served on, the relays connected and the last sync. Counts and words only; never an
 * address, path or key. The data folder and uptime have no read yet, so they are not shown.
 */
export function serverFacts(
  result: ApiResult<unknown> | undefined,
  port: string,
  locale?: string,
): StripItem[] {
  if (result === undefined) return [];
  const health = parseHealth(result);
  if (health === undefined) return [];
  const items: StripItem[] = [];
  if (health.version !== undefined)
    items.push({ label: S.hoodServerVersion, value: health.version });
  if (/^\d{1,5}$/.test(port)) items.push({ label: S.hoodServerPort, value: port });
  const relays = parseRelays(result);
  if (relays?.connected !== undefined && relays.total !== undefined) {
    items.push({
      label: S.hoodServerRelays,
      value: `${String(relays.connected)} of ${String(relays.total)} connected`,
    });
  }
  if (relays?.lastSyncAt !== undefined) {
    items.push({
      label: S.hoodServerLastSync,
      value: new Date(relays.lastSyncAt * 1000).toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit',
      }),
    });
  }
  return items;
}

function useServerFacts(): StripItem[] {
  const [result, setResult] = useState<ApiResult<unknown> | undefined>(undefined);
  useEffect(() => subscribeHealth(readHealth, { onResult: setResult }), []);
  const port = typeof window === 'undefined' ? '' : window.location.port;
  return serverFacts(result, port);
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

/** One item per AI app (the busiest agent in it), then AgentLink itself. */
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
    // An agent is named where it is at work in the app; otherwise the state's own word.
    value:
      state === 'working' || state === 'ready' || state === 'idle' || state === 'paused'
        ? `${agent} ${LIVE_WORDS[state].toLowerCase()}`
        : LIVE_WORDS[state].toLowerCase(),
    state,
  }));
  // The app's own state from the health read (IR-W4-SHELL-V2-1): the relay link itself is not known
  // here until K1 reports it, so it is never claimed.
  items.push({ label: 'AgentLink', ...APP_STATE[connection] });
  return items;
}

const APP_STATE: Readonly<Record<ConnectionState, { value: string; state: LiveState }>> = {
  connected: { value: 'running', state: 'ready' },
  unknown: { value: 'checking', state: 'off' },
  paused: { value: 'paused', state: 'paused' },
  not_running: { value: 'not running', state: 'off' },
  needs_setup: { value: 'needs setup', state: 'none' },
  offline: { value: 'not connected', state: 'off' },
};

export function StatusStrip({
  connection,
}: {
  readonly connection: ConnectionState;
}): ReactElement {
  const live = useSyncExternalStore((on) => subscribeLive(on), getLive, getLive);
  // No item before the first answer (the region keeps its height): nothing moves when it comes.
  const items = live.list === undefined && !live.error ? [] : stripItems(live.agents, connection);
  const facts = useServerFacts();
  return (
    <div className={`al-strip ${VT_CLASS.strip}`} role="region" aria-label={S.liveStatus}>
      <ul className="al-strip-list al-text-code">
        {items.map((item) => (
          <li key={item.label} className="al-strip-item">
            {item.state === undefined ? null : <LiveDot state={item.state} />}
            <span className="al-strip-label">{item.label}</span>
            <span className="al-strip-value">{item.value}</span>
          </li>
        ))}
        {items.length === 0
          ? null
          : facts.map((item) => (
              <li key={item.label} className="al-strip-item" data-server-fact>
                <span className="al-strip-label">{item.label}</span>
                <span className="al-strip-value">{item.value}</span>
              </li>
            ))}
      </ul>
    </div>
  );
}
