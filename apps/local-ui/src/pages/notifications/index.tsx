// N6 (PLAN-NOTIFY §4.4; D2; S1, no policy change): Settings › Notifications, in place of the redirect
// to Settings home. Kept by the local app per install (not per ID) in ui-settings (`notify`,
// ui-contract/notifications.ts), with the D2 default until the owner changes it.
//
// IR-NOTIFY-1 M-1: only a switch that works today is shown. "Approvals waiting" (on) governs the
// OS alert the approval server shows when a request waits (approval-os.ts; approval-server.ts
// notifyNewApproval). The other D2 switches (messages, people, problems, names, quiet hours) stay in
// the schema, hidden, until N7's native notifications implement them. Nothing here approves, signs
// or changes what an AI may do.
import {
  notifyPrefsInForce,
  type NotifyPrefKey,
} from '@4thtech-io/types/ui-contract/notifications';
import { InlineError, Switch } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { NOTIFY_SETTINGS_STRINGS as S } from '../../layout/notification-strings.js';
import { readStoredUiSettings, saveUiSettings } from '../../prefs/index.js';

/** The switches shown: only those something reads today (N7 adds the rest with what they do). */
const SHOWN: readonly NotifyPrefKey[] = ['approvals'];
const LABEL: Readonly<Partial<Record<NotifyPrefKey, string>>> = { approvals: S.approvals };
const HINT: Readonly<Partial<Record<NotifyPrefKey, string>>> = { approvals: S.approvalsHint };

export interface NotificationsPageProps {
  /** Test seams. */
  readonly read?: typeof readStoredUiSettings;
  readonly save?: typeof saveUiSettings;
}

export function NotificationsPage(props: NotificationsPageProps): ReactElement {
  const read = props.read ?? readStoredUiSettings;
  const save = props.save ?? saveUiSettings;
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
      {SHOWN.map((key) => {
        const hint = HINT[key];
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
