// FILES-HOME-PANEL (D-152; 08 §1 "Home Files panel"; 11 §5.7; b11 §8 row 25, no new design; I-4,
// I-5): Home's Files panel, below the people list. It replaces Home's separate Send folder banner:
// when the Send folder is not allowed, the banner's text and its one action, Allow Send folder, sit
// inside the panel (one place).
//
// - Reads only (GETs): the folder list, the received page's Inbox folder and "{n} new" (a count of
//   files saved since Files was last opened, never a name), and the sent page (empty state).
// - Send and Inbox rows, each with Show in Finder (Explorer / folder by OS), the folder paths with
//   home as `~`: the owner's own two folders only.
// - One line, **Manage folders** (Settings › Files, Send folders tab) and **Tips for {app}**: a fixed
//   tip per AI app (11 §5.7), never a status: the app cannot see what the AI app can do.
// - Collapsible; the state is remembered in `localStorage` under try/catch and works without it. It
//   is never collapsed while the Send folder is not allowed.
// - Allow Send folder asks the local server to set up the Send folder (`POST /api/ui/files/send-folder`,
//   a mark-kind route: no input, no presence, nothing signed) and opens Settings › Files with it
//   filled in and checked; the owner confirms there with Touch ID or the master code. Nothing signs
//   here (send-folder-banner.tsx holds the shared call).
import { Banner, Button, Icon, Surface } from '@4thtech-io/ui';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { createRevealApi, type RevealApi } from '../../api/reveal-folder.js';
import { navigate } from '../../router.js';
import { SEND_FOLDER_CHECK_KEY } from '../../strings.js';
import { FolderRows } from '../files/folder-rows.js';
import { FILES_COPY as C, appTip, computerWord, isKnownApp } from '../files/folders-copy.js';
import { loadFilesSummary, type FilesSummary, type Getter } from '../files/folders-summary.js';
import { filesLinkFor, type SendFolderApi } from './send-folder-banner.js';
import '../files/files.css';

/** localStorage key: the panel is collapsed (a per-viewer convenience; never required). */
export const FILES_PANEL_COLLAPSED_KEY = 'agentlink.home.files.collapsed';

function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(FILES_PANEL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) globalThis.localStorage?.setItem(FILES_PANEL_COLLAPSED_KEY, '1');
    else globalThis.localStorage?.removeItem(FILES_PANEL_COLLAPSED_KEY);
  } catch {
    // Not remembered; the toggle still works for this visit.
  }
}

export const MANAGE_FOLDERS_PATH = '/settings/files?tab=folders';

export interface FilesPanelProps {
  /** The page's GET helper (files-api `get`). */
  readonly get: Getter;
  readonly reveal?: RevealApi;
  /** Allow Send folder: the same call and hand-over as the banner it replaces. */
  readonly sendFolder: SendFolderApi;
  /** The AI app's name for the fixed tip ("Claude Code"); undefined: the unknown-app tip. */
  readonly appName?: string | undefined;
  /** Changes when the open ID changes, so everything is read again. */
  readonly agentKey?: string;
  readonly go?: (to: string) => void;
}

export function FilesPanel({
  get,
  reveal,
  sendFolder,
  appName,
  agentKey,
  go = navigate,
}: FilesPanelProps): ReactElement | null {
  const [summary, setSummary] = useState<FilesSummary | undefined>(undefined);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [tips, setTips] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'working' | 'failed'>('idle');
  const [revealApi] = useState(() => reveal ?? createRevealApi());

  useEffect(() => {
    let live = true;
    setSummary(undefined);
    setPhase('idle');
    void loadFilesSummary(get).then((result) => {
      if (live && result.kind === 'ok') setSummary(result.summary);
    });
    return () => {
      live = false;
    };
  }, [get, agentKey]);

  const allow = useCallback(async (): Promise<void> => {
    setPhase('working');
    const folder = await sendFolder.prepare();
    if (folder === undefined) {
      setPhase('failed');
      return;
    }
    // IR-1 L-2: Settings › Files checks at once only for the folder set up here (one time, this tab).
    try {
      sessionStorage.setItem(SEND_FOLDER_CHECK_KEY, folder);
    } catch {
      // Without it, Files only fills the field.
    }
    go(filesLinkFor(folder));
  }, [sendFolder, go]);

  if (summary === undefined) return null;
  const notAllowed = summary.send.state === 'not_allowed';
  // Never collapsed while the Send folder is not allowed: the action must stay in view.
  const closed = collapsed && !notAllowed;
  const known = isKnownApp(appName);
  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(next);
  };

  return (
    <Surface as="section" className="hm-c fl-panel" aria-labelledby="hm-files-h" data-files-panel>
      <div className="fl-row">
        <h2 id="hm-files-h" className="hm-kicker al-text-label fl-row-main">
          {C.panelTitle}
        </h2>
        {notAllowed ? null : (
          <Button
            variant="ghost"
            size="sm"
            icon={closed ? 'chevron-right' : 'chevron-down'}
            aria-expanded={!closed}
            aria-controls="hm-files-body"
            aria-label={closed ? C.expand : C.collapse}
            title={closed ? C.expand : C.collapse}
            onClick={toggle}
          />
        )}
      </div>
      {closed ? null : (
        <div id="hm-files-body" className="fl-enter">
          {notAllowed ? (
            phase === 'failed' ? (
              <Banner
                tone="warning"
                compact
                action={
                  <a className="al-btn al-btn-secondary al-btn-sm" href="/settings/files">
                    Open Files
                  </a>
                }
              >
                {C.allowFailed}
              </Banner>
            ) : (
              <Banner
                tone="info"
                icon="folder"
                compact
                action={
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={phase === 'working'}
                    onClick={() => void allow()}
                  >
                    {phase === 'working' ? C.working : C.allowSendFolder}
                  </Button>
                }
              >
                {C.noFolder}
              </Banner>
            )
          ) : (
            <>
              <p className="al-text-body-sm al-muted">{C.oneLineShort}</p>
              {summary.empty && summary.send.state === 'allowed' ? (
                <p className="al-text-body-sm" data-files-empty>
                  {C.panelEmpty}
                </p>
              ) : null}
              <FolderRows summary={summary} reveal={revealApi} showNew />
              <div className="fl-actions">
                <a className="al-btn al-btn-secondary al-btn-sm" href={MANAGE_FOLDERS_PATH}>
                  {C.manageFolders}
                </a>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="info"
                  aria-expanded={tips}
                  aria-controls="hm-files-tip"
                  onClick={() => setTips((v) => !v)}
                >
                  {known ? C.tipsFor(appName) : C.tipsForUnknown}
                </Button>
              </div>
              {tips ? (
                <p id="hm-files-tip" className="al-text-body-sm al-muted" data-app-tip>
                  <Icon name="info" size={14} /> {appTip(appName, computerWord())}
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
    </Surface>
  );
}
