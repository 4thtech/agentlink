// W4-AGENTS (A8, W4 UX v2 "Agents", simple layer): one card per agent with its letter icon and live
// dot, its label, the live line ("Working in Claude Code", "Ready", "Offline · last seen 5 min ago"),
// its AI apps with their words, and Pause or Resume, Rename, AI apps, Back up and Remove. Panels open
// in place. Labels are text only, in their own bidi run (I-5).
import { AgentIcon, Button, Icon } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import type { OwnerClient } from '../contacts/owner.js';
import type { AppsApi } from '../apps/api.js';
import type { AgentsApi } from './api.js';
import { AppsPanel } from './apps-panel.js';
import { agentLine, appsOf, dotOf, stateOf, type AgentRow } from './data.js';
import { AppChips, CardNameNote } from './parts.js';
import { RenameEditor } from './sheets.js';
import { AGENTS_STRINGS as S } from './strings.js';

export type Panel = 'apps' | 'backup';

export interface CardActions {
  readonly api: AgentsApi;
  readonly owner: OwnerClient;
  readonly apps?: AppsApi;
  readonly now: number;
  readonly labelOf: (folder: string) => string;
  readonly cardName: string | undefined;
  /** The panel open on one card (the page keeps it: a switch-first press reopens it). */
  readonly panel: { readonly name: string; readonly panel: Panel } | undefined;
  readonly setPanel: (next: { name: string; panel: Panel } | undefined) => void;
  readonly onPause: (row: AgentRow) => void;
  readonly onResume: (row: AgentRow) => void;
  readonly onSwitch: (row: AgentRow) => void;
  readonly onRemove: (row: AgentRow) => void;
  readonly onAppsElsewhere: (row: AgentRow) => void;
  readonly onRenamed: (label: string, told: boolean) => void;
  readonly onCardUpdated: (told: boolean) => void;
  readonly onChanged: () => void;
  readonly onAgentChanged: () => void;
}

/** The Back up panel: the recovery kit lives in Settings (Backup & Touch ID). */
export function BackupPanel(): ReactElement {
  return (
    <div className="ag-expand al-expand" data-panel="backup">
      <p className="al-text-body-sm">
        <strong>{S.backupTitle}</strong>
      </p>
      <p className="al-text-body-sm al-muted">{S.backupHint}</p>
      <a className="al-btn al-btn-secondary al-btn-sm" href="/settings/backup">
        {S.backupLink}
      </a>
    </div>
  );
}

export function AgentCard({
  row,
  tidy,
  actions: a,
}: {
  row: AgentRow;
  tidy: boolean;
  actions: CardActions;
}): ReactElement {
  const [renaming, setRenaming] = useState(false);
  const state = stateOf(row);
  const open = a.panel?.name === row.name ? a.panel.panel : undefined;
  const toggle = (panel: Panel): void =>
    a.setPanel(open === panel ? undefined : { name: row.name, panel });
  const running = appsOf(row).filter((x) => x.state !== 'not_set_up');

  if (row.removing) {
    return (
      <section className="ag-card ag-row-removing" aria-label={row.label} data-agent={row.name}>
        <div className="ag-card-head">
          <AgentIcon label={row.label} seed={row.name} size="lg" />
          <div className="ag-card-title">
            <span className="al-text-title-3 ag-label">
              <bdi>{row.label}</bdi>
            </span>
            <span className="ag-warn al-text-label">
              <Icon name="triangle-alert" size={14} />
              {S.removalNotFinished}
            </span>
          </div>
        </div>
        <p className="al-text-body-sm al-muted">{S.removalReason}</p>
        <div className="ag-actions">
          <Button variant="secondary" onClick={() => a.onRemove(row)}>
            {S.tryAgain}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="ag-card al-reveal" aria-label={row.label} data-agent={row.name}>
      <div className="ag-card-head">
        <AgentIcon label={row.label} seed={row.name} size="lg" dot={dotOf(row)} />
        <div className="ag-card-title">
          <span className="ag-title-line">
            <span className="al-text-title-3 ag-label">
              <bdi>{row.label}</bdi>
            </span>
            {row.current ? <span className="ag-open al-text-label">{S.open}</span> : null}
          </span>
          <span className={`ag-line al-text-body-sm is-${state}`}>{agentLine(row, a.now)}</span>
        </div>
        {row.current ? null : (
          <Button variant="ghost" size="sm" onClick={() => a.onSwitch(row)}>
            {S.switch}
          </Button>
        )}
      </div>
      {running.length > 0 ? <AppChips apps={running} now={a.now} /> : null}
      <p className="al-text-body-sm al-muted">
        {S.contactsCount(row.contacts)}
        {tidy ? ` · ${S.noAppNoContacts}` : ''}
      </p>
      {row.current && a.cardName !== undefined ? (
        <CardNameNote
          row={row}
          cardName={a.cardName}
          api={a.api}
          owner={a.owner}
          onUpdated={a.onCardUpdated}
        />
      ) : null}
      {renaming ? (
        <RenameEditor
          row={row}
          api={a.api}
          owner={a.owner}
          onDone={() => setRenaming(false)}
          onCancel={() => setRenaming(false)}
          onChanged={a.onChanged}
          onRenamed={a.onRenamed}
        />
      ) : (
        <div className="ag-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={state === 'paused' ? 'play' : 'pause'}
            onClick={() => (state === 'paused' ? a.onResume(row) : a.onPause(row))}
          >
            {state === 'paused' ? S.resume : S.pause}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
            {S.rename}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon="ai-app"
            aria-expanded={open === 'apps'}
            onClick={() => toggle('apps')}
          >
            {S.aiApps}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon="key-round"
            aria-expanded={open === 'backup'}
            onClick={() => toggle('backup')}
          >
            {S.backUp}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => a.onRemove(row)}>
            {S.remove}
          </Button>
        </div>
      )}
      {open === 'apps' ? (
        <AppsPanel
          row={row}
          labelOf={a.labelOf}
          owner={a.owner}
          {...(a.apps === undefined ? {} : { apps: a.apps })}
          now={a.now}
          onOtherAgent={() => a.onAppsElsewhere(row)}
          onChanged={a.onChanged}
          onAgentChanged={a.onAgentChanged}
        />
      ) : null}
      {open === 'backup' ? <BackupPanel /> : null}
    </section>
  );
}
