// U3-i: the AI apps page (b11 §30). One card per detected AI app with a state word read from the
// app's own file, then the exact AgentLink entry and Touch ID to apply, disconnect, or move the app
// to the open agent. An AI app serves one agent at a time; an agent may serve several apps. The page
// never signs and never sends a path: the server takes paths from its fixed table (06 §7). Names and
// paths are rendered as text only (I-5).
import { Button, EmptyState, Icon, Skeleton, Surface } from '@4thtech-io/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createAgentsApi, type AgentsApi } from '../agents/api.js';
import { announceAgentsChanged } from '../agents/use-agents.js';
import type { AgentsList } from '../agents/data.js';
import { createOwnerClient, type OwnerClient } from '../contacts/owner.js';
import { createAppsApi, type AppsApi } from './api.js';
import { cardState, type AppChange, type AppRow, type AppsList, type Entry } from './data.js';
import { ChangePanel, ManualPanel, type Labels } from './panel.js';
import { APPS_STRINGS as S } from './strings.js';
import './apps.css';

export interface AppsPageProps {
  readonly api?: AppsApi;
  readonly agents?: AgentsApi;
  readonly owner?: OwnerClient;
}

type Panel =
  | { readonly kind: 'change'; readonly app: AppRow }
  | {
      readonly kind: 'manual';
      readonly app: AppRow | undefined;
      readonly entry: Entry | undefined;
    };

/** `?agent=` of a Connect link: the agent the person wants to connect. */
function wantedAgent(): string | undefined {
  try {
    const value = new URLSearchParams(window.location.search).get('agent');
    return value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

function Card({
  row,
  open,
  labels,
  restart,
  running,
  primary,
  onReview,
  onManual,
  onRecheck,
}: {
  row: AppRow;
  open: string | null;
  labels: Labels;
  restart: boolean;
  running: boolean;
  primary: boolean;
  onReview: () => void;
  onManual: () => void;
  onRecheck: () => void;
}): ReactElement {
  const state = cardState(row, open);
  let word: string;
  let detail: string | undefined;
  let mark: ReactElement = <Icon name="circle" size={14} />;
  let actions: ReactElement | null = null;
  switch (state.kind) {
    case 'connected':
      word = S.connectedTo(labels.label);
      if (restart) {
        word = S.needsRestart;
        detail = S.restartToFinish(row.name);
        mark = <Icon name="triangle-alert" size={14} />;
      } else {
        mark = <Icon name="check" size={14} />;
        if (running) detail = S.running;
      }
      actions = restart ? (
        <button type="button" className="ap-link al-text-body-sm" onClick={onRecheck}>
          {S.checkAgain}
        </button>
      ) : (
        <Button variant="secondary" onClick={onReview}>
          {S.disconnect}
        </Button>
      );
      if (restart) word = `${S.connectedTo(labels.label)}. ${S.needsRestart}`;
      break;
    case 'another':
      word = S.connectedToAnother;
      detail = S.uses(labels.labelOf(state.agent));
      actions = (
        <Button variant="secondary" onClick={onReview}>
          {S.useInstead(labels.label)}
        </Button>
      );
      break;
    case 'quit_first':
      word = S.notConnected;
      detail = S.quitFirst(row.name);
      actions = (
        <>
          <Button variant="secondary" disabled>
            {S.reviewChange}
          </Button>
          <button type="button" className="ap-link al-text-body-sm" onClick={onRecheck}>
            {S.checkAgain}
          </button>
        </>
      );
      break;
    case 'not_ours':
      word = S.notConnected;
      detail = S.notOurs;
      mark = <Icon name="triangle-alert" size={14} />;
      actions = (
        <Button variant="secondary" onClick={onManual}>
          {S.showManual}
        </Button>
      );
      break;
    case 'unreadable':
      word = S.notConnected;
      detail = S.cantRead;
      mark = <Icon name="triangle-alert" size={14} />;
      actions = (
        <Button variant="secondary" onClick={onRecheck}>
          {S.tryAgain}
        </Button>
      );
      break;
    case 'not_connected':
      word = S.notConnected;
      actions = (
        <Button variant={primary ? 'primary' : 'secondary'} onClick={onReview}>
          {S.reviewChange}
        </Button>
      );
      break;
  }
  const warn = state.kind === 'not_ours' || state.kind === 'unreadable' || restart;
  return (
    <li
      className="ap-card"
      data-app={row.app}
      role="group"
      aria-label={S.cardName(row.name, restart ? S.needsRestart : word)}
    >
      <div className="ap-card-head">
        <span className="ap-mark" aria-hidden="true">
          <Icon name="ai-app" size={16} />
        </span>
        <h2 className="al-text-title-3">{row.name}</h2>
      </div>
      <p
        className={`ap-state al-text-body ${warn ? 'ap-warn' : state.kind === 'connected' ? 'ap-ok' : 'al-muted'}`}
      >
        <span aria-hidden="true">{mark}</span>
        <span>{word}</span>
      </p>
      {detail === undefined ? null : <p className="al-text-body-sm al-muted">{detail}</p>}
      <div className="ap-card-actions">{actions}</div>
    </li>
  );
}

export function AppsPage({ api, agents, owner }: AppsPageProps): ReactElement {
  const [appsApi] = useState<AppsApi>(() => api ?? createAppsApi());
  const [agentsApi] = useState<AgentsApi>(() => agents ?? createAgentsApi());
  const [ownerClient] = useState<OwnerClient>(() => owner ?? createOwnerClient());
  const [list, setList] = useState<AppsList | undefined>(undefined);
  const [people, setPeople] = useState<AgentsList | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [panel, setPanel] = useState<Panel | undefined>(undefined);
  const [restart, setRestart] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const live = useRef(true);

  const read = useCallback((): void => {
    void Promise.all([appsApi.list(), agentsApi.list()]).then(([apps, ags]) => {
      if (!live.current) return;
      setLoaded(true);
      if (apps.kind === 'ok') {
        setList(apps.list);
        setFailed(false);
      } else {
        setFailed(true);
      }
      if (ags.kind === 'ok') setPeople(ags.list);
    });
  }, [appsApi, agentsApi]);
  useEffect(() => {
    live.current = true;
    read();
    return () => {
      live.current = false;
    };
  }, [read]);

  const rows = people?.agents ?? [];
  const open = people?.current ?? null;
  const openRow = rows.find((r) => r.name === open);
  const labels: Labels = useMemo(
    () => ({
      folder: open ?? '',
      label: openRow?.label ?? people?.label ?? open ?? '',
      labelOf: (folder: string) => rows.find((r) => r.name === folder)?.label ?? folder,
    }),
    [open, openRow, people, rows],
  );

  // "Running" only where it is certain: the open agent runs and exactly one app is connected to it.
  const connectedHere = (list?.apps ?? []).filter(
    (a) => a.state === 'connected' && a.agent === open,
  );
  const wanted = wantedAgent();
  const otherWanted =
    wanted !== undefined && open !== null && wanted !== open
      ? rows.find((r) => r.name === wanted)
      : undefined;

  const closePanel = (): void => setPanel(undefined);
  const agentChanged = useCallback((): void => {
    setPanel(undefined);
    setNotice(S.agentChanged);
    read();
  }, [read]);
  const done = (change: AppChange): void => {
    setPanel(undefined);
    if (change.kind !== 'disconnect') setRestart((s) => new Set(s).add(change.app));
    else
      setRestart((s) => {
        const next = new Set(s);
        next.delete(change.app);
        return next;
      });
    setNotice(
      change.kind === 'disconnect'
        ? S.willStop(change.name, labels.label)
        : S.restartToFinish(change.name),
    );
    read();
    announceAgentsChanged();
  };

  const firstPrimary = (list?.apps ?? []).findIndex(
    (a) => cardState(a, open).kind === 'not_connected',
  );
  const switchToWanted = (): void => {
    if (otherWanted === undefined || people?.generation === undefined) return;
    void agentsApi.switchTo(otherWanted.name, people.generation).then((out) => {
      if (out.kind === 'done') window.location.reload();
      else read();
    });
  };

  return (
    <main className="ap-page">
      <div className="ap-head">
        <h1 className="al-text-h1">{S.title}</h1>
        {labels.label === '' ? null : (
          <p className="al-text-body al-muted">{S.forAgent(labels.label)}</p>
        )}
      </div>
      <div className="ap-live" role="status" aria-live="polite">
        {notice}
      </div>
      {otherWanted === undefined ? null : (
        <Surface as="section" level={1} className="ap-error">
          <p className="al-text-body">{S.switchFirst(otherWanted.label)}</p>
          <Button variant="secondary" onClick={switchToWanted}>
            {S.switchTo(otherWanted.label)}
          </Button>
        </Surface>
      )}
      {!loaded ? (
        <Skeleton loading lines={3}>
          <span />
        </Skeleton>
      ) : list === undefined && failed ? (
        <Surface as="section" level={1} className="ap-error">
          <p className="al-text-body" role="alert">
            {S.loadError}
          </p>
          <Button variant="secondary" onClick={read}>
            {S.tryAgain}
          </Button>
        </Surface>
      ) : list !== undefined && list.apps.length === 0 ? (
        <EmptyState
          title={S.none}
          action={
            <Button
              variant="secondary"
              onClick={() => setPanel({ kind: 'manual', app: undefined, entry: undefined })}
            >
              {S.showManual}
            </Button>
          }
        />
      ) : (
        <>
          {failed ? (
            <p className="al-text-body-sm" role="alert">
              {S.loadError}{' '}
              <button type="button" className="ap-link" onClick={read}>
                {S.tryAgain}
              </button>
            </p>
          ) : null}
          <ul className="ap-grid">
            {(list?.apps ?? []).map((row, i) => (
              <Card
                key={row.app}
                row={row}
                open={open}
                labels={labels}
                restart={restart.has(row.app) && row.state === 'connected' && row.agent === open}
                running={
                  openRow?.running === true &&
                  connectedHere.length === 1 &&
                  connectedHere[0]?.app === row.app
                }
                primary={i === firstPrimary}
                onReview={() => setPanel({ kind: 'change', app: row })}
                onManual={() => setPanel({ kind: 'manual', app: row, entry: undefined })}
                onRecheck={() => {
                  setNotice(undefined);
                  read();
                }}
              />
            ))}
          </ul>
          <p className="al-text-body-sm">
            <button
              type="button"
              className="ap-link"
              onClick={() => setPanel({ kind: 'manual', app: undefined, entry: undefined })}
            >
              {S.notListed}
            </button>
          </p>
        </>
      )}
      {panel?.kind === 'change' && open !== null ? (
        <ChangePanel
          app={panel.app}
          labels={labels}
          api={appsApi}
          owner={ownerClient}
          onClose={closePanel}
          onDone={done}
          onManual={(entry) => setPanel({ kind: 'manual', app: panel.app, entry })}
          onAgentChanged={agentChanged}
        />
      ) : null}
      {panel?.kind === 'manual' ? (
        <ManualPanel
          app={panel.app}
          folder={open ?? 'default'}
          entry={panel.entry}
          onClose={closePanel}
        />
      ) : null}
    </main>
  );
}
