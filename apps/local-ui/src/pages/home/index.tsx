// Home (UI-REFRESH-g; B-11 §4, §7, §16, §17.4; plan §6; D-135): five live tiles and the Start here card (UX2-g; B-11 §27).
//
// Served at /settings/home until M1-11b-2 owns `/` for Approvals. Reads only routes that exist:
// /api/ui/health (the existing health poller: it pauses while the tab is hidden and reads again when
// shown), /api/ui/activity, /api/ui/proofs/credits and the approvals list. Start here has its own
// reads (use-start-here.ts: passkey, contacts, Messages, the kit flag), shared with the shell. The
// other four are read on first load and then at most every SECONDARY_MS from a health tick, so they
// pause with it. Nothing here changes anything.
//
// States: skeleton tiles on first load; fine; approvals waiting (orange edge); paused; not running
// (tiles go quiet, one instruction); offline (Network warns, the rest keep their last values marked
// "as of"); a read error (old values kept, "Trying again"). The tile frames never change size, so
// live updates do not move the page.
//
// I-5 / §17.4: every value is React text, from a typed parse (data.ts). Last activity says what
// happened in a fixed phrase and when; never message text, a contact's name or a file name.
import {
  CountBadge,
  Icon,
  LiveDot,
  RingMeter,
  Skeleton,
  useRowPresence,
  type LiveDotState,
} from '@4thtech-io/ui';
import { UnderTheHood } from '../../lazy/hood.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../api/client.js';
import { subscribeHealth } from '../../layout/health-feed.js';
import { HEALTH_PATH } from '../../layout/health.js';
import { createApprovalsClient, type ListAnswer } from '../approvals/client.js';
import { ACTIVITY_STRINGS as A } from '../activity/strings.js';
import { detectPlatform } from '../first-run/passkey.js';
import { type Platform } from '../first-run/strings.js';
import { CREDITS_PATH } from '../proofs/data.js';
import {
  ACTIVITY_PATH,
  creditsOf,
  parseEvents,
  parseHealthSnapshot,
  waitingOf,
  type CreditsView,
  type EventKind,
  type EventRow,
  type HealthSnapshot,
  type WaitingView,
} from './data.js';
import './home.css';
import { StartHere } from './start-here-card.js';
import { StartHereContext } from './start-here-context.js';
import type { StartHereReads } from './start-here.js';
import { useStartHere } from './use-start-here.js';
import {
  HOME_STRINGS as S,
  creditsLine,
  minutesLeft,
  routesLine,
  waitingCount,
} from './strings.js';

/** Health ticks come every 5 s; the other reads at most this often. */
const SECONDARY_MS = 14_000;
const METER_FLOOR = 100;

export interface HomePageProps {
  /** The API client; the app's default one when absent (tests pass their own). */
  readonly api?: ApiClient;
  /** The approvals list (the same route the Approvals page reads). */
  readonly approvals?: { list(): Promise<ListAnswer> };
  /** The reads behind Start here (UX2-g). Used when the shell does not share its own. */
  readonly startHere?: StartHereReads;
  readonly platform?: Platform;
  readonly now?: () => Date;
}

const EVENT_TEXT: Readonly<Record<EventKind, string>> = {
  approved: A.approved,
  approvedByRules: A.approvedByRules,
  denied: A.denied,
  cancelled: A.cancelled,
  proofSent: A.proofSent,
  proofReceived: A.proofReceived,
  senderBlocked: A.senderBlocked,
  contactBlocked: A.contactBlocked,
  rulesChanged: A.rulesChanged,
};
const EVENT_ICON: Readonly<Record<EventKind, string>> = {
  approved: 'approval',
  approvedByRules: 'approval',
  denied: 'approval',
  cancelled: 'approval',
  proofSent: 'proof-seal',
  proofReceived: 'proof-seal',
  senderBlocked: 'users',
  contactBlocked: 'users',
  rulesChanged: 'sliders-horizontal',
};

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const clock = (d: Date): string => CLOCK.format(d);
const secondsToDate = (s: number): Date => new Date(s * 1000);

function greeting(now: Date): string {
  const hour = now.getHours();
  return hour < 12 ? S.greetingMorning : hour < 18 ? S.greetingAfternoon : S.greetingEvening;
}

type Flag<T> = { readonly done: boolean; readonly value?: T };

interface Model {
  readonly health: Flag<HealthSnapshot>;
  readonly offline: boolean;
  readonly error: boolean;
  /** When the last good health answer came in (the "as of" time). */
  readonly asOf: Date | null;
  readonly waiting: Flag<WaitingView>;
  readonly credits: Flag<CreditsView | 'unavailable'>;
  readonly events: Flag<readonly EventRow[]>;
}

const EMPTY: Model = {
  health: { done: false },
  offline: false,
  error: false,
  asOf: null,
  waiting: { done: false },
  credits: { done: false },
  events: { done: false },
};

type Agent = HealthSnapshot['agent'];

const AGENT_DOT: Readonly<Record<Agent, LiveDotState>> = {
  connected: 'connected',
  paused: 'paused',
  not_running: 'not-running',
  needs_setup: 'needs-setup',
};
const AGENT_WORD: Readonly<Record<Agent, string>> = {
  connected: S.agentRunning,
  paused: S.agentPaused,
  not_running: S.agentNotRunning,
  needs_setup: S.agentNeedsSetup,
};
const AGENT_LINE: Readonly<Record<Agent, string>> = {
  connected: S.agentRunningLine,
  paused: S.agentPausedLine,
  not_running: S.agentNotRunningLine,
  needs_setup: S.agentNeedsSetupLine,
};

function Tile({
  id,
  title,
  href,
  loading,
  attention = false,
  stale,
  children,
}: {
  id: string;
  title: string;
  href: string;
  loading: boolean;
  attention?: boolean;
  stale?: string | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <section
      className="hm-tile"
      data-tile={id}
      data-attention={attention ? 'true' : undefined}
      aria-labelledby={`hm-${id}`}
    >
      <h2 id={`hm-${id}`} className="hm-tile-title al-text-label">
        <a className="hm-tile-link" href={href}>
          {title}
        </a>
      </h2>
      <div className="hm-tile-body">
        <Skeleton loading={loading} lines={2} label={`${title}: ${S.loading}`}>
          {children}
          {stale === undefined ? null : (
            <p className="hm-asof al-text-caption al-muted">
              {S.asOf} {stale}
            </p>
          )}
        </Skeleton>
      </div>
    </section>
  );
}

function EventItem({ row, isNew }: { row: EventRow; isNew: boolean }): ReactElement {
  const presence = useRowPresence<HTMLLIElement>(true, { isNew });
  const date = secondsToDate(row.at);
  return (
    <li ref={presence.ref} className="hm-event">
      {presence.highlight}
      <Icon name={EVENT_ICON[row.kind]} size={16} className="hm-event-icon" />
      <span className="hm-event-text al-text-body-sm">{EVENT_TEXT[row.kind]}</span>
      <time className="hm-event-time al-text-caption al-muted" dateTime={date.toISOString()}>
        {clock(date)}
      </time>
    </li>
  );
}

function ActivityList({ rows }: { rows: readonly EventRow[] }): ReactElement {
  const seen = useRef<Set<string> | null>(null);
  const keys = rows.map((r) => `${String(r.at)}-${r.kind}`);
  // The first list is not "new"; later rows that were not there before enter with the highlight.
  const first = seen.current === null;
  const known = seen.current ?? new Set<string>();
  const fresh = new Set(keys.filter((k) => !first && !known.has(k)));
  useEffect(() => {
    seen.current = new Set([...(seen.current ?? []), ...keys]);
  });
  return (
    <ul className="hm-events" aria-label={S.activityList}>
      {rows.map((r, i) => (
        <EventItem key={keys[i]} row={r} isNew={fresh.has(keys[i] as string)} />
      ))}
    </ul>
  );
}

function minutesUntil(expiresAt: number, now: Date): number {
  return Math.max(0, Math.ceil((expiresAt * 1000 - now.getTime()) / 60_000));
}

/**
 * The technical layer (B-11 §7): the global Under the hood panel (card e; it renders only while the
 * switch is on and keeps only allowlisted fields). Version and routes up; nothing else.
 */
function Hood({ health }: { health: HealthSnapshot | undefined }): ReactElement {
  const fields: { kind: 'id' | 'count'; label: string; value: string }[] = [];
  if (health?.version != null) {
    fields.push({ kind: 'id', label: S.hoodVersion, value: health.version });
  }
  if (health?.relays != null) {
    fields.push({
      kind: 'count',
      label: S.hoodRoutes,
      value: routesLine(health.relays.connected, health.relays.total),
    });
  }
  return (
    <div className="hm-hood" data-hood>
      <UnderTheHood fields={fields} />
    </div>
  );
}

export function HomePage({
  api,
  approvals,
  startHere,
  platform: givenPlatform,
  now = () => new Date(),
}: HomePageProps): ReactElement {
  const client = useRef<ApiClient>(api ?? createApiClient());
  const approvalsClient = useRef(approvals ?? createApprovalsClient());
  const clockNow = useRef(now);
  clockNow.current = now;
  const [model, setModel] = useState<Model>(EMPTY);
  const [platform] = useState<Platform>(() => givenPlatform ?? detectPlatform());
  const shared = useContext(StartHereContext);
  // The shell shares one Start here model; a lone Home runs its own.
  const own = useStartHere(startHere, shared === null);
  const start = shared ?? own;
  const live = useRef(true);
  const lastSecondary = useRef(0);
  const reading = useRef(false);

  const patch = useCallback((change: Partial<Model> | ((m: Model) => Partial<Model>)): void => {
    if (!live.current) return;
    setModel((m) => ({ ...m, ...(typeof change === 'function' ? change(m) : change) }));
  }, []);

  const loadSecondary = useCallback(async (): Promise<void> => {
    if (reading.current) return;
    reading.current = true;
    lastSecondary.current = Date.now();
    try {
      const get = (path: string): Promise<ApiResult<unknown>> => client.current.get(path);
      const [activity, credits, waiting] = await Promise.all([
        get(ACTIVITY_PATH),
        get(CREDITS_PATH),
        approvalsClient.current.list().catch((): ListAnswer => ({ kind: 'offline' })),
      ]);
      // A failed read keeps the value from before; the first read only marks the tile as settled.
      patch((m) => {
        const events = activity.kind === 'ok' ? parseEvents(activity.data) : undefined;
        const cr = credits.kind === 'ok' ? creditsOf(credits.data) : undefined;
        return {
          events:
            events === undefined ? { ...m.events, done: true } : { done: true, value: events },
          credits: cr === undefined ? { ...m.credits, done: true } : { done: true, value: cr },
          waiting:
            waiting.kind === 'ok'
              ? { done: true, value: waitingOf(waiting.items) }
              : { ...m.waiting, done: true },
        };
      });
    } catch {
      // A request that throws counts as no answer: old values stay, the tiles settle.
      patch((m) => ({
        events: { ...m.events, done: true },
        credits: { ...m.credits, done: true },
        waiting: { ...m.waiting, done: true },
      }));
    } finally {
      reading.current = false;
    }
  }, [patch]);

  useEffect(() => {
    live.current = true;
    void loadSecondary();
    // The shell's health poller is shared (layout/health-feed.ts): Home does not start a second one.
    const onResult = (result: ApiResult<unknown>): void => {
      if (!live.current) return;
      const snapshot = parseHealthSnapshot(result);
      if (snapshot !== undefined) {
        patch({
          health: { done: true, value: snapshot },
          offline: false,
          error: false,
          asOf: clockNow.current(),
        });
        if (Date.now() - lastSecondary.current >= SECONDARY_MS) void loadSecondary();
      } else if (result.kind === 'offline') {
        patch({ health: { done: true }, offline: true, error: false });
      } else {
        patch((m) => ({ health: { ...m.health, done: true }, offline: false, error: true }));
      }
    };
    const stop = subscribeHealth(() => client.current.get(HEALTH_PATH), { onResult });
    return () => {
      live.current = false;
      stop();
    };
  }, [loadSecondary, patch]);

  const today = now();
  const health = model.health.value;
  const agent: Agent = health?.agent ?? 'not_running';
  const stale = model.offline && model.asOf !== null ? clock(model.asOf) : undefined;
  const quiet = agent === 'not_running' && model.health.done;
  const waiting = model.waiting.value;
  const soonest = waiting?.soonest ?? null;

  const networkState: { dot: LiveDotState; word: string } = useMemo(() => {
    if (model.offline) return { dot: 'not-running', word: S.networkOffline };
    if (health === undefined || agent === 'not_running' || agent === 'needs_setup') {
      return { dot: 'not-running', word: S.networkNotConnected };
    }
    return health.relays !== null && health.relays.total > 0 && health.relays.connected === 0
      ? { dot: 'reconnecting', word: S.networkReconnecting }
      : { dot: 'connected', word: S.networkConnected };
  }, [model.offline, health, agent]);

  const credits = model.credits.value;

  return (
    <>
      <header className="hm-head">
        <time className="hm-date al-text-code" dateTime={today.toISOString()}>
          {DAY.format(today)}
        </time>
        <h1 className="al-text-title-1">{S.title}</h1>
        <p className="hm-greeting al-text-body al-muted">{greeting(today)}</p>
      </header>
      <StartHere model={start} platform={platform} />
      {model.offline ? (
        <p className="hm-note al-text-body-sm" role="status">
          <Icon name="wifi-off" size={16} />
          {S.offlineLine}
        </p>
      ) : model.error ? (
        <p className="hm-note al-text-body-sm" role="status">
          <Icon name="refresh-cw" size={16} />
          {S.errorLine}
        </p>
      ) : null}
      <div
        className="hm-tiles"
        data-tiles
        data-quiet={quiet ? 'true' : undefined}
        role="group"
        aria-label={S.tilesLabel}
      >
        <Tile
          id="agent"
          title={S.agentTitle}
          href="/settings/advanced"
          loading={!model.health.done}
          stale={stale}
        >
          <LiveDot state={AGENT_DOT[agent]} label={AGENT_WORD[agent]} className="hm-dot" />
          <p className="al-text-body-sm">{AGENT_LINE[agent]}</p>
        </Tile>
        <Tile
          id="network"
          title={S.networkTitle}
          href="/settings/advanced"
          loading={!model.health.done}
          stale={stale}
        >
          <LiveDot state={networkState.dot} label={networkState.word} className="hm-dot" />
        </Tile>
        <Tile
          id="waiting"
          title={S.waitingTitle}
          href="/"
          loading={!waiting && !model.waiting.done}
          attention={(waiting?.count ?? 0) > 0}
          stale={stale}
        >
          {waiting === undefined || waiting.count === 0 ? (
            <p className="al-text-body-sm">{S.waitingNone}</p>
          ) : (
            <>
              <p className="hm-count al-text-title-1">
                <CountBadge count={waiting.count} label={waitingCount(waiting.count)} />
              </p>
              {soonest === null ? null : (
                <p className="hm-soonest al-text-body-sm">
                  {soonest.summary} · {minutesLeft(minutesUntil(soonest.expiresAt, today))}
                </p>
              )}
              <a className="al-btn al-btn-primary al-btn-sm hm-review" href="/">
                {S.review}
              </a>
            </>
          )}
        </Tile>
        <Tile
          id="credits"
          title={S.creditsTitle}
          href="/settings/proofs"
          loading={!model.credits.done}
          stale={stale}
        >
          {credits === undefined || credits === 'unavailable' ? (
            <p className="al-text-body-sm">{S.creditsUnavailable}</p>
          ) : credits.proofsLeft === 0 ? (
            <p className="al-text-body-sm">{S.creditsNone}</p>
          ) : (
            <RingMeter
              label={S.creditsMeter}
              value={credits.proofsLeft}
              max={Math.max(METER_FLOOR, credits.proofsLeft)}
              text={creditsLine(credits.balance, credits.proofsLeft)}
            />
          )}
        </Tile>
        <Tile
          id="activity"
          title={S.activityTitle}
          href="/settings/activity"
          loading={!model.events.done}
          stale={stale}
        >
          {model.events.value === undefined || model.events.value.length === 0 ? (
            <p className="al-text-body-sm">{S.activityNone}</p>
          ) : (
            <ActivityList rows={model.events.value} />
          )}
        </Tile>
      </div>
      <Hood health={health} />
    </>
  );
}
