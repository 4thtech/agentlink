// W4-SHELL-V2 (W4 UX v2 Layer 2 "Top bar"; prototype v23 A4/A10): one bar across the window. Left:
// the mark and the agent chip with its live dropdown. Right: Go to (Cmd+K), the "?" Help menu (Get
// started, Keyboard shortcuts, User guide, Report a problem) and the "Under the hood" switch, top
// right. The gear menu of #715 is gone: Settings is a section, Under the hood is this switch. Words
// follow 11 §5.
import { Kbd, Lockup } from '@4thtech-io/ui';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { START_PATH } from '../nav.js';
import { navigate } from '../router.js';
import { Menu } from '../pages/agents/menu.js';
import { setUnderTheHood, usePrefs } from '../prefs/index.js';
import { SHELL_STRINGS as S } from '../strings.js';
import { AgentSwitcher, type SwitcherChip } from './agent-switcher.js';
import { goToKeys, openGoTo } from './go-to.js';
import type { ConnectionState } from './index.js';
import { VT_CLASS } from './motion.js';
import { openShellDialog } from './shell-dialogs.js';
import { ShellIcon } from './shell-icons.js';

/** The user guide (the same address as About › Read the guides). */
export const GUIDE_URL = 'https://wiki.4thtech.io/products/agentlink';

const CHIP: Readonly<Record<ConnectionState, SwitcherChip>> = {
  unknown: { state: 'checking' },
  connected: { state: 'connected' },
  paused: { state: 'paused' },
  not_running: { state: 'not-running' },
  needs_setup: { state: 'needs-setup' },
  // The browser lost its connection: the same shape as "not running", in the status bar's words.
  offline: { state: 'not-running', label: S.offlineChip },
};

/** The chip's one status for the app's connection state. */
export function connectionChip(connection: ConnectionState): SwitcherChip {
  return CHIP[connection];
}

/** The "?" Help menu. */
export function HelpMenu(): ReactElement {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback((restore: boolean): void => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }, []);
  return (
    <div className="al-help">
      <button
        ref={trigger}
        type="button"
        className="al-iconbtn al-press"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={S.help}
        title={S.help}
        onClick={() => setOpen((v) => !v)}
      >
        <ShellIcon name="help" size={20} />
      </button>
      {open ? (
        <Menu label={S.help} onClose={close} triggerRef={trigger} className="al-shell-menu al-help-menu al-menu">
          <button
            type="button"
            role="menuitem"
            className="al-mitem"
            onClick={() => {
              close(false);
              navigate(START_PATH);
            }}
          >
            <ShellIcon name="rocket" size={16} />
            {S.helpGetStarted}
          </button>
          <button
            type="button"
            role="menuitem"
            className="al-mitem"
            onClick={() => {
              close(false);
              openShellDialog('shortcuts', trigger.current);
            }}
          >
            <ShellIcon name="keyboard" size={16} />
            <span className="al-mitem-grow">{S.helpShortcuts}</span>
            <Kbd>{shortcutKeys('/')}</Kbd>
          </button>
          <a
            role="menuitem"
            className="al-mitem"
            href={GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => close(false)}
          >
            <ShellIcon name="book" size={16} />
            {S.helpGuide}
          </a>
          <button
            type="button"
            role="menuitem"
            className="al-mitem"
            onClick={() => {
              close(false);
              openShellDialog('report', trigger.current);
            }}
          >
            <ShellIcon name="flag" size={16} />
            {S.helpReport}
          </button>
        </Menu>
      ) : null}
    </div>
  );
}

/** "⌘/" on a Mac, "Ctrl+/" elsewhere (and "⌘⇧U" / "Ctrl+Shift+U"). */
export function shortcutKeys(key: string, shift = false): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  if (mac) return `⌘${shift ? '⇧' : ''}${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

/** The "Under the hood" switch, top right (role="switch"). */
export function HoodSwitch({ onToggle }: { readonly onToggle?: (on: boolean) => void }): ReactElement {
  const { hood } = usePrefs();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={hood}
      className="al-hood-switch"
      title={S.hoodTooltip}
      onClick={() => (onToggle ?? setUnderTheHood)(!hood)}
    >
      <span className="al-hood-label">{S.hood}</span>
      <span className="al-switch-track" aria-hidden="true">
        <span className="al-switch-knob" />
      </span>
    </button>
  );
}

export interface TopBarProps {
  readonly connection: ConnectionState;
  /** Turns Under the hood on or off (the shell wraps it in the morph). */
  readonly onHood: (on: boolean) => void;
}

export function TopBar({ connection, onHood }: TopBarProps): ReactElement {
  const goTo = useRef<HTMLButtonElement>(null);
  return (
    <header className={`al-top al-chrome ${VT_CLASS.top}`}>
      <span className="al-top-brand">
        <Lockup size={18} />
      </span>
      <AgentSwitcher chip={connectionChip(connection)} />
      <div className="al-top-end">
        <button
          ref={goTo}
          type="button"
          className="al-goto-btn al-press"
          aria-label={S.goToButtonName}
          onClick={() => openGoTo(goTo.current)}
        >
          <ShellIcon name="search" size={16} />
          <span className="al-hide-sm">{S.goToButton}</span>
          <span className="al-hide-sm">
            <Kbd>{goToKeys()}</Kbd>
          </span>
        </button>
        <HelpMenu />
        <HoodSwitch onToggle={onHood} />
      </div>
    </header>
  );
}
