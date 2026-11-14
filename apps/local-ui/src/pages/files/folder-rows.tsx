// The Send and Inbox rows (D-152; 08 §1; b11 §8 rows 24 and 25: no new design). Reused by Home's Files
// panel and by Settings › Files: the folder card look of Settings (`fl-row`, path, chip, Show in
// Finder). Both rows show only the owner's own two folders (home as `~`), never a file name.
// Show in Finder sends nothing but an empty POST (api/reveal-folder.ts); the server finds the folder.
import { Button, Icon, InlineError, StatusChip } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { RevealApi } from '../../api/reveal-folder.js';
import { FILES_COPY as C, computerWord, showInLabel } from './folders-copy.js';
import { FILES_IO_STRINGS as IO } from './io-strings.js';
import type { FilesSummary } from './folders-summary.js';
import './files.css';

type Which = 'send' | 'inbox';

export function RevealButton({
  which,
  reveal,
}: {
  readonly which: Which;
  readonly reveal: RevealApi;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const click = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    const outcome = await (which === 'send' ? reveal.revealSendFolder() : reveal.revealInbox());
    if (!alive.current) return;
    setBusy(false);
    setProblem(
      outcome === 'shown'
        ? undefined
        : which === 'inbox' && outcome === 'not_found'
          ? IO.revealUnavailable
          : IO.revealFailed,
    );
  };
  return (
    <div className="fl-row-actions">
      <Button size="sm" icon="folder" disabled={busy} onClick={() => void click()}>
        {showInLabel()}
      </Button>
      {problem === undefined ? null : <InlineError>{problem}</InlineError>}
    </div>
  );
}

export interface FolderRowsProps {
  readonly summary: FilesSummary;
  readonly reveal: RevealApi;
  /** Show the Inbox row's line "{n} new" (Home). */
  readonly showNew?: boolean;
  /** FILES-ONB-1: an action inside the Send row (the Files step's Choose another folder). */
  readonly sendAction?: ReactNode;
}

/** Send, then Inbox. When the Send folder is not allowed the caller shows the action instead. */
export function FolderRows({
  summary,
  reveal,
  showNew = false,
  sendAction,
}: FolderRowsProps): ReactElement {
  const computer = computerWord();
  const { send } = summary;
  const chip =
    send.state === 'allowed' ? (
      <StatusChip status="approved">{C.chipAllowed}</StatusChip>
    ) : send.state === 'not_found' ? (
      <StatusChip status="flagged">{C.chipNotFound(computer)}</StatusChip>
    ) : (
      <StatusChip status="needs-setup">{C.chipNotAllowed}</StatusChip>
    );
  return (
    <ul className="fl-list" data-files-rows>
      <li className="fl-row" data-row="send">
        <Icon name="folder" size={16} />
        <div className="fl-row-main">
          <span className="al-text-label">{C.sendLabel}</span>
          {send.folder === undefined ? null : <span className="al-text-code">{send.folder}</span>}
          <span className="al-text-caption al-muted">{C.sendLine}</span>
          <span>{chip}</span>
          {sendAction}
        </div>
        {send.state === 'allowed' ? <RevealButton which="send" reveal={reveal} /> : null}
      </li>
      <li className="fl-row" data-row="inbox">
        <Icon name="inbox" size={16} />
        <div className="fl-row-main">
          <span className="al-text-label">{C.inboxLabel}</span>
          {summary.inbox === undefined ? null : (
            <span className="al-text-code">{summary.inbox}</span>
          )}
          <span className="al-text-caption al-muted">{C.inboxLine}</span>
          {showNew && summary.newCount > 0 ? (
            <span className="al-text-label" data-inbox-new>
              {C.inboxNew(summary.newCount)}
            </span>
          ) : null}
        </div>
        {summary.inbox === undefined ? null : <RevealButton which="inbox" reveal={reveal} />}
      </li>
    </ul>
  );
}
