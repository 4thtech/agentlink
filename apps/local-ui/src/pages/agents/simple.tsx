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
import {
  AppChips,
  CardNameNote,
  KitPill,
  machineNamed,
  NameNudge,
  type KitState,
} from './parts.js';
import { PencilIcon, ShieldCheckIcon } from './icons.js';
import { ACTIVITY_PATH } from '../../nav.js';
import { navigate } from '../../router.js';

const RULES_PATH = '/settings/rules';
const BACKUP_PATH = '/settings/backup';
import { RenameEditor } from './sheets.js';
import { AGENTS_STRINGS as S } from './strings.js';

// UX1113-QA2 N1: `rename` is the Rename editor, opened by the page after a switch-first press.
export type Panel = 'apps' | 'backup' | 'rename';

export interface CardActions {
  readonly api: AgentsApi;
  readonly owner: OwnerClient;
  readonly apps?: AppsApi;
  readonly now: number;
  readonly labelOf: (folder: string) => string;
  readonly cardName: string | undefined;
  /** The kit state of an ID. Not given until the kit record exists (WP-R2): the pill stays hidden. */
  readonly kitOf?: (row: AgentRow) => KitState;
  /** The panel open on one card (the page keeps it: a switch-first press reopens it). */
  readonly panel: { readonly name: string; readonly panel: Panel } | undefined;
  readonly setPanel: (next: { name: string; panel: Panel } | undefined) => void;
  readonly onPause: (row: AgentRow) => void;
  readonly onResume: (row: AgentRow) => void;
  readonly onSwitch: (row: AgentRow) => void;
  readonly onRemove: (row: AgentRow) => void;
  readonly onAppsElsewhere: (row: AgentRow) => void;
  /** F27: start the Invite flow for this ID. */
  readonly onInvite: (row: AgentRow) => void;
  /** UX1113-QA2 N1: Rename on another ID switches to it first (the page opens the editor after). */
  readonly onRenameElsewhere: (row: AgentRow) => void;
  readonly onRenamed: (label: string, told: boolean) => void;
  readonly onCardUpdated: (told: boolean) => void;
  readonly onChanged: () => void;
  readonly onAgentChanged: () => void;
}

/**
 * The Back up panel (WP-11; UX1113 integration C): one recovery kit covers every ID (D-147, WP-R2),
 * so no ID is opened first and nothing is saved here; the panel leads to Settings › Backup & restore,
 * where the kit is saved, checked and restored.
 */
export function BackupPanel(): ReactElement {
  return (
    <div className="ag-expand al-expand" data-panel="backup">
      <p className="al-text-body-sm">
        <strong>{S.backupTitle}</strong>
      </p>
      <p className="al-text-body-sm al-muted">{S.backupHint}</p>
      <a
        className="al-btn al-btn-secondary al-btn-sm"
        href={BACKUP_PATH}
        onClick={(event) => {
          event.preventDefault();
          navigate(BACKUP_PATH);
        }}
      >
        {S.backupOpen}
      </a>
    </div>
  );
}

export function AgentCard({
  row,
  actions: a,
}: {
  row: AgentRow;
  tidy?: boolean;
  actions: CardActions;
}): ReactElement {
  const [renamingHere, setRenaming] = useState(false);
  const [more, setMore] = useState(false);
  const state = stateOf(row);
  const open = a.panel?.name === row.name ? a.panel.panel : undefined;
  // UX1113-QA2 N1: core renames the open ID only; another ID is opened first (08 §1).
  const renaming = renamingHere || (open === 'rename' && row.current);
  const startRename = (): void => (row.current ? setRenaming(true) : a.onRenameElsewhere(row));
  const stopRename = (): void => {
    setRenaming(false);
    if (open === 'rename') a.setPanel(undefined);
  };
  const toggle = (panel: Panel): void =>
    a.setPanel(open === panel ? undefined : { name: row.name, panel });
  const running = appsOf(row).filter((x) => x.state !== 'not_set_up');
  const line = agentLine(row, a.now);

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

  const noApp = !appsOf(row).some((x) => x.state !== 'not_set_up') && state === 'offline';
  const outdated = running.some((x) => x.outdated === true);
  const lineWord =
    state === 'paused'
      ? S.pausedWord
      : noApp
        ? S.notUsedYet
        : outdated || (state !== 'working' && state !== 'ready' && state !== 'idle')
          ? line
          : state === 'working'
            ? S.workingNow
            : S.readyWord;
  const lineText = row.current ? `${lineWord}${S.openSuffix}` : lineWord;
  const lineState = state === 'idle' ? 'ready' : state;

  return (
    <section className="ag-card al-reveal" aria-label={row.label} data-agent={row.name}>
      <div className="ag-card-head">
        <AgentIcon label={row.label} seed={row.name} size="lg" dot={dotOf(row)} />
        <div className="ag-card-title">
          <span className="al-text-title-3 ag-label">
            <bdi>{row.label}</bdi>
          </span>
          <span className={`ag-line al-text-body-sm is-${lineState}`}>{lineText}</span>
          {running.length > 0 ? <AppChips apps={running} now={a.now} card /> : null}
          {noApp ? <p className="al-text-body-sm al-muted">{S.noAppConnected}</p> : null}
        </div>
        <div className="ag-side">
          {row.contacts === null ? (
            <span className="al-text-body-sm al-muted">{S.contactsCount(null)}</span>
          ) : (
            <span className="ag-people">
              <strong className="al-text-title-3">{row.contacts}</strong>
              <span className="al-text-body-sm al-muted">{S.peopleCount(row.contacts)}</span>
            </span>
          )}
          <KitPill kit={a.kitOf?.(row)} onOpen={() => navigate(BACKUP_PATH)} />
        </div>
      </div>
      {/* WP-1 (R-1): also with no contacts yet (every new invite carries the card's name). */}
      {row.current && a.cardName !== undefined ? (
        <CardNameNote
          row={row}
          cardName={a.cardName}
          api={a.api}
          owner={a.owner}
          onUpdated={a.onCardUpdated}
        />
      ) : null}
      {machineNamed(row) && !renaming ? <NameNudge row={row} onRename={startRename} /> : null}
      {renaming ? (
        <RenameEditor
          row={row}
          api={a.api}
          owner={a.owner}
          {...(row.current && a.cardName !== undefined ? { cardName: a.cardName } : {})}
          onDone={stopRename}
          onCancel={stopRename}
          onChanged={a.onChanged}
          onRenamed={a.onRenamed}
        />
      ) : (
        <div className="ag-foot">
          <div className="ag-actions">
            {noApp ? (
              <Button
                variant="secondary"
                size="sm"
                icon="ai-app"
                onClick={() => a.onAppsElsewhere(row)}
              >
                {S.connectAiApp}
              </Button>
            ) : (
              <>
                {row.current ? null : (
                  <Button variant="secondary" size="sm" onClick={() => a.onSwitch(row)}>
                    {S.switch}
                  </Button>
                )}
                <Button
                  variant={row.current ? 'secondary' : 'ghost'}
                  size="sm"
                  icon="user-plus"
                  onClick={() => a.onInvite(row)}
                >
                  {S.inviteSomeone}
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={startRename}>
              <PencilIcon />
              {S.rename}
            </Button>
            {noApp ? null : (
              <Button
                variant="ghost"
                size="sm"
                icon={state === 'paused' ? 'play' : 'pause'}
                onClick={() => (state === 'paused' ? a.onResume(row) : a.onPause(row))}
              >
                {state === 'paused' ? S.resume : S.pause}
              </Button>
            )}
          </div>
          <div className="ag-actions ag-actions-end">
            {noApp ? (
              <Button variant="ghost" size="sm" onClick={() => a.onRemove(row)}>
                {S.remove}
              </Button>
            ) : (
              <>
                {row.current ? (
                  <>
                    <a className="al-btn al-btn-ghost al-btn-sm" href={RULES_PATH}>
                      {S.rules}
                    </a>
                    <a className="al-btn al-btn-ghost al-btn-sm" href={ACTIVITY_PATH}>
                      {S.activity}
                    </a>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={open === 'backup'}
                    onClick={() => toggle('backup')}
                  >
                    <ShieldCheckIcon />
                    {S.backUp}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  icon="ellipsis"
                  aria-label={S.moreLabel}
                  aria-expanded={more}
                  onClick={() => setMore(!more)}
                >
                  {S.more}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {more && !noApp ? (
        <div className="ag-actions ag-more al-expand" data-more>
          {row.current ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={open === 'backup'}
              onClick={() => toggle('backup')}
            >
              <ShieldCheckIcon />
              {S.backUp}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            icon="ai-app"
            aria-expanded={open === 'apps'}
            onClick={() => toggle('apps')}
          >
            {S.aiApps}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => a.onRemove(row)}>
            {S.remove}
          </Button>
        </div>
      ) : null}
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
