// W4-AGENTS (W4 UX v2 "three layers", A8 and A11; was U3-h, b11 §29.2): the Agents section. One
// route, two layers: simple, a card per agent with its live line and its actions; Under the hood,
// the same route as a fleet table (Decision 47: the screen morphs in place, never another route
// tree). `/agents/<name>` is one agent's own page. The live state comes from the one shared live
// store (api/live.ts), so the page updates by itself; actions go through the owner client and the
// presence gate (the page never signs). Pause, Resume and the AI apps act on the open agent only;
// on another agent the page switches to it first and carries on after the switch (intent.ts).
// Labels are rendered as text only, in their own bidi run (I-5).
import {
  Button,
  EmptyState,
  SkeletonGate,
  SkeletonList,
  SkeletonTable,
  Surface,
  useHood,
} from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
} from 'react';
import { getLive, subscribeLive } from '../../api/live.js';
import { lazyPart } from '../../lazy/index.js';
import { agentNameOf, NEW_AGENT_PATH } from '../../nav.js';
import type { AppsApi } from '../apps/api.js';
import { createOwnerClient, type OwnerClient } from '../contacts/owner.js';
import { createAgentsApi, type AgentsApi } from './api.js';
import { orderAgents, stateOf, tidyCandidates, type AgentRow, type AgentsList } from './data.js';
import { AgentDetail } from './detail.js';
import { createDetailApi, type DetailApi } from './detail-api.js';
import { Fleet, fleetSummary } from './fleet.js';
import { recordLive } from './history.js';
import { forgetIntent, rememberIntent, takeIntent, type IntentAction } from './intent.js';
import { PausedBanner, PauseSheet, ResumeGate } from './parts.js';
import { AddSheet, RemoveSheet } from './sheets.js';
import { AgentCard, type Panel } from './simple.js';
import { AGENTS_STRINGS as S } from './strings.js';
import { announceAgentsChanged, listOf, useAgents } from './use-agents.js';
import { markAgentsOpened } from './tidy.js';
import './agents.css';

/** The Map view (card U3-map): the same rows, drawn its own way; Under the hood only. */
export type AgentsMapView = ComponentType<{
  readonly agents: readonly AgentRow[];
  /** "+N more agents" shows the List. */
  readonly onShowList?: () => void;
  /** Another agent's box: switch to it. */
  readonly onSwitch?: (row: AgentRow) => void;
}>;
// The map is fetched on first use (b11 §32.4: lazy-loaded), never with the list.
const lazyMap = lazyPart(async () => (await import('./map/index.js')).AgentsMap);
let mapView: AgentsMapView | undefined = lazyMap.Part;
export function setAgentsMapView(view: AgentsMapView | undefined): void {
  mapView = view;
}

/** "New agent" reuses the Get started steps (U2): `/start/app?add=agent` (nav.ts, W4-WIRE). */
export { NEW_AGENT_PATH };

export interface AgentsPageProps {
  readonly api?: AgentsApi;
  readonly owner?: OwnerClient;
  /** The AI apps client of the change panel (tests). */
  readonly apps?: AppsApi;
  /** The fetch of the agent page's reads (tests). */
  readonly fetch?: typeof fetch;
  /**
   * Runs after a switch the server took. Default: nothing; W4-SHELL: the generation guard swaps
   * every view for the agent that is open now, with no reload (router.tsx).
   */
  readonly reload?: () => void;
}

const NAV_EVENTS = ['popstate', 'agentlink:navigate'] as const;
function subscribePath(on: () => void): () => void {
  for (const e of NAV_EVENTS) window.addEventListener(e, on);
  return () => {
    for (const e of NAV_EVENTS) window.removeEventListener(e, on);
  };
}
const pathNow = (): string => location.pathname.replace(/\/+$/, '') || '/';

/** Seconds now, ticking every 30 s so "5 min ago" stays true. */
function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function AgentsPage({
  api: givenApi,
  owner: givenOwner,
  apps,
  fetch: givenFetch,
  reload,
}: AgentsPageProps = {}): ReactElement {
  const api = useMemo(() => givenApi ?? createAgentsApi(), [givenApi]);
  const owner = useMemo(() => givenOwner ?? createOwnerClient(), [givenOwner]);
  const detailApi: DetailApi = useMemo(
    () => createDetailApi(givenFetch === undefined ? {} : { fetch: givenFetch }),
    [givenFetch],
  );
  const hood = useHood();
  const now = useNow();
  const path = useSyncExternalStore(subscribePath, pathNow);
  const detailName = agentNameOf(path);

  // The page's own read (actions, the switch) and the shared live store (updates by itself). Each
  // live answer is recorded for the agent page's history before the views draw it.
  const { state, reload: reread, switchTo } = useAgents(api, reload);
  // The shared live store keeps the stream (or the poll) running and announces changes, so the
  // page's own read follows; in polling mode the store's own read is the newest. Whichever answer
  // arrived last is shown; the agent page's history records each shown answer once.
  const subscribe = useCallback((on: () => void) => subscribeLive(on, { api }), [api]);
  const live = useSyncExternalStore(subscribe, getLive);
  const own = listOf(state);
  const [latest, setLatest] = useState<AgentsList | undefined>(undefined);
  useEffect(() => {
    if (live.list !== undefined) setLatest(live.list);
  }, [live.list]);
  useEffect(() => {
    if (own !== undefined) setLatest(own);
  }, [own]);
  const list: AgentsList | undefined = latest ?? own ?? live.list;
  // One sample per shown answer; the page draws again so the agent page sees it.
  const [, setRecorded] = useState(0);
  useEffect(() => {
    if (latest === undefined) return;
    recordLive(latest);
    setRecorded((n) => n + 1);
  }, [latest]);

  const [panel, setPanel] = useState<{ name: string; panel: Panel } | undefined>(undefined);
  // `?add=1` (an older link; W4-WIRE: the chip's "Add agent" now opens Get started) opens Add here,
  // also when the page is already open; it is then taken off the address, so the next one is a change.
  const search = useSyncExternalStore(subscribePath, () => location.search);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(search).get('add') !== '1') return;
    setAdding(true);
    history.replaceState(history.state, '', location.pathname);
  }, [search]);
  const [removeQueue, setRemoveQueue] = useState<readonly AgentRow[]>([]);
  const [pausing, setPausing] = useState<AgentRow | undefined>(undefined);
  const [resuming, setResuming] = useState(false);
  const [cardName, setCardName] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    markAgentsOpened();
  }, []);

  const rows = useMemo(() => orderAgents(list?.agents ?? []), [list]);
  const tidy = useMemo(() => new Set(tidyCandidates(rows).map((r) => r.name)), [rows]);
  const generation = list?.generation;
  const open = rows.find((r) => r.current);
  const labelOf = useCallback(
    (folder: string): string => rows.find((r) => r.name === folder)?.label ?? folder,
    [rows],
  );

  const changed = useCallback((): void => announceAgentsChanged(), []);
  const agentChanged = useCallback((): void => {
    setNotice(S.agentChanged);
    announceAgentsChanged();
  }, []);

  // What to do once another agent is open (a switch-first press). Taken from the page's own fresh
  // read only (the shared store may still hold the agent before the switch), and kept until a read
  // shows that agent open (intent.ts). The page that pressed never takes its own: it is mounted
  // again for the agent now open.
  const pressedHere = useRef(false);
  const act = useCallback((action: IntentAction, row: AgentRow): void => {
    if (action === 'pause') setPausing(row);
    else if (action === 'resume') setResuming(true);
    else setPanel({ name: row.name, panel: 'apps' });
  }, []);
  const fresh = state.kind === 'ready' ? state.list : undefined;
  useEffect(() => {
    if (pressedHere.current || fresh === undefined) return;
    const row = fresh.agents.find((r) => r.current);
    if (row === undefined) return;
    const action = takeIntent(fresh.current);
    if (action !== undefined) act(action, row);
  }, [fresh, act]);

  // D-141: "Contacts still see {cardName}" for the open agent, read once.
  useEffect(() => {
    let live = true;
    void api.cardName().then((out) => {
      if (live && out.kind === 'differs') setCardName(out.cardName);
    });
    return () => {
      live = false;
    };
  }, [api]);

  const doSwitch = useCallback(
    (row: AgentRow): void => {
      setNotice(undefined);
      void switchTo(row.name).then((outcome) => {
        if (outcome.kind === 'agent_changed') setNotice(S.agentChanged);
        if (outcome.kind !== 'done') {
          pressedHere.current = false;
          forgetIntent();
        }
      });
    },
    [switchTo],
  );
  /** Pause, Resume and AI apps on another agent: switch to it first (08 §1). */
  const firstOpen = useCallback(
    (row: AgentRow, action: IntentAction): void => {
      if (row.current) return act(action, row);
      pressedHere.current = true;
      rememberIntent({ name: row.name, action });
      setNotice(S.switching(row.label));
      doSwitch(row);
    },
    [act, doSwitch],
  );

  const onPause = (row: AgentRow): void => firstOpen(row, 'pause');
  const onResume = (row: AgentRow): void => firstOpen(row, 'resume');
  const onAppsElsewhere = (row: AgentRow): void => firstOpen(row, 'apps');
  const onRenamed = (label: string, told: boolean): void => {
    setNotice(told ? S.renamedTold(label) : undefined);
  };

  const pausedOpen = open !== undefined && stateOf(open) === 'paused' ? open : undefined;
  const banner =
    pausedOpen === undefined ? null : (
      <PausedBanner row={pausedOpen} resuming={resuming} onResume={() => setResuming(true)}>
        {resuming ? (
          <ResumeGate
            row={pausedOpen}
            api={api}
            owner={owner}
            onCancel={() => setResuming(false)}
            onResumed={() => {
              setResuming(false);
              changed();
            }}
            onAgentChanged={() => {
              setResuming(false);
              agentChanged();
            }}
          />
        ) : null}
      </PausedBanner>
    );
  // The Resume gate of an agent that is not shown as paused (an intent, or a stale read).
  const resumeLoose =
    resuming && pausedOpen === undefined && open !== undefined ? (
      <ResumeGate
        row={open}
        api={api}
        owner={owner}
        onCancel={() => setResuming(false)}
        onResumed={() => {
          setResuming(false);
          changed();
        }}
        onAgentChanged={() => {
          setResuming(false);
          agentChanged();
        }}
      />
    ) : null;

  const loading = list === undefined && state.kind === 'loading';
  const failed = list === undefined && state.kind === 'error';
  const detail = detailName === undefined ? undefined : rows.find((r) => r.name === detailName);
  const MapView = mapView;
  const [view, setView] = useState<'list' | 'map'>('list');

  let body: ReactElement;
  const errorBox = (
    <Surface as="section" level={1} className="ag-error-box">
      <p className="al-text-body" role="alert">
        {S.loadError}
      </p>
      <Button variant="secondary" onClick={reread}>
        {S.tryAgain}
      </Button>
    </Surface>
  );
  if (failed && detailName !== undefined) {
    body = errorBox;
  } else if (detailName !== undefined) {
    body =
      detail === undefined ? (
        list === undefined ? (
          <SkeletonGate loading skeleton={<SkeletonList rows={4} />} label={S.loading} />
        ) : (
          <div className="ag-detail">
            <a className="ag-back al-text-body-sm" href="/agents">
              {S.backToAgents}
            </a>
            <p className="al-text-body">{S.noSuchAgent}</p>
          </div>
        )
      ) : (
        <AgentDetail
          row={detail}
          now={now}
          detailApi={detailApi}
          owner={owner}
          {...(apps === undefined ? {} : { apps })}
          labelOf={labelOf}
          banner={detail.current ? banner : null}
          onPause={onPause}
          onResume={onResume}
          onSwitch={doSwitch}
          onAppsElsewhere={onAppsElsewhere}
          onChanged={changed}
          onAgentChanged={agentChanged}
        />
      );
  } else {
    const head = (
      <div className="ag-head">
        <div className="ag-head-text">
          <h1 className="al-text-h1">
            {S.title}
            {hood && list !== undefined ? <span className="ag-count">{rows.length}</span> : null}
          </h1>
          <p className="al-text-body-sm al-muted">
            {hood && list !== undefined ? fleetSummary(rows) : S.intro}
          </p>
        </div>
        <div className="ag-head-tools">
          {hood && MapView !== undefined ? (
            <span className="ag-views">
              <Button
                variant={view === 'list' ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                {S.list}
              </Button>
              <Button
                variant={view === 'map' ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={view === 'map'}
                onClick={() => setView('map')}
              >
                {S.map}
              </Button>
            </span>
          ) : null}
          {list?.switchable === false ? null : (
            <a className="al-btn al-btn-primary al-btn-md" href={NEW_AGENT_PATH}>
              {S.newAgent}
            </a>
          )}
        </div>
      </div>
    );
    const content = failed ? (
      errorBox
    ) : list !== undefined && rows.length === 0 ? (
      <EmptyState
        title={S.empty}
        action={
          <a className="al-btn al-btn-primary al-btn-md" href={NEW_AGENT_PATH}>
            {S.newAgent}
          </a>
        }
      />
    ) : hood && view === 'map' && MapView !== undefined ? (
      <MapView agents={rows} onShowList={() => setView('list')} onSwitch={doSwitch} />
    ) : hood ? (
      <Fleet
        rows={rows}
        now={now}
        onPause={onPause}
        onResume={onResume}
        onRemove={(picked) => setRemoveQueue(picked)}
      />
    ) : (
      <div className="ag-cards">
        {rows.map((row) => (
          <AgentCard
            key={row.name}
            row={row}
            tidy={tidy.has(row.name)}
            actions={{
              api,
              owner,
              ...(apps === undefined ? {} : { apps }),
              now,
              labelOf,
              cardName,
              panel,
              setPanel,
              onPause,
              onResume,
              onSwitch: doSwitch,
              onRemove: (r) => setRemoveQueue([r]),
              onAppsElsewhere,
              onRenamed,
              onCardUpdated: (told) => {
                setCardName(undefined);
                setNotice(told && open !== undefined ? S.renamedTold(open.label) : undefined);
                changed();
              },
              onChanged: changed,
              onAgentChanged: agentChanged,
            }}
          />
        ))}
      </div>
    );
    body = (
      <>
        {head}
        {banner}
        {resumeLoose}
        {state.kind === 'error' && list !== undefined ? (
          <p className="al-text-body-sm" role="alert">
            {S.loadError}{' '}
            <button type="button" className="ag-link" onClick={reread}>
              {S.tryAgain}
            </button>
          </p>
        ) : null}
        <SkeletonGate
          loading={loading}
          skeleton={hood ? <SkeletonTable rows={4} columns={5} /> : <SkeletonList rows={3} />}
          label={S.loading}
        >
          {list === undefined && !failed ? null : content}
        </SkeletonGate>
      </>
    );
  }

  const removing = removeQueue[0];
  return (
    <main className="ag-page" data-layer={hood ? 'pro' : 'simple'}>
      <div className="ag-live al-text-body-sm" role="status" aria-live="polite">
        {notice}
      </div>
      {body}

      {pausing !== undefined && generation !== undefined ? (
        <PauseSheet
          row={pausing}
          generation={generation}
          api={api}
          onClose={() => setPausing(undefined)}
          onPaused={() => {
            setPausing(undefined);
            changed();
          }}
          onAgentChanged={() => {
            setPausing(undefined);
            agentChanged();
          }}
        />
      ) : null}
      {adding && generation !== undefined ? (
        <AddSheet
          api={api}
          owner={owner}
          existing={rows}
          onClose={() => setAdding(false)}
          onChanged={changed}
          onAdded={(label, switchToIt) => {
            if (!switchToIt) return;
            const before = new Set(rows.map((r) => r.name));
            void api.list().then((result) => {
              if (result.kind !== 'ok') return;
              const fresh = result.list.agents.find(
                (r) => !before.has(r.name) && r.label === label,
              );
              if (fresh !== undefined) void switchTo(fresh.name);
            });
          }}
        />
      ) : null}
      {removing !== undefined && generation !== undefined ? (
        <RemoveSheet
          key={removing.name}
          row={removing}
          api={api}
          owner={owner}
          onClose={() => {
            setRemoveQueue([]);
            reread();
          }}
          onChanged={changed}
          onRemoved={(label) => {
            setRemoveQueue((q) => q.slice(1));
            setNotice(S.removed(label));
          }}
          onAgentChanged={() => {
            setRemoveQueue([]);
            agentChanged();
            reread();
          }}
        />
      ) : null}
    </main>
  );
}
