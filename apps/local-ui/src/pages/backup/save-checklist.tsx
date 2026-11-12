// WP-R4 (§6.3): the three things to do after a kit is saved. Done turns on only when all three are
// ticked. The code stays in the parent's state; this component only passes it to Print (an in-memory
// sheet, printSheet) and Copy. Nothing here writes to disk, storage or the URL.
import { Button, Icon } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import type { ApiClient } from '../../api/client.js';
import { printSheet, type SheetFacts } from './print-sheet.js';
import { BACKUP_STRINGS as S } from './strings.js';

export const BACKUP_REVEAL_PATH = '/api/ui/backup/reveal';
/**
 * Check my kit's route (WP-R1/R3). Not registered yet: until it is, the check step is disabled with a
 * plain note and the page cannot be finished. Set it when the route lands (or pass `checkPath`).
 */
export const BACKUP_CHECK_PATH: string | undefined = undefined;

export interface SaveChecklistProps {
  readonly api: ApiClient;
  readonly facts: SheetFacts;
  readonly check?: string | undefined;
  readonly checkPath?: string | undefined;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onDone: () => void;
  /** Tests inject the window opener. */
  readonly open?: Parameters<typeof printSheet>[1] | undefined;
}

type CheckState = 'idle' | 'working' | 'ok' | 'wrong' | 'failed';

export function SaveChecklist({
  api,
  facts,
  check,
  checkPath = BACKUP_CHECK_PATH,
  copied,
  onCopy,
  onDone,
  open,
}: SaveChecklistProps): ReactElement {
  const [moved, setMoved] = useState(false);
  const [written, setWritten] = useState(false);
  const [checked, setChecked] = useState<CheckState>('idle');
  const [note, setNote] = useState<string | undefined>(undefined);
  const canCheck = checkPath !== undefined && check !== undefined;

  const reveal = (): void => {
    setNote(undefined);
    void api.post(BACKUP_REVEAL_PATH).then(
      (r) => {
        if (r.kind !== 'ok') setNote(S.showFailed);
      },
      () => setNote(S.showFailed),
    );
  };
  const print = (): void => {
    setNote(undefined);
    if (!printSheet(facts, open)) setNote(S.printBlocked);
  };
  const runCheck = (): void => {
    if (checkPath === undefined || check === undefined) return;
    setChecked('working');
    setNote(undefined);
    void api.post(checkPath, { check }).then(
      (r) => {
        if (r.kind === 'ok') setChecked('ok');
        else if (r.kind === 'error' && (r.status === 400 || r.status === 403 || r.status === 409)) {
          setChecked('wrong');
        } else setChecked('failed');
      },
      () => setChecked('failed'),
    );
  };

  const allTicked = moved && written && checked === 'ok';
  const checkNote =
    checked === 'ok'
      ? S.checkOk
      : checked === 'wrong'
        ? S.checkWrong
        : checked === 'failed'
          ? S.checkFailed
          : canCheck
            ? undefined
            : S.checkUnavailable;

  return (
    <section className="bk-checklist" aria-labelledby="bk-checklist-h">
      <h3 id="bk-checklist-h" className="al-text-label">
        {S.checklistTitle}
      </h3>
      <ol className="bk-steps">
        <li className="bk-step" data-step="move">
          <label className="bk-tick">
            <input
              type="checkbox"
              checked={moved}
              onChange={(e) => setMoved(e.currentTarget.checked)}
              aria-label={S.tickLabel(S.stepMove)}
            />
            <span className="al-text-body">{S.stepMove}</span>
          </label>
          <Button variant="secondary" size="sm" icon="folder" onClick={reveal}>
            {S.showInFinder}
          </Button>
        </li>
        <li className="bk-step" data-step="write">
          <label className="bk-tick">
            <input
              type="checkbox"
              checked={written}
              onChange={(e) => setWritten(e.currentTarget.checked)}
              aria-label={S.tickLabel(S.stepWrite)}
            />
            <span className="al-text-body">{S.stepWrite}</span>
          </label>
          <span className="bk-step-acts">
            <Button variant="secondary" size="sm" icon="printer" onClick={print}>
              {S.print}
            </Button>
            <Button variant="secondary" size="sm" icon="copy" onClick={onCopy}>
              {copied ? S.copied : S.copy}
            </Button>
          </span>
        </li>
        <li className="bk-step" data-step="check">
          <label className="bk-tick">
            <input
              type="checkbox"
              checked={checked === 'ok'}
              disabled
              readOnly
              aria-label={S.tickLabel(S.stepCheck)}
            />
            <span className="al-text-body">{S.stepCheck}</span>
          </label>
          <Button
            variant="secondary"
            size="sm"
            icon="check"
            disabled={!canCheck || checked === 'working' || checked === 'ok'}
            onClick={runCheck}
          >
            {checked === 'working' ? S.checking : S.checkNow}
          </Button>
        </li>
      </ol>
      {checkNote === undefined ? null : (
        <p
          className={`al-text-body-sm ${checked === 'ok' ? 'bk-ok' : checked === 'idle' ? 'al-muted' : 'bk-error'}`}
          role={checked === 'idle' ? undefined : 'status'}
          data-check-note=""
        >
          {checked === 'ok' ? <Icon name="check" size={14} /> : null} {checkNote}
        </p>
      )}
      {note === undefined ? null : (
        <p className="al-text-body-sm bk-error" role="alert">
          {note}
        </p>
      )}
      <div className="bk-actions">
        <Button variant="primary" disabled={!allTicked} onClick={onDone}>
          {S.finish}
        </Button>
        {allTicked ? null : <p className="al-text-caption al-muted">{S.doneEnableHint}</p>}
      </div>
    </section>
  );
}
