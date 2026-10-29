// UI-REFRESH-f, W4-SHELL (Decision 40; b11 §34.1): the right end of the top bar is one avatar menu:
// Settings, Advanced, the Under the hood switch and Go to (Cmd+K). The one status chip lives in the
// agent switcher (HOTFIX-045), top left; the theme is on Settings › Appearance. A calm bar (B8).
// Words follow 11 §5.
import { HOOD_STRINGS, Icon, Kbd, type LiveDotState } from '@4thtech-io/ui';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { Menu } from '../pages/agents/menu.js';
import { setPref, usePrefs } from '../prefs/index.js';
import { ADVANCED_HOME, ADVANCED_LABEL, SETTINGS_HOME, SETTINGS_LABEL } from '../nav.js';
import { navigate } from '../router.js';
import { SHELL_STRINGS as S } from '../strings.js';
import { goToKeys, openGoTo } from './go-to.js';
import type { ConnectionState } from './index.js';
import type { SwitcherChip } from './agent-switcher.js';

const CHIP: Readonly<Record<ConnectionState, { state: LiveDotState; label?: string }>> = {
  unknown: { state: 'checking' },
  connected: { state: 'connected' },
  paused: { state: 'paused' },
  not_running: { state: 'not-running' },
  needs_setup: { state: 'needs-setup' },
  // The browser lost its connection: the same shape as "not running", in the status bar's words.
  offline: { state: 'not-running', label: S.offlineChip },
};

/** The switcher's one chip for the app's connection state. */
export function connectionChip(connection: ConnectionState): SwitcherChip {
  return CHIP[connection];
}

export function AccountMenu(): ReactElement {
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback((restore: boolean): void => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }, []);
  const go = (to: string): void => {
    close(false);
    navigate(to);
  };
  return (
    <div className="ag-switch al-account">
      <button
        ref={trigger}
        type="button"
        className="al-account-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={S.accountMenu}
        title={S.accountMenu}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="settings" size={16} />
      </button>
      {open ? (
        <Menu
          label={S.accountMenu}
          onClose={close}
          triggerRef={trigger}
          className="al-account-menu"
        >
          <button
            type="button"
            role="menuitem"
            className="ag-menu-item"
            onClick={() => go(SETTINGS_HOME)}
          >
            {SETTINGS_LABEL}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ag-menu-item"
            onClick={() => go(ADVANCED_HOME)}
          >
            {ADVANCED_LABEL}
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={prefs.hood}
            className="ag-menu-item al-account-hood"
            title={HOOD_STRINGS.tooltip}
            onClick={() => setPref('hood', !prefs.hood)}
          >
            <span>{HOOD_STRINGS.title}</span>
            <span className="al-account-check" aria-hidden="true">
              {prefs.hood ? <Icon name="check" size={14} /> : null}
            </span>
          </button>
          <div className="ag-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="ag-menu-item"
            onClick={() => {
              close(false);
              openGoTo();
            }}
          >
            <span>{S.goTo}</span>
            <Kbd>{goToKeys()}</Kbd>
          </button>
        </Menu>
      ) : null}
    </div>
  );
}
