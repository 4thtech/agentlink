// U3-h: the Agents page (b11 §29.2). Every agent of this owner with the AI apps it works from, its
// contacts, and Switch, Rename, Connect and Remove. A List and Map control (the Map is plugged in by
// card U3-map through `setAgentsMapView`); the map is only a view of the list, actions live here.
// Labels are rendered as text only (I-5). Nothing here signs: owner actions go to the server behind
// the presence gate (sheets.tsx).
import { Button, EmptyState, Icon, LiveDot, Segmented, Skeleton, Surface } from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
} from 'react';
import { navigate } from '../../router.js';
import { createOwnerClient, type OwnerClient } from '../contacts/owner.js';
import { AppMark } from './app-mark.js';
import { createAgentsApi, type AgentsApi } from './api.js';
import { AGENTS_APPS_PATH, orderAgents, stateWord, tidyCandidates, type AgentRow } from './data.js';
import { Menu } from './menu.js';
import { AddSheet, RemoveSheet, RenameEditor } from './sheets.js';
import { AGENTS_STRINGS as S } from './strings.js';
import { announceAgentsChanged, listOf, useAgents } from './use-agents.js';
import { markAgentsOpened } from './tidy.js';
import './agents.css';

/** The Map view (card U3-map). It is given the same rows as the list and renders them its own way. */
export type AgentsMapView = ComponentType<{ readonly agents: readonly AgentRow[] }>;
let mapView: AgentsMapView | undefined;
export function setAgentsMapView(view: AgentsMapView | undefined): void {
  mapView = view;
}

export interface AgentsPageProps {
  readonly api?: AgentsApi;
  readonly owner?: OwnerClient;
  /** Reloads every page after a switch (default: the browser reload). */
  readonly reload?: () => void;
}

const defaultReload = (): void => window.location.reload();
const connectHref = (name: string): string =>
  `${AGENTS_APPS_PATH}?agent=${encodeURIComponent(name)}`;

function AppsLine({ row }: { row: AgentRow }): ReactElement {
  if (row.apps.length === 0) {
    return (
      <p className="ag-works al-text-body-sm al-muted">
        <Icon name="circle" size={12} />
        <span>{S.notConnected}</span>
      </p>
    );
  }
  return (
    <p className="ag-works al-text-body-sm">
      <span className="al-muted">{S.worksFrom}</span>
      {row.apps.map((app) => (
        <AppMark key={app} name={app} />
      ))}
    </p>
  );
}

function RowMenu({
  row,
  onRemove,
}: {
  row: AgentRow;
  onRemove: (row: AgentRow) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback((restore: boolean): void => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }, []);
  return (
    <span className="ag-menu-wrap">
      <button
        ref={trigger}
        type="button"
        className="al-btn al-btn-ghost al-btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="ellipsis" size={16} />
        <span className="ag-sr">{S.more}</span>
      </button>
      {open ? (
        <Menu label={S.more} onClose={close} triggerRef={trigger}>
          <button
            type="button"
            role="menuitem"
            className="ag-menu-item ag-danger"
            onClick={() => {
              close(false);
              onRemove(row);
            }}
          >
            {S.remove}
          </button>
        </Menu>
      ) : null}
    </span>
  );
}

function Row({
  row,
  tidy,
  renaming,
  rename,
  onRenameStart,
  onRenameEnd,
  onSwitch,
  onRemove,
}: {
  row: AgentRow;
  tidy: boolean;
  renaming: boolean;
  rename: (done: () => void, cancel: () => void) => ReactElement;
  onRenameStart: () => void;
  onRenameEnd: () => void;
  onSwitch: (row: AgentRow) => void;
  onRemove: (row: AgentRow) => void;
}): ReactElement {
  if (row.removing) {
    return (
      <li className="ag-row ag-row-removing" data-agent={row.name}>
        <div className="ag-row-head">
          <span className="al-text-title-3 ag-label">{row.label}</span>
          <span className="ag-warn al-text-label">
            <Icon name="triangle-alert" size={14} />
            {S.removalNotFinished}
          </span>
        </div>
        <p className="al-text-body-sm al-muted">{S.removalReason}</p>
        <div className="ag-actions">
          <Button variant="secondary" onClick={() => onRemove(row)}>
            {S.tryAgain}
          </Button>
        </div>
      </li>
    );
  }
  const none = row.apps.length === 0;
  return (
    <li className="ag-row" data-agent={row.name}>
      <div className="ag-row-head">
        <span className="al-text-title-3 ag-label">{row.label}</span>
        {row.current ? <span className="ag-open al-text-label">{S.open}</span> : null}
        <LiveDot state={row.running ? 'connected' : 'not-running'} label={stateWord(row)} />
      </div>
      <AppsLine row={row} />
      <p className="al-text-body-sm al-muted">
        {S.contactsCount(row.contacts)}
        {tidy ? ` · ${S.noAppNoContacts}` : ''}
      </p>
      {renaming ? (
        rename(onRenameEnd, onRenameEnd)
      ) : (
        <div className="ag-actions">
          {row.current ? null : (
            <Button variant="secondary" onClick={() => onSwitch(row)}>
              {S.switch}
            </Button>
          )}
          <Button variant="ghost" onClick={onRenameStart}>
            {S.rename}
          </Button>
          <Button
            variant={none ? 'primary' : 'ghost'}
            onClick={() => navigate(connectHref(row.name))}
          >
            {none ? S.connectApp : S.connect}
          </Button>
          <RowMenu row={row} onRemove={onRemove} />
        </div>
      )}
    </li>
  );
}

export function AgentsPage({
  api: givenApi,
  owner: givenOwner,
  reload = defaultReload,
}: AgentsPageProps = {}): ReactElement {
  const api = useMemo(() => givenApi ?? createAgentsApi(), [givenApi]);
  const owner = useMemo(() => givenOwner ?? createOwnerClient(), [givenOwner]);
  const { state, reload: reread, switchTo } = useAgents(api, reload);
  const list = listOf(state);
  const [view, setView] = useState<'list' | 'map'>('list');
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(
    () => new URLSearchParams(location.search).get('add') === '1',
  );
  const [removing, setRemoving] = useState<AgentRow | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    markAgentsOpened();
  }, []);

  const rows = useMemo(() => orderAgents(list?.agents ?? []), [list]);
  const tidy = useMemo(() => new Set(tidyCandidates(rows).map((r) => r.name)), [rows]);
  const generation = list?.generation;

  const doSwitch = (row: AgentRow): void => {
    setNotice(undefined);
    void switchTo(row.name).then((outcome) => {
      if (outcome.kind === 'agent_changed') setNotice(S.agentChanged);
    });
  };
  const changed = (): void => {
    announceAgentsChanged();
  };
  const MapView = mapView;

  return (
    <main className="ag-page">
      <div className="ag-head">
        <h1 className="al-text-h1">{S.title}</h1>
        <div className="ag-head-tools">
          <Segmented
            label={S.viewLabel}
            variant="tabs"
            idPrefix="ag-view"
            panelId="ag-panel"
            value={view}
            onChange={(v) => setView(v === 'map' ? 'map' : 'list')}
            options={[
              { value: 'list', label: S.list },
              { value: 'map', label: S.map },
            ]}
          />
          {list?.switchable === false ? null : (
            <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
              {S.add}
            </Button>
          )}
        </div>
      </div>

      <div className="ag-live" role="status" aria-live="polite">
        {notice}
      </div>

      <div id="ag-panel" role="tabpanel" aria-labelledby={`ag-view-tab-${view}`}>
        {view === 'map' ? (
          MapView === undefined ? (
            <p className="al-text-body al-muted">{S.mapSoon}</p>
          ) : (
            <MapView agents={rows} />
          )
        ) : state.kind === 'loading' && list === undefined ? (
          <Skeleton loading lines={3}>
            <span />
          </Skeleton>
        ) : state.kind === 'error' && list === undefined ? (
          <Surface as="section" level={1} className="ag-error-box">
            <p className="al-text-body" role="alert">
              {S.loadError}
            </p>
            <Button variant="secondary" onClick={reread}>
              {S.tryAgain}
            </Button>
          </Surface>
        ) : list !== undefined && rows.length === 0 ? (
          <EmptyState
            title={S.empty}
            action={
              <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
                {S.add}
              </Button>
            }
          />
        ) : (
          <>
            {state.kind === 'error' ? (
              <p className="al-text-body-sm" role="alert">
                {S.loadError}{' '}
                <button type="button" className="ag-link" onClick={reread}>
                  {S.tryAgain}
                </button>
              </p>
            ) : null}
            <ul className="ag-list">
              {rows.map((row) => (
                <Row
                  key={row.name}
                  row={row}
                  tidy={tidy.has(row.name)}
                  renaming={renaming === row.name}
                  onRenameStart={() => setRenaming(row.name)}
                  onRenameEnd={() => setRenaming(undefined)}
                  rename={(done, cancel) =>
                    generation === undefined ? (
                      <span />
                    ) : (
                      <RenameEditor
                        row={row}
                        api={api}
                        owner={owner}
                        onDone={done}
                        onCancel={cancel}
                        onChanged={changed}
                      />
                    )
                  }
                  onSwitch={doSwitch}
                  onRemove={setRemoving}
                />
              ))}
            </ul>
          </>
        )}
      </div>

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
          row={removing}
          api={api}
          owner={owner}
          onClose={() => {
            setRemoving(undefined);
            reread();
          }}
          onChanged={changed}
          onRemoved={(label) => {
            setRemoving(undefined);
            setNotice(S.removed(label));
          }}
          onAgentChanged={() => {
            setRemoving(undefined);
            setNotice(S.agentChanged);
            reread();
          }}
        />
      ) : null}
    </main>
  );
}
