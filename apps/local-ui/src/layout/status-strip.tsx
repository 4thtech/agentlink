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
 * the page is served on, the relays connected, the last sync, and (REL051-B3b) the data folder with
 * the home folder as `~` and the server's uptime. Counts and words only; never an address or key,
 * and no path but a home-relative data folder (an absolute one is not shown).
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
  const data = result.kind === 'ok' ? (result.data as Record<string, unknown>) : {};
  const folder = dataFolderOf(data['dataFolder']);
  if (folder !== undefined) items.push({ label: S.hoodServerDataFolder, value: folder });
  const uptime = uptimeOf(data['uptimeSeconds']);
  if (uptime !== undefined) items.push({ label: S.hoodServerUptime, value: uptime });
  return items;
}

// Control, format and bidi characters: a folder holding one is not shown.
const UNSHOWABLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

/**
 * REL051-B3b: the data folder only as the server trims it (home as `~`, as on the AI apps page);
 * anything else, an absolute path above all, is not shown.
 */
function dataFolderOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 200 || UNSHOWABLE.test(value)) return undefined;
  return value === '~' || value.startsWith('~/') || value.startsWith('~\\') ? value : undefined;
}

/** REL051-B3b: whole seconds as a short duration ("1 h 2 min"); else nothing. */
export function uptimeOf(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined;
  if (value < 60) return S.hoodUptimeUnderMinute;
  const days = Math.floor(value / 86_400);
  const hours = Math.floor((value % 86_400) / 3_600);
  const minutes = Math.floor((value % 3_600) / 60);
  if (days > 0) return `${String(days)} d ${String(hours)} h`;
  if (hours > 0) return `${String(hours)} h ${String(minutes)} min`;
  return `${String(minutes)} min`;
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
