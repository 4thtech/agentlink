// U3-h: the agent switcher (b11 §29.1). W4-SHELL (Decision 40, Decision 44 B1; b11 §34.2): it sits
// top-left, first in the sidebar under the mark (at 360, where the sidebar is the bottom bar, at the
// start of the top bar). The trigger shows the open agent's letter icon, its label, one merged
// status and the AI app it works from. The menu keeps the dropdown the owner likes: per agent the
// letter icon, the label, one status and its AI apps by name; then "Not connected yet", the detected
// AI apps that serve no agent, each with Connect; then "New agent" and "Manage agents & apps".
// Switching needs no Touch ID (it only changes what you look at): one POST, and every view follows
// the agent that is open now without a reload (api/generation.ts, router.tsx). Labels and app names
// are text only (I-5).
import { AgentIcon, Icon, LiveDot, TextField, type LiveDotState } from '@4thtech-io/ui';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { navigate } from '../router.js';
import { AppMark } from '../pages/agents/app-mark.js';
import type { AgentsApi } from '../pages/agents/api.js';
import {
  AGENTS_APPS_PATH,
  AGENTS_PATH,
  orderAgents,
  shortLabel,
  stateWord,
  type AgentRow,
} from '../pages/agents/data.js';
import { Menu } from '../pages/agents/menu.js';
import { AGENTS_STRINGS as S } from '../pages/agents/strings.js';
import { listOf, useAgents } from '../pages/agents/use-agents.js';
import { createAppsApi, type AppsApi } from '../pages/apps/api.js';
import { APPS_PAGE_PATH } from '../pages/apps/data.js';
import '../pages/agents/agents.css';

const MANY = 8;

/** The top bar's one status (HOTFIX-045): the app's connection, merged with the open agent's. */
export interface SwitcherChip {
  readonly state: LiveDotState;
  readonly label?: string;
}

export interface AgentSwitcherProps {
  readonly api?: AgentsApi;
  /** The AI apps read, for "Not connected yet" (default: GET /api/ui/apps). */
  readonly appsApi?: AppsApi;
  /** The connection chip. The switcher shows exactly one chip: this one, or "Not running" for the open agent. */
  readonly chip?: SwitcherChip;
  /** Runs after a switch the server took (default: nothing; the views follow without a reload). */
  readonly reload?: () => void;
  /** Where it sits: the sidebar (wide screens) or the top bar (360). */
  readonly place?: 'side' | 'bar';
}

function Dot({ row }: { row: AgentRow }): ReactElement {
  return <LiveDot state={row.running ? 'connected' : 'not-running'} label={stateWord(row)} />;
}

function Chip({ chip }: { chip: SwitcherChip | undefined }): ReactElement | null {
  if (chip === undefined) return null;
  return (
    <LiveDot state={chip.state} {...(chip.label === undefined ? {} : { label: chip.label })} />
  );
}

/** One truthful state: a connection that is not up wins; otherwise the open agent's own. */
function merged(
  chip: SwitcherChip | undefined,
  row: AgentRow | undefined,
): SwitcherChip | undefined {
  if (chip === undefined)
    return row === undefined
      ? undefined
      : { state: row.running ? 'connected' : 'not-running', label: stateWord(row) };
  if (chip.state !== 'connected' || row === undefined || row.running) return chip;
  return { state: 'not-running', label: stateWord(row) };
}

/** The detected AI apps that serve no agent yet (b11 §34.2 "Not connected yet"). */
function useFreeApps(appsApi: AppsApi | undefined): {
  readonly names: readonly { readonly app: string; readonly name: string }[];
  readonly reread: () => void;
} {
  const [client] = useState<AppsApi>(() => appsApi ?? createAppsApi());
  const [names, setNames] = useState<readonly { app: string; name: string }[]>([]);
  const live = useRef(true);
  const reread = useCallback(() => {
    void client.list().then((result) => {
      if (!live.current || result.kind !== 'ok') return;
      setNames(
        result.list.apps
          .filter((a) => a.state === 'not_connected' && a.agent === undefined)
          .map((a) => ({ app: a.app, name: a.name })),
      );
    });
  }, [client]);
  useEffect(() => {
    live.current = true;
    reread();
    return () => {
      live.current = false;
    };
  }, [reread]);
  return { names, reread };
}

export function AgentSwitcher({
  api,
  appsApi,
  chip,
  reload,
  place = 'side',
}: AgentSwitcherProps): ReactElement | null {
  const { state, reload: reread, switchTo } = useAgents(api, reload);
  const free = useFreeApps(appsApi);
  const list = listOf(state);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback((restore: boolean): void => {
    setOpen(false);
    setQuery('');
    if (restore) trigger.current?.focus();
  }, []);

  const rows = useMemo(() => orderAgents(list?.agents ?? []), [list]);
  const usable = rows.filter((r) => !r.removing);
  const current = rows.find((r) => r.current);
  const cls = `ag-switch is-${place}`;

  if (list === undefined) {
    if (state.kind !== 'error')
      return (
        <div className={cls}>
          <Chip chip={chip} />
        </div>
      );
    return (
      <div className={cls}>
        <span className="ag-switch-note al-text-body-sm">
          {S.loadError}{' '}
          <button type="button" className="ag-link" onClick={reread}>
            {S.tryAgain}
          </button>
        </span>
        <Chip chip={chip} />
      </div>
    );
  }
  if (!list.switchable) {
    return (
      <div className={cls}>
        <span className="ag-switch-note al-text-body-sm al-muted" title={S.openApp}>
          {S.openApp}
        </span>
        <Chip chip={chip} />
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const shownRows =
    q === ''
      ? rows
      : rows.filter(
          (r) =>
            r.label.toLowerCase().includes(q) || r.apps.some((a) => a.toLowerCase().includes(q)),
        );

  const label = current?.label ?? list.label ?? S.switcherLabel;
  const seed = current?.name ?? label;
  const apps = current === undefined ? S.notConnected : (current.apps[0] ?? S.notConnected);
  const one = merged(chip, current);
  const word = one?.label ?? (current === undefined ? S.notRunning : stateWord(current));
  const many = usable.length > MANY;
  // At 600 px and under the menu is a bottom sheet: outside the top bar, whose blur would make it
  // position against the bar instead of the screen.
  const sheet = (menu: ReactElement): ReactElement =>
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 600px)').matches
      ? createPortal(menu, document.body)
      : menu;

  const choose = (row: AgentRow): void => {
    close(false);
    if (row.current || row.removing) return;
    void switchTo(row.name);
  };
  const go = (to: string): void => {
    close(false);
    navigate(to);
  };

  return (
    <div className={cls}>
      <button
        ref={trigger}
        type="button"
        className="ag-switch-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={S.switcherName(label, apps, word)}
        title={label}
        onClick={() => {
          if (!open) {
            reread();
            free.reread();
          }
          setOpen((v) => !v);
        }}
      >
        <AgentIcon label={label} seed={seed} size={place === 'bar' ? 'lg' : 'md'} />
        <span className="ag-switch-body">
          <span className="ag-switch-top">
            <span className="ag-switch-label al-text-label">{shortLabel(label)}</span>
            {usable.length > 1 ? <Icon name="chevron-down" size={14} /> : null}
          </span>
          <span className="ag-switch-sub">
            <Chip chip={one} />
            <span className="ag-switch-app">
              {current !== undefined && current.apps.length > 0 ? (
                <AppMark name={current.apps[0] ?? ''} />
              ) : (
                <span className="al-text-body-sm al-muted">{S.noAiApp}</span>
              )}
            </span>
          </span>
        </span>
      </button>
      {open
        ? sheet(
            <Menu
              label={S.switcherLabel}
              onClose={close}
              triggerRef={trigger}
              className="ag-switch-menu"
            >
              {many ? (
                <div className="ag-switch-find">
                  <TextField
                    label={S.findAgent}
                    name="find-agent"
                    type="search"
                    autoComplete="off"
                    value={query}
                    onChange={(e) => setQuery(e.currentTarget.value)}
                  />
                </div>
              ) : null}
              {shownRows.map((row) => (
                <div
                  key={row.name}
                  className={row.removing ? 'ag-menu-row is-removing' : 'ag-menu-row'}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="ag-menu-item"
                    aria-disabled={row.removing ? 'true' : undefined}
                    aria-current={row.current ? 'true' : undefined}
                    onClick={() => choose(row)}
                  >
                    <span className="ag-menu-check" aria-hidden="true">
                      {row.current ? <Icon name="check" size={14} /> : null}
                    </span>
                    <AgentIcon label={row.label} seed={row.name} />
                    <span className="ag-menu-main">
                      <span className="ag-menu-top">
                        <span className="al-text-body ag-label">{row.label}</span>
                        {row.removing ? (
                          <span className="ag-warn al-text-label">
                            <Icon name="triangle-alert" size={12} />
                            {S.removalNotFinished}
                          </span>
                        ) : (
                          <Dot row={row} />
                        )}
                      </span>
                      {row.removing ? null : row.apps.length > 0 ? (
                        <span className="ag-menu-apps">
                          {row.apps.map((a) => (
                            <AppMark key={a} name={a} />
                          ))}
                        </span>
                      ) : (
                        <span className="al-text-body-sm al-muted">{S.notConnected}</span>
                      )}
                    </span>
                  </button>
                  {!row.removing && row.apps.length === 0 ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="ag-menu-item ag-menu-connect"
                      onClick={() =>
                        go(`${AGENTS_APPS_PATH}?agent=${encodeURIComponent(row.name)}`)
                      }
                    >
                      {S.connect}
                    </button>
                  ) : null}
                </div>
              ))}
              {free.names.length > 0 && q === '' ? (
                <>
                  <div className="ag-menu-sep" role="separator" />
                  <div className="ag-menu-group al-text-label al-muted" role="presentation">
                    {S.notConnectedYet}
                  </div>
                  {free.names.map((a) => (
                    <div key={a.app} className="ag-menu-row ag-menu-free" data-free-app={a.app}>
                      <span className="ag-menu-free-app">
                        <AppMark name={a.name} />
                      </span>
                      <button
                        type="button"
                        role="menuitem"
                        className="ag-menu-item ag-menu-connect"
                        aria-label={S.connectFreeApp(a.name)}
                        onClick={() => go(APPS_PAGE_PATH)}
                      >
                        {S.connect}
                      </button>
                    </div>
                  ))}
                </>
              ) : null}
              <div className="ag-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="ag-menu-item"
                onClick={() => go(`${AGENTS_PATH}?add=1`)}
              >
                <Icon name="plus" size={14} />
                <span>{S.newAgent}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="ag-menu-item"
                onClick={() => go(AGENTS_PATH)}
              >
                {S.manageAgentsApps}
              </button>
            </Menu>,
          )
        : null}
    </div>
  );
}
