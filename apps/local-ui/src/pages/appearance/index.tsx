// UI-REFRESH-e: Settings › Appearance (B-11 §16 row 20). Every choice applies at once and is kept in
// this browser. The route and the nav entry come with UI-REFRESH-f.
import { PreviewTile, Segmented, Switch } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import {
  setPref,
  usePrefs,
  type MotionPref,
  type ThemePref,
  type TransparencyPref,
} from '../../prefs/index.js';
import { APPEARANCE_STRINGS as S } from './strings.js';

export function AppearancePage(): ReactElement {
  const prefs = usePrefs();
  return (
    <main>
      <h1 className="al-text-h1">{S.title}</h1>
      <p className="al-text-body al-muted">{S.intro}</p>
      <Segmented
        label={S.theme}
        value={prefs.theme}
        options={[
          { value: 'system', label: S.system },
          { value: 'light', label: S.light },
          { value: 'dark', label: S.dark },
        ]}
        onChange={(v) => setPref('theme', v as ThemePref)}
      />
      <Segmented
        label={S.motion}
        value={prefs.motion}
        options={[
          { value: 'system', label: S.system },
          { value: 'on', label: S.on },
          { value: 'off', label: S.off },
        ]}
        onChange={(v) => setPref('motion', v as MotionPref)}
      />
      <Segmented
        label={S.transparency}
        value={prefs.transparency}
        options={[
          { value: 'system', label: S.system },
          { value: 'reduce', label: S.reduce },
        ]}
        onChange={(v) => setPref('transparency', v as TransparencyPref)}
      />
      <Switch
        label={S.hoodLabel}
        description={S.hoodHint}
        checked={prefs.hood}
        onChange={(on) => setPref('hood', on)}
      />
      <PreviewTile />
    </main>
  );
}
