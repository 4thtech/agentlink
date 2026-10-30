// W4-SHELL-V2 (W4 UX v2 Layer 2 "Agent dropdown, kept, made live"; prototype v23 A4): the agent chip
// at the top left and its live dropdown. The chip shows the open agent's letter icon with a live dot,
// its name and one plain status ("Ready in Claude Code"; a connection that is not up wins: one truthful
// status, HOTFIX-045). The dropdown, "Your agents · live": per agent its letter icon and dot, its
// status and, per AI app, a dot and a word (Working / Ready / Not running / Not set up / Paused); then
// "Another AI app", the detected AI apps that serve no agent, each with Connect (kept from #715); then
// Add agent and Manage agents. It follows the shared live store (api/live.ts), so it updates by
// itself (W4-SHELL-LIVE: over the events stream, so quitting or starting an AI app shows within
// seconds; per AI app Working with the U0 pulse / Ready / Idle / Not running · last seen / Not set up
// in the words of 08 §1). Switching needs no Touch ID (it only changes what you look at) and never
// reloads the page.
// Labels and app names are text only (I-5).
import { AgentIcon, Pulse, type AgentDotState, type LiveDotState } from '@4thtech-io/ui';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import {
  getLive,
  subscribeLive,
  switchAgent,
  type LiveAgent,
  type LiveState,
} from '../api/live.js';
import { AGENTS_PATH, NEW_AGENT_PATH } from '../nav.js';
import { navigate } from '../router.js';
import type { AgentsApi } from '../pages/agents/api.js';
import { AGENTS_STRINGS as A } from '../pages/agents/strings.js';
import { createAppsApi, type AppsApi } from '../pages/apps/api.js';
import { APPS_PAGE_PATH } from '../pages/apps/data.js';
import { ShellIcon } from './shell-icons.js';
import { ShellMenu } from './shell-menu.js';
import { VT_CLASS } from '@4thtech-io/ui';

/** The top bar's one status for the connection (HOTFIX-045), when it is not up. */
export interface SwitcherChip {
  readonly state: LiveDotState;
  readonly label?: string;
}

export const CHIP_STRINGS = {
  menu: 'Your agents · live',
  menuName: 'Agents',
  anotherApp: 'Another AI app',
  connect: 'Connect',
  connectApp: (app: string): string => `Connect ${app}`,
  addAgent: 'Add agent',
  manageAgents: 'Manage agents',
  chipPrefix: 'Agent: ',
  openApp: 'Open the AgentLink app to see your agents.',
} as const;

const DOT: Readonly<Record<LiveState, AgentDotState>> = {
  working: 'working',
  ready: 'ready',
  idle: 'idle',
  off: 'off',
  none: 'none',
  paused: 'paused',
  removing: 'off',
};

/** The words of a connection that is not up (the chip says it instead of the agent's status). */
function connectionWord(chip: SwitcherChip | undefined): string | undefined {
  if (chip === undefined || chip.state === 'connected' || chip.state === 'checking') {
    return undefined;
  }
  if (chip.label !== undefined) return chip.label;
  if (chip.state === 'paused') return 'Paused';
  if (chip.state === 'needs-setup') return 'Needs setup';
  return 'Not running';
}

function useLive(api: AgentsApi | undefined): ReturnType<typeof getLive> {
  return useSyncExternalStore(
    useCallback((on) => subscribeLive(on, api === undefined ? undefined : { api }), [api]),
    getLive,
    getLive,
  );
}

/** The detected AI apps that serve no agent yet ("Another AI app"). */
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

/** A live dot; Working pulses (the U0 Pulse: a still dot with reduced motion). */
export function LiveDot({ state }: { readonly state: LiveState }): ReactElement {
  if (state === 'working') return <Pulse tone="success" className="al-ldot-pulse" />;
  return <span className={`al-ldot is-${state}`} aria-hidden="true" />;
}

function AppLine({ app }: { app: LiveAgent['apps'][number] }): ReactElement {
  return (
    <span className="al-am-app">
      <LiveDot state={app.state} />
      <span className="al-am-app-name">{app.app}</span>
      <span className={`al-am-app-word is-${app.state}`}>{app.word}</span>
    </span>
  );
}

export interface AgentSwitcherProps {
  readonly api?: AgentsApi;
  /** The AI apps read, for "Another AI app" (default: GET /api/ui/apps). */
  readonly appsApi?: AppsApi;
  /** The connection; when it is not up the chip says that instead of the agent's status. */
  readonly chip?: SwitcherChip;
}

export function AgentSwitcher({ api, appsApi, chip }: AgentSwitcherProps): ReactElement {
  const live = useLive(api);
  const free = useFreeApps(appsApi);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback((restore: boolean): void => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }, []);

  const list = live.list;
  const agents = live.agents;
  const current = agents.find((a) => a.current);
  const label = current?.label ?? list?.label ?? A.switcherLabel;
  const seed = current?.name ?? label;
  const down = connectionWord(chip);
  const status = down ?? current?.statusText ?? (list === undefined ? '' : A.notRunning);
  const dot: AgentDotState | undefined =
    down !== undefined ? 'off' : current === undefined ? undefined : DOT[current.state];

  if (list !== undefined && !list.switchable) {
    return (
      <div className="al-chip-wrap">
        <span className="al-chip is-static al-text-body-sm al-muted">{CHIP_STRINGS.openApp}</span>
      </div>
    );
  }

  const go = (to: string): void => {
    close(false);
    navigate(to);
  };
  const choose = (agent: LiveAgent): void => {
    close(false);
    if (agent.current || agent.removing) return;
    void switchAgent(agent.name);
  };

  return (
    <div className="al-chip-wrap">
      <button
        ref={trigger}
        type="button"
        className={`al-chip al-press ${VT_CLASS.chip}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) free.reread();
          setOpen((v) => !v);
        }}
      >
        <AgentIcon label={label} seed={seed} size="lg" {...(dot === undefined ? {} : { dot })} />
        <span className="al-chip-text">
          {/* The name is the visible text (WCAG 2.5.3), after a word for screen readers. */}
          <span className="al-sr-only">{CHIP_STRINGS.chipPrefix}</span>
          <span className="al-chip-name">{label}</span>{' '}
          <span className="al-chip-status">{status}</span>
        </span>
        <ShellIcon
          name="chev-d"
          size={16}
          className={open ? 'al-chip-chev is-open' : 'al-chip-chev'}
        />
      </button>
      {open ? (
        <ShellMenu
          label={CHIP_STRINGS.menuName}
          onClose={close}
          triggerRef={trigger}
          className="al-shell-menu al-agent-menu al-menu"
        >
          <span className="al-menu-head" role="presentation">
            {CHIP_STRINGS.menu}
          </span>
          {agents.map((agent) => (
            <div key={agent.name} className="al-am-row">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={agent.current}
                {...(agent.apps.length > 0
                  ? { 'aria-describedby': `${menuId}-${agent.name}` }
                  : {})}
                className="al-mitem al-am-item"
                aria-disabled={agent.removing ? 'true' : undefined}
                onClick={() => choose(agent)}
              >
                <AgentIcon label={agent.label} seed={agent.name} size="lg" dot={DOT[agent.state]} />
                <span className="al-am-main">
                  <span className="al-am-name">{agent.label}</span>
                  <span className="al-am-status">{agent.statusText}</span>
                </span>
                {agent.current ? (
                  <ShellIcon name="check" size={16} className="al-am-check" />
                ) : null}
              </button>
              {agent.apps.length > 0 ? (
                <span id={`${menuId}-${agent.name}`} className="al-am-apps">
                  {agent.apps.map((app) => (
                    <AppLine key={app.app} app={app} />
                  ))}
                </span>
              ) : null}
            </div>
          ))}
          {free.names.length > 0 ? (
            <>
              <div className="al-menu-sep" role="separator" />
              <span className="al-menu-head" role="presentation">
                {CHIP_STRINGS.anotherApp}
              </span>
              {free.names.map((a) => (
                <div key={a.app} className="al-am-free" data-free-app={a.app}>
                  <span className="al-am-app">
                    <span className="al-ldot is-none" aria-hidden="true" />
                    <span className="al-am-app-name">{a.name}</span>
                  </span>
                  <button
                    type="button"
                    role="menuitem"
                    className="al-mitem al-am-connect"
                    aria-label={CHIP_STRINGS.connectApp(a.name)}
                    onClick={() => go(APPS_PAGE_PATH)}
                  >
                    {CHIP_STRINGS.connect}
                  </button>
                </div>
              ))}
            </>
          ) : null}
          <div className="al-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="al-mitem"
            onClick={() => go(NEW_AGENT_PATH)}
          >
            <ShellIcon name="plus" size={16} />
            {CHIP_STRINGS.addAgent}
          </button>
          <button
            type="button"
            role="menuitem"
            className="al-mitem"
            onClick={() => go(AGENTS_PATH)}
          >
            <ShellIcon name="settings" size={16} />
            {CHIP_STRINGS.manageAgents}
          </button>
        </ShellMenu>
      ) : null}
    </div>
  );
}
