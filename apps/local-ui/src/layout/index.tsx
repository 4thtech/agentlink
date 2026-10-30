// W4-SHELL-V2 (Decisions 49–51; W4 UX v2 "three layers"; prototype v23 A4/A8/A9/A10/A11): the shared
// frame. One top bar across the window (the mark, the agent chip with its live dropdown, Go to, the
// "?" Help menu and the Under the hood switch); under it, while Under the hood is on, the live status
// strip; then the section menu (a minimized rail, or a sheet on a phone) beside the page; the status
// bar at the bottom (the connection in words, the version). Same routes in both layers: turning
// Under the hood on or off morphs the same screen in place (a View Transition, U0), never another
// route tree. Get started (`/start/<step>`) and the join screen are a focused column with no chrome.
// Shortcuts: Cmd+K (Go to), Cmd+Shift+U (Under the hood), Cmd+/ (shortcuts); Ctrl elsewhere.
import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { getLive } from '../api/live.js';
import { SETTINGS_PAGES, sectionOf } from '../nav.js';
import {
  PrefsHood,
  getPrefs,
  setMenuExpanded,
  settleUiSettings,
  startUiSettings,
  useMenuExpanded,
  useUiSettingsSettled,
  usePrefs,
} from '../prefs/index.js';
import { SHELL_STRINGS } from '../strings.js';
import { GoTo } from './go-to.js';
import { TopBar, shortcutKeys } from './top-bar.js';
import { useApprovalsWaiting } from '../pages/approvals/badge.js';
import { detectPlatform, passkeysAvailable } from '../pages/first-run/passkey.js';
import {
  createUpgradeApi,
  PASSKEY_REGISTERED_EVENT,
  passkeyRegisteredHere,
} from '../pages/first-run/setup-api.js';
import type { Platform } from '../pages/first-run/strings.js';
import { StartHereContext } from '../pages/home/start-here-context.js';
import type { StartHereReads } from '../pages/home/start-here.js';
import { useStartHere } from '../pages/home/use-start-here.js';
import { SwitchToPasskeyBanner } from '../states/index.js';
import type { ApiResult } from '../api/client.js';
import { TidyNote } from '../pages/agents/tidy-note.js';
import { subscribeHealth } from './health-feed.js';
import { readHealth as defaultReadHealth, type HealthState } from './health.js';
import { VT_CLASS } from '@4thtech-io/ui';
import { morph, toggleHood } from './hood.js';
import { SectionRail, SectionSheet } from './section-menu.js';
import { ShellDialogs, openShellDialog } from './shell-dialogs.js';
import { StatusStrip } from './status-strip.js';
import './shell.css';

/**
 * What the status bar shows. "Connected" appears only when the local server's health read says the
 * agent is running (M1-11s-a-d, health.ts); until the first answer the state is "unknown" (shown as
 * "Checking…", at most 4 s). The browser's offline event shows "Not connected" and wins over the
 * health read while the browser stays offline; the online event goes back to "unknown", never
 * straight to "connected": the next health read decides.
 */
export type ConnectionState = 'unknown' | 'offline' | HealthState;

let current: ConnectionState = 'unknown';
const listeners = new Set<() => void>();

/** Record the connection state (called by whatever learns it: the server health read). */
export function setConnectionState(next: ConnectionState): void {
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

export function useConnectionState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(current);
  useEffect(() => {
    const sync = (): void => setState(current);
    const onOffline = (): void => setConnectionState('offline');
    const onOnline = (): void => {
      if (current === 'offline') setConnectionState('unknown');
    };
    listeners.add(sync);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    sync();
    return () => {
      listeners.delete(sync);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);
  return state;
}

const browserOffline = (): boolean =>
  typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * M1-11s-a-d: polls the health read while mounted and records the state; returns the app version
 * it reported (a plain version, or undefined).
 */
export function useHealth(
  read: () => Promise<ApiResult<unknown>> = defaultReadHealth,
): string | undefined {
  const [version, setVersion] = useState<string | undefined>(undefined);
  useEffect(() => {
    // A fresh poller starts from "Checking…": an earlier answer is not evidence for this one.
    if (current !== 'offline') setConnectionState('unknown');
    // The poller is shared with Home (health-feed.ts): one read per tick for the whole app.
    return subscribeHealth(read, {
      onState: (state, reported) => {
        // The browser's own offline signal wins while it lasts.
        if (!browserOffline()) setConnectionState(state);
        setVersion(reported);
      },
    });
  }, [read]);
  return version;
}

/** The status bar's words; "Paused" means the user paused AgentLink, never an unknown state. */
const STATUS: Readonly<Record<ConnectionState, readonly [cls: string, word: string]>> = {
  unknown: ['checking', 'Checking…'],
  connected: ['connected', 'Connected'],
  offline: ['disconnected', 'Not connected'],
  paused: ['paused', 'Paused'],
  not_running: ['not-running', 'Not running'],
  needs_setup: ['needs-setup', 'Needs setup'],
};

/**
 * M1-UX-FIRSTRUN-V2-c: true when the owner exists but approves only with the backup code (no
 * passkey) and this browser can make one. Any failure is false: the next step is a nudge, never a
 * gate, and nothing about it can be skipped or completed from here.
 */
export async function needsPasskeySwitch(): Promise<boolean> {
  if (!passkeysAvailable()) return false;
  const info = await createUpgradeApi().info();
  return info.kind === 'ok' && !info.registered;
}

/** Get started and the join screen: a focused column with no chrome (b11 §28, §33.2). */
export function isFocusedPath(path: string): boolean {
  return path.startsWith('/start/') || path === '/first-run' || path === '/settings/join';
}

/** UI-REFRESH-t: the first Tab stop. Focus goes to the page content (it is made focusable here). */
function skipToContent(event: MouseEvent<HTMLAnchorElement>): void {
  const main = document.querySelector<HTMLElement>('main.al-shell-content');
  if (main === null) return;
  event.preventDefault();
  main.setAttribute('tabindex', '-1');
  main.focus();
}

export { toggleHood };

/** How long the shell waits at most for the app's settings before it shows the page (CLS). */
export const SETTINGS_WAIT_MS = 300;

/** Cmd+Shift+U and Cmd+/ (Ctrl elsewhere); Cmd+K belongs to Go to (go-to.tsx). */
function useShellKeys(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === 'u') {
        event.preventDefault();
        toggleHood(!getPrefs().hood);
      } else if (!event.shiftKey && key === '/') {
        event.preventDefault();
        openShellDialog('shortcuts');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

export interface LayoutProps {
  readonly path: string;
  readonly children?: ReactNode;
  /** Test seam: whether to show the "Switch to …" next step. Default: needsPasskeySwitch. */
  readonly nextStep?: () => Promise<boolean>;
  /** The platform the next step names. Default: detected from the browser. */
  readonly platform?: Platform;
  /** Test seam: the Messages badge count (kept for the page tests; Home shows approvals). */
  readonly unseenMessages?: () => Promise<number>;
  /** Test seam: the approvals waiting count. Default: read from the local app. */
  readonly waitingApprovals?: () => Promise<number>;
  /** Test seam: the health read (M1-11s-a-d). Default: GET /api/ui/health. */
  readonly readHealth?: () => Promise<ApiResult<unknown>>;
  /** Test seam: the reads behind Start here (UX2-g). Default: the app's own. */
  readonly startHere?: StartHereReads;
}

export function Layout({
  path,
  children,
  nextStep = needsPasskeySwitch,
  platform: givenPlatform,
  waitingApprovals,
  readHealth,
  startHere,
}: LayoutProps): ReactElement {
  const focused = isFocusedPath(path);
  const connection = useConnectionState();
  const version = useHealth(readHealth);
  const waiting = useApprovalsWaiting(path, waitingApprovals);
  const { hood } = usePrefs();
  const expanded = useMenuExpanded();
  const settled = useUiSettingsSettled();
  useShellKeys();
  useEffect(() => {
    void startUiSettings();
    // W4-SHELL-LIVE (CLS ≤ 0.01): the strip and the body wait for the app's Under the hood and menu
    // values, at most SETTINGS_WAIT_MS (nothing shows under ~300 ms anyway), so neither the strip
    // nor the menu pushes the page along when the read lands.
    const wait = setTimeout(settleUiSettings, SETTINGS_WAIT_MS);
    return () => clearTimeout(wait);
  }, []);
  // UX2-g: one Start here model for the shell: the card and the empty states.
  const start = useStartHere(startHere, !focused, path);
  const [platform] = useState<Platform>(() => givenPlatform ?? detectPlatform());
  const [switchNeeded, setSwitchNeeded] = useState(false);
  useEffect(() => {
    if (focused) {
      setSwitchNeeded(false);
      return undefined;
    }
    let live = true;
    // Re-read on every page change, so the step is gone once the passkey is registered.
    nextStep().then(
      (needed) => {
        // W4-WIRE: a read that began before a registration on this page and answers after it is stale.
        if (live) setSwitchNeeded(needed && !passkeyRegisteredHere());
      },
      () => {
        if (live) setSwitchNeeded(false);
      },
    );
    return () => {
      live = false;
    };
  }, [path, nextStep, focused]);
  // W4-WIRE: a passkey registered on this page ends the next step at once (not on the next page
  // change, where its leaving moved the page that opened).
  useEffect(() => {
    const done = (): void => setSwitchNeeded(false);
    window.addEventListener(PASSKEY_REGISTERED_EVENT, done);
    return () => window.removeEventListener(PASSKEY_REGISTERED_EVENT, done);
  }, []);
  const facts = useCallback(
    () => ({
      ...(version === undefined ? {} : { version }),
      connection: (STATUS[connection] ?? STATUS.unknown)[1],
      hood: getPrefs().hood,
      agents: getLive().agents.length,
    }),
    [version, connection],
  );

  if (focused) {
    return (
      <PrefsHood>
        <a href="#al-main" className="al-skip al-text-body-sm" onClick={skipToContent}>
          {SHELL_STRINGS.skipToContent}
        </a>
        <main className="al-shell-content al-first-run" id="al-main">
          {children}
        </main>
      </PrefsHood>
    );
  }
  const [statusClass, statusWord] = STATUS[connection];
  const settings = sectionOf(path) === 'settings';
  return (
    <PrefsHood>
      <a href="#al-main" className="al-skip al-text-body-sm" onClick={skipToContent}>
        {SHELL_STRINGS.skipToContent}
      </a>
      <div className="al-app" data-hood={hood ? 'on' : 'off'}>
        <TopBar connection={connection} onHood={toggleHood} />
        {settled && hood ? <StatusStrip connection={connection} /> : null}
        {settled ? <SectionSheet path={path} hood={hood} /> : null}
        <div className="al-app-body" hidden={!settled}>
          <SectionRail
            path={path}
            hood={hood}
            expanded={expanded}
            onToggle={() => morph(() => setMenuExpanded(!expanded))}
            waiting={waiting}
          />
          <main className={`al-shell-content al-app-main ${VT_CLASS.main}`} id="al-main">
            <div className="al-route">
              {switchNeeded ? <SwitchToPasskeyBanner platform={platform} /> : null}
              {settings ? (
                <nav aria-label={SHELL_STRINGS.settingsNav} className="al-subnav">
                  {SETTINGS_PAGES.map((p) => (
                    <a
                      key={p.path}
                      href={p.path}
                      className={p.path === path ? 'is-active' : undefined}
                      aria-current={p.path === path ? 'page' : undefined}
                    >
                      {p.label}
                    </a>
                  ))}
                </nav>
              ) : null}
              <StartHereContext.Provider value={start}>
                {/* The one-time Tidy up note (b11 §29.7), on Home. */}
                {path === '/' ? <TidyNote /> : null}
                {children}
              </StartHereContext.Provider>
            </div>
          </main>
        </div>
        <footer className="al-statusbar al-chrome al-text-code" hidden={!settled}>
          {/* One polite live region: announced when the state changes, never per poll (B-11 §15). */}
          <span className="al-sb-item" role="status" aria-live="polite" aria-atomic="true">
            <span key={connection} className="al-sb-state">
              <span className={`al-dot is-${statusClass}`} aria-hidden="true" />
              {statusWord}
            </span>
          </span>
          <span className="al-sb-spacer" />
          {version === undefined ? null : <span className="al-sb-item">{version}</span>}
        </footer>
      </div>
      <GoTo onHood={toggleHood} />
      <ShellDialogs keys={shortcutKeys} facts={facts} />
    </PrefsHood>
  );
}
