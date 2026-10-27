// UI-REFRESH-f: the right end of the top bar (B-11 §3): the Under the hood switch, the live status
// chip and the theme control, in that order. The chip is a LiveDot (shape and word); it is not a live
// region, the status bar announces changes. Words follow 11 §5.
import { HOOD_STRINGS, Icon, LiveDot, Switch, type LiveDotState } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import { setPref, usePrefs, type ThemePref } from '../prefs/index.js';
import { SHELL_STRINGS as S } from '../strings.js';
import type { ConnectionState } from './index.js';

const CHIP: Readonly<Record<ConnectionState, { state: LiveDotState; label?: string }>> = {
  unknown: { state: 'checking' },
  connected: { state: 'connected' },
  paused: { state: 'paused' },
  not_running: { state: 'not-running' },
  needs_setup: { state: 'needs-setup' },
  // The browser lost its connection: the same shape as "not running", in the status bar's words.
  offline: { state: 'not-running', label: S.offlineChip },
};

const THEME_NAME: Readonly<Record<ThemePref, string>> = {
  system: S.themeSystem,
  light: S.themeLight,
  dark: S.themeDark,
};
const NEXT_THEME: Readonly<Record<ThemePref, ThemePref>> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

export function TopBarControls({ connection }: { connection: ConnectionState }): ReactElement {
  const prefs = usePrefs();
  const chip = CHIP[connection];
  const theme = THEME_NAME[prefs.theme];
  return (
    <>
      <span title={HOOD_STRINGS.tooltip}>
        <Switch
          label={HOOD_STRINGS.title}
          checked={prefs.hood}
          onChange={(on) => setPref('hood', on)}
        />
      </span>
      <LiveDot state={chip.state} {...(chip.label === undefined ? {} : { label: chip.label })} />
      <button
        type="button"
        className="al-btn al-btn-ghost al-btn-sm al-topbar-theme"
        aria-label={`${S.themeName}: ${theme}. ${S.themeChange}`}
        onClick={() => setPref('theme', NEXT_THEME[prefs.theme])}
      >
        <Icon name="sliders-horizontal" size={14} />
        <span className="al-topbar-theme-text">{theme}</span>
      </button>
    </>
  );
}
