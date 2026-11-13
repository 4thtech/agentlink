// N6 (PLAN-NOTIFY §4.4; D2; S1, no policy change): Settings › Notifications, in place of the redirect
// to Settings home. Six switches, kept by the local app per install (not per ID) in ui-settings
// (`notify`, ui-contract/notifications.ts), with the D2 defaults until the owner changes one:
// approvals on; messages, people and problems off; names off; quiet hours off.
//
// The switches say what AgentLink may alert the owner about outside the app window; the bell in
// the app always lists what is new. Nothing here approves, signs or changes what an AI may do.
import {
  NOTIFY_PREF_KEYS,
  notifyPrefsInForce,
  type NotifyPrefKey,
} from '@4thtech-io/types/ui-contract/notifications';
import { InlineError, Switch } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { NOTIFY_SETTINGS_STRINGS as S } from '../../layout/notification-strings.js';
import { readStoredUiSettings, saveUiSettings } from '../../prefs/index.js';

const LABEL: Readonly<Record<NotifyPrefKey, string>> = {
  approvals: S.approvals,
  messages: S.messages,
  people: S.people,
  problems: S.problems,
  showNames: S.showNames,
  quietHours: S.quietHours,
};

const HINT: Readonly<Partial<Record<NotifyPrefKey, string>>> = {
  approvals: S.approvalsHint,
  messages: S.messagesHint,
  problems: S.problemsHint,
  showNames: S.showNamesHint,
  quietHours: S.quietHoursHint,
};

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
      {NOTIFY_PREF_KEYS.map((key) => {
        const hint = HINT[key];
        return (
          <Switch
            key={key}
            label={LABEL[key]}
            {...(hint === undefined ? {} : { description: hint })}
            checked={prefs[key]}
            onChange={(on) => change(key, on)}
          />
        );
      })}
    </div>
  );
}
