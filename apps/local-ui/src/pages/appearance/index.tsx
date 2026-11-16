// UI-REFRESH-e: Settings › Appearance (B-11 §16 row 20). Every choice applies at once and is kept in
// this browser. Each group has a visible label, linked to it (UI-REFRESH-t). The route and the nav entry come with UI-REFRESH-f.
// W4-SHELL-V2: the same morph as the top bar switch (one setting, kept by the app).
// TRAY-TOGGLE (D-155): the menu bar widget switches, kept by the app in ui-settings (absent = on).
// "Show AgentLink in the menu bar" (Mac) / "near the clock" (Windows) shows only in the desktop app;
// "Show message previews" shows everywhere. Which rows show is a matter of words only; the server
// decides what the widget gets. Nothing here changes what an AI may do (I-4).
import { toggleHood } from '../../layout/hood.js';
import {
  trayPrefsInForce,
  type TrayPrefs,
  type UiSettings,
} from '@4thtech-io/types/ui-contract/ui-settings';
import { InlineError, PreviewTile, Segmented, Switch } from '@4thtech-io/ui';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { desktopPlatform, type DesktopPlatform } from '../../presence/desktop.js';
import {
  readStoredUiSettings,
  saveUiSettings,
  setPref,
  usePrefs,
  type MotionPref,
  type ThemePref,
  type TransparencyPref,
} from '../../prefs/index.js';
import { APPEARANCE_STRINGS as S } from './strings.js';

export interface AppearancePageProps {
  /** Test seams. */
  readonly read?: () => Promise<UiSettings | undefined>;
  readonly save?: (change: UiSettings) => Promise<boolean>;
  /** Test seam: the desktop app's platform, null in a browser (default: the page's user agent). */
  readonly platform?: DesktopPlatform | null;
}

export function AppearancePage(props: AppearancePageProps): ReactElement {
  const read = props.read ?? readStoredUiSettings;
  const save = props.save ?? saveUiSettings;
  const platform = props.platform === undefined ? desktopPlatform() : props.platform;
  const prefs = usePrefs();
  const base = useId();
  const [tray, setTray] = useState<TrayPrefs>(() => trayPrefsInForce(undefined));
  const [trayFailed, setTrayFailed] = useState(false);

  // Per switch: how many saves were started (the newest decides what shows), the value the app is
  // known to hold, and which save that value came from. A switch the owner already touched ignores
  // the first read when it lands late.
  const traySeq = useRef<Record<keyof TrayPrefs, number>>({ menuBarIcon: 0, widgetPreviews: 0 });
  const trayKept = useRef<TrayPrefs>(trayPrefsInForce(undefined));
  const trayKeptSeq = useRef<Record<keyof TrayPrefs, number>>({
    menuBarIcon: 0,
    widgetPreviews: 0,
  });

  useEffect(() => {
    let live = true;
    read().then(
      (stored) => {
        if (!live) return;
        const inForce = trayPrefsInForce(stored);
        const untouched = (key: keyof TrayPrefs): boolean => traySeq.current[key] === 0;
        for (const key of ['menuBarIcon', 'widgetPreviews'] as const) {
          if (untouched(key)) trayKept.current = { ...trayKept.current, [key]: inForce[key] };
        }
        setTray((t) => ({
          menuBarIcon: untouched('menuBarIcon') ? inForce.menuBarIcon : t.menuBarIcon,
          widgetPreviews: untouched('widgetPreviews') ? inForce.widgetPreviews : t.widgetPreviews,
        }));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [read]);

  const changeTray = (key: keyof TrayPrefs, on: boolean): void => {
    const seq = traySeq.current[key] + 1;
    traySeq.current = { ...traySeq.current, [key]: seq };
    setTray((t) => ({ ...t, [key]: on }));
    setTrayFailed(false);
    void save(key === 'menuBarIcon' ? { menuBarIcon: on } : { widgetPreviews: on }).then((ok) => {
      if (ok) {
        // Saves run one at a time in the app; the newest stored one is what the app holds.
        if (seq > trayKeptSeq.current[key]) {
          trayKeptSeq.current = { ...trayKeptSeq.current, [key]: seq };
          trayKept.current = { ...trayKept.current, [key]: on };
        }
        return;
      }
      // Only the newest change reverts, and to what the app holds now (never an older value).
      if (seq !== traySeq.current[key]) return;
      const kept = trayKept.current[key];
      setTray((t) => ({ ...t, [key]: kept }));
      setTrayFailed(true);
    });
  };
  const labelFor = (key: string): string => `${base}-${key}`;
  return (
    <div className="set-stack">
      <h1 className="al-text-title-1">{S.title}</h1>
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
        onChange={(on) => toggleHood(on)}
      />
      {trayFailed ? <InlineError>{S.traySaveFailed}</InlineError> : null}
      {platform === null || platform === undefined ? null : (
        <Switch
          label={platform === 'mac' ? S.menuBarMac : S.menuBarWindows}
          description={
            platform === 'mac' ? S.menuBarHint : `${S.menuBarHint} ${S.menuBarWindowsHint}`
          }
          checked={tray.menuBarIcon}
          onChange={(on) => changeTray('menuBarIcon', on)}
        />
      )}
      <Switch
        label={S.previewsLabel}
        description={S.previewsHint}
        checked={tray.widgetPreviews}
        onChange={(on) => changeTray('widgetPreviews', on)}
      />
      <PreviewTile />
    </div>
  );
}
