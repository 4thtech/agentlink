// UI-REFRESH-e: Settings › Appearance (B-11 §16 row 20). Every choice applies at once and is kept in
// this browser. Each group has a visible label, linked to it (UI-REFRESH-t). The route and the nav entry come with UI-REFRESH-f.
import { PreviewTile, Segmented, Switch } from '@4thtech-io/ui';
import { useId, type ReactElement } from 'react';
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
  const base = useId();
  const labelFor = (key: string): string => `${base}-${key}`;
  return (
    <main>
      <h1 className="al-text-h1">{S.title}</h1>
      <p className="al-text-body al-muted">{S.intro}</p>
      <p id={labelFor('theme')} className="al-text-label">
        {S.theme}
      </p>
      <Segmented
        label={S.theme}
        labelledBy={labelFor('theme')}
        value={prefs.theme}
        options={[
          { value: 'system', label: S.system },
          { value: 'light', label: S.light },
          { value: 'dark', label: S.dark },
        ]}
        onChange={(v) => setPref('theme', v as ThemePref)}
      />
      <p id={labelFor('motion')} className="al-text-label">
        {S.motion}
      </p>
      <Segmented
        label={S.motion}
        labelledBy={labelFor('motion')}
        value={prefs.motion}
        options={[
          { value: 'system', label: S.system },
          { value: 'on', label: S.on },
          { value: 'off', label: S.off },
        ]}
        onChange={(v) => setPref('motion', v as MotionPref)}
      />
      <p className="al-text-caption al-muted">{S.motionHint}</p>
      <p id={labelFor('transparency')} className="al-text-label">
        {S.transparency}
      </p>
      <Segmented
        label={S.transparency}
        labelledBy={labelFor('transparency')}
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
