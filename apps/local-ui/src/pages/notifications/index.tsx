// N6 (PLAN-NOTIFY §4.4; D2; S1, no policy change): Settings › Notifications, in place of the redirect
// to Settings home. Kept by the local app per install (not per ID) in ui-settings (`notify`,
// ui-contract/notifications.ts), with the D2 default until the owner changes it.
//
// IR-NOTIFY-1 M-1: only a switch that works in this surface is shown.
// - In a browser: "Approvals waiting" (on) governs the OS alert the approval server shows when a
//   request waits (approval-os.ts; approval-server.ts notifyNewApproval).
// - N7, in the desktop app: its native notifications (apps/desktop notify.ts, fed by the core's
//   fixed codes, apps/cli desktop/alerts.ts): approvals (on), new messages, files received, updates
//   (off) and Show names (off: "a contact"; on: only names the owner gave).
// The rest of the D2 schema (people, problems, quiet hours) stays hidden until built. Which switches
// show is a matter of words only (inDesktopApp); the core decides what alerts. Nothing here approves,
// signs or changes what an AI may do.
import {
  notifyPrefsInForce,
  type NotifyPrefKey,
} from '@4thtech-io/types/ui-contract/notifications';
import { InlineError, Switch } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { inDesktopApp } from '../../desktop.js';
import { NOTIFY_SETTINGS_STRINGS as S } from '../../layout/notification-strings.js';
import { readStoredUiSettings, saveUiSettings } from '../../prefs/index.js';

/** The switches shown in a browser: only the one something reads there. */
const SHOWN_BROWSER: readonly NotifyPrefKey[] = ['approvals'];
/** N7: the switches the desktop app's native notifications read. */
const SHOWN_DESKTOP: readonly NotifyPrefKey[] = [
  'approvals',
  'messages',
  'files',
  'updates',
  'showNames',
];
const LABEL: Readonly<Partial<Record<NotifyPrefKey, string>>> = {
  approvals: S.approvals,
  messages: S.messages,
  files: S.files,
  updates: S.updates,
  showNames: S.showNames,
};
const HINT_BROWSER: Readonly<Partial<Record<NotifyPrefKey, string>>> = {
  approvals: S.approvalsHint,
};
const HINT_DESKTOP: Readonly<Partial<Record<NotifyPrefKey, string>>> = {
  approvals: S.approvalsHintDesktop,
  messages: S.messagesHint,
  files: S.filesHint,
  updates: S.updatesHint,
  showNames: S.showNamesHint,
};

export interface NotificationsPageProps {
  /** Test seams. */
  readonly read?: typeof readStoredUiSettings;
  readonly save?: typeof saveUiSettings;
  /** Test seam: the desktop app (default: the page's own user-agent marker). */
  readonly desktop?: boolean;
}

export function NotificationsPage(props: NotificationsPageProps): ReactElement {
  const read = props.read ?? readStoredUiSettings;
  const save = props.save ?? saveUiSettings;
  const desktop = props.desktop ?? inDesktopApp();
  const shown = desktop ? SHOWN_DESKTOP : SHOWN_BROWSER;
  const hints = desktop ? HINT_DESKTOP : HINT_BROWSER;
  const [prefs, setPrefs] = useState(() => notifyPrefsInForce(undefined));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    read().then(
      (stored) => {
        if (live) setPrefs(notifyPrefsInForce(stored?.notify));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [read]);

  const change = (key: NotifyPrefKey, on: boolean): void => {
    const before = prefs[key];
    setPrefs((p) => ({ ...p, [key]: on }));
    setFailed(false);
    void save({ notify: { [key]: on } }).then((ok) => {
      if (ok) return;
      setPrefs((p) => ({ ...p, [key]: before }));
      setFailed(true);
    });
  };

  return (
    <div className="set-stack">
      <h1 className="al-text-title-1">{S.title}</h1>
      <p className="al-text-body al-muted">{S.intro}</p>
      {failed ? <InlineError>{S.saveFailed}</InlineError> : null}
      {shown.map((key) => {
        const hint = hints[key];
        return (
          <Switch
            key={key}
            label={LABEL[key] ?? key}
            {...(hint === undefined ? {} : { description: hint })}
            checked={prefs[key]}
            onChange={(on) => change(key, on)}
          />
        );
      })}
    </div>
  );
}
