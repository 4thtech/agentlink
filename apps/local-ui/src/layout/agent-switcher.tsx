// U3-h: the top-bar agent switcher (b11 §29.1). The open agent's label, a live dot and the AI app it
// works from; a menu of the other agents (each with its AI apps), Add agent and Manage agents.
// Switching needs no Touch ID (it only changes what you look at): one POST, then every page reloads
// for that agent. Labels are text only (I-5). At 360 the trigger is the agent's initial in a circle.
import { Icon, LiveDot, TextField } from '@4thtech-io/ui';
import { createPortal } from 'react-dom';
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import { navigate } from '../router.js';
import { AppMark } from '../pages/agents/app-mark.js';
import type { AgentsApi } from '../pages/agents/api.js';
import {
  AGENTS_APPS_PATH,
  AGENTS_PATH,
  appsText,
  orderAgents,
  shortLabel,
  stateWord,
  type AgentRow,
} from '../pages/agents/data.js';
import { Menu } from '../pages/agents/menu.js';
import { AGENTS_STRINGS as S } from '../pages/agents/strings.js';
import { listOf, useAgents } from '../pages/agents/use-agents.js';
import '../pages/agents/agents.css';

const MANY = 8;

export interface AgentSwitcherProps {
  readonly api?: AgentsApi;
  /** Reloads every page after a switch (default: the browser reload). */
  readonly reload?: () => void;
}

const defaultReload = (): void => window.location.reload();
const initialOf = (label: string): string => ([...label.trim()][0] ?? '?').toUpperCase();

function Dot({ row }: { row: AgentRow }): ReactElement {
  return <LiveDot state={row.running ? 'connected' : 'not-running'} label={stateWord(row)} />;
}

export function AgentSwitcher({
  api,
  reload = defaultReload,
}: AgentSwitcherProps): ReactElement | null {
  const { state, reload: reread, switchTo } = useAgents(api, reload);
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

  if (list === undefined) {
    if (state.kind !== 'error') return null;
    return (
      <span className="ag-switch-note al-text-body-sm">
        {S.loadError}{' '}
        <button type="button" className="ag-link" onClick={reread}>
          {S.tryAgain}
        </button>
      </span>
    );
  }
  if (!list.switchable) {
    return (
      <span className="ag-switch-note al-text-body-sm al-muted" title={S.openApp}>
        {S.openApp}
      </span>
    );
  }

  const shownRows =
    query.trim() === ''
      ? rows
      : rows.filter((r) => {
          const q = query.trim().toLowerCase();
          return (
            r.label.toLowerCase().includes(q) || r.apps.some((a) => a.toLowerCase().includes(q))
          );
        });

  const label = current?.label ?? list.label ?? S.switcherLabel;
  const apps = current === undefined ? S.notConnected : appsText(current);
  const word = current === undefined ? S.notRunning : stateWord(current);
  const many = usable.length > MANY;
  // At 600 px and under the menu is a bottom sheet: outside the top bar, whose blur would make it
  // position against the bar instead of the screen.
  const place = (menu: ReactElement): ReactElement =>
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 600px)').matches
      ? createPortal(menu, document.body)
      : menu;

  const choose = (row: AgentRow): void => {
    close(false);
    if (row.current || row.removing) return;
    void switchTo(row.name);
  };

  return (
    <div className="ag-switch">
      <button
        ref={trigger}
        type="button"
        className="ag-switch-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={S.switcherName(label, apps, word)}
        title={label}
        onClick={() => {
          if (!open) reread();
          setOpen((v) => !v);
        }}
      >
        <span className="ag-initial" aria-hidden="true">
          {initialOf(label)}
        </span>
        <span className="ag-switch-label al-text-label">{shortLabel(label)}</span>
        {usable.length > 1 ? <Icon name="chevron-down" size={14} /> : null}
        {current === undefined ? null : <Dot row={current} />}
        <span className="ag-switch-app">
          {current !== undefined && current.apps.length > 0 ? (
            <AppMark name={appsText(current)} />
          ) : (
            <span className="al-text-body-sm al-muted">{S.noAiApp}</span>
          )}
        </span>
      </button>
      {open
        ? place(
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
                      onClick={() => {
                        close(false);
                        navigate(`${AGENTS_APPS_PATH}?agent=${encodeURIComponent(row.name)}`);
                      }}
                    >
                      {S.connect}
                    </button>
                  ) : null}
                </div>
              ))}
              <div className="ag-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="ag-menu-item"
                onClick={() => {
                  close(false);
                  navigate(`${AGENTS_PATH}?add=1`);
                }}
              >
                <Icon name="plus" size={14} />
                <span>{S.add}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="ag-menu-item"
                onClick={() => {
                  close(false);
                  navigate(AGENTS_PATH);
                }}
              >
                {S.manage}
              </button>
            </Menu>,
          )
        : null}
    </div>
  );
}
