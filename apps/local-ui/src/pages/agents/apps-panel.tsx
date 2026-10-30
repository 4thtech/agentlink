// W4-AGENTS: an agent's AI apps, inline on its card and on its page (W4 UX v2: "Connect / Disconnect
// AI app (with 'Quit the app first / Restart' guidance)"). Each app shows its live word. Connect and
// Disconnect open the same change panel the AI apps page uses (pages/apps/panel.tsx, imported
// read-only): the exact AgentLink entry and file first, Touch ID once, "Quit {app} first", "Restart
// {app} to finish", the move from another agent and the manual steps. That panel acts on the open
// agent only (08 §1), so the card hands the press of another agent to the page (switch first).
import { Button } from '@4thtech-io/ui';
import { useState, type ReactElement, type ReactNode } from 'react';
import type { OwnerClient } from '../contacts/owner.js';
import { createAppsApi, type AppsApi } from '../apps/api.js';
import type { AppRow, Entry } from '../apps/data.js';
import { ChangePanel, ManualPanel, type Labels } from '../apps/panel.js';
import { appsOf, appWord, type AgentRow, type AppLive } from './data.js';
import { AppDot } from './parts.js';
import { AGENTS_STRINGS as S } from './strings.js';

type Open =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading'; readonly app: string }
  | { readonly kind: 'change'; readonly row: AppRow }
  | {
      readonly kind: 'manual';
      readonly row: AppRow | undefined;
      readonly entry: Entry | undefined;
    };

export function AppsPanel({
  row,
  labelOf,
  owner,
  apps: givenApps,
  now,
  onOtherAgent,
  onChanged,
  onAgentChanged,
  extra,
}: {
  row: AgentRow;
  labelOf: (folder: string) => string;
  owner: OwnerClient;
  apps?: AppsApi;
  now: number;
  /** A press on another agent's app: the page switches to it first. */
  onOtherAgent: () => void;
  onChanged: () => void;
  onAgentChanged: () => void;
  /** Drawn after an app's word (the agent page's heartbeat history). */
  extra?: (app: AppLive) => ReactNode;
}): ReactElement {
  const [api] = useState<AppsApi>(() => givenApps ?? createAppsApi());
  const [open, setOpen] = useState<Open>({ kind: 'none' });
  const [restart, setRestart] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const apps = appsOf(row);

  const press = (app: AppLive): void => {
    if (!row.current) return onOtherAgent();
    setMissing(false);
    setOpen({ kind: 'loading', app: app.id });
    void api.list().then((out) => {
      const found = out.kind === 'ok' ? out.list.apps.find((a) => a.app === app.id) : undefined;
      if (found === undefined) {
        setOpen({ kind: 'none' });
        return setMissing(true);
      }
      setOpen({ kind: 'change', row: found });
    });
  };
  const labels: Labels = { folder: row.name, label: row.label, labelOf };

  return (
    <div className="ag-expand al-expand" data-panel="apps">
      {apps.length === 0 ? (
        <p className="al-text-body-sm al-muted">{S.noAppsYet}</p>
      ) : (
        <ul className="ag-apps">
          {apps.map((a) => (
            <li key={a.id} className="ag-app-row">
              <AppDot app={a} />
              <span className="ag-app-text">
                <span className="al-text-body-sm">{a.name}</span>
                <span className="al-text-body-sm al-muted">{appWord(a, now)}</span>
              </span>
              {extra?.(a)}
              {a.id === 'other' ? null : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={open.kind === 'loading'}
                  onClick={() => press(a)}
                >
                  {a.state === 'not_set_up' ? S.connect : S.disconnect}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="al-text-body-sm al-muted">{S.quitFirstHint}</p>
      {restart === undefined ? null : (
        <p className="al-text-body-sm" role="status">
          {S.restartToFinish(restart)}
        </p>
      )}
      {missing ? (
        <p className="al-text-body-sm" role="status">
          {S.useAppsPage}
        </p>
      ) : null}
      <a
        className="ag-link al-text-body-sm"
        href={`/settings/apps?agent=${encodeURIComponent(row.name)}`}
      >
        {S.manageApps}
      </a>
      {open.kind === 'change' ? (
        <ChangePanel
          app={open.row}
          labels={labels}
          api={api}
          owner={owner}
          onClose={() => setOpen({ kind: 'none' })}
          onDone={(change) => {
            setOpen({ kind: 'none' });
            setRestart(change.kind === 'disconnect' ? undefined : change.name);
            onChanged();
          }}
          onManual={(entry) => setOpen({ kind: 'manual', row: open.row, entry })}
          onAgentChanged={() => {
            setOpen({ kind: 'none' });
            onAgentChanged();
          }}
        />
      ) : null}
      {open.kind === 'manual' ? (
        <ManualPanel
          app={open.row}
          folder={row.name}
          entry={open.entry}
          onClose={() => setOpen({ kind: 'none' })}
        />
      ) : null}
    </div>
  );
}
