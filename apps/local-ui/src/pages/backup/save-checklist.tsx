// WP-R4 (§6.3): the three things to do after a kit is saved. Done turns on only when all three are
// ticked. The code stays in the parent's state; this component only passes it to Print (an in-memory
// sheet, printSheet) and Copy. Nothing here writes to disk, storage or the URL.
import { Button, Icon, InlineError } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import type { ApiClient } from '../../api/client.js';
import { createRestoreApi, RESTORE_BASE } from '../restore/api.js';
import { printSheet, type SheetFacts } from './print-sheet.js';
import { BACKUP_STRINGS as S } from './strings.js';

export const BACKUP_REVEAL_PATH = '/api/ui/backup/reveal';
/**
 * Check my kit's route: R1's restore `check` (04 §2.3.3 "Check that my kit opens"). The export answer
 * carries `check`, a one-use handle the restore engine bound to this page session; the recovery code
 * goes as the body (never JSON, never a query) and the engine opens the kit read-only.
 */
export const BACKUP_CHECK_PATH = `${RESTORE_BASE}/check`;

/** What a check said: it opens, that code does not open it, or no answer. */
export type CheckOutcome = 'ok' | 'wrong' | 'failed';
/** Checks the just-saved kit by its handle with its code. Tests inject their own. */
export type CheckKit = (handle: string, code: string) => Promise<CheckOutcome>;

const WRONG: ReadonlySet<string> = new Set([
  'wrong_code',
  'damaged',
  'not_a_kit',
  'other_owner',
  'newer_version',
]);

/** The default check: through the restore wizard's own client, the code bytes wiped after. */
export const checkWithRestore: CheckKit = async (handle, code) => {
  const bytes = new TextEncoder().encode(code.replace(/-/g, ''));
  try {
    const r = await createRestoreApi().check(handle, bytes);
    if (r.kind === 'ok') return 'ok';
    return WRONG.has(r.problem) ? 'wrong' : 'failed';
  } catch {
    return 'failed';
  } finally {
    bytes.fill(0);
  }
};

export interface SaveChecklistProps {
  readonly api: ApiClient;
  readonly facts: SheetFacts;
  /** The export's one-use Check handle; without one the check step is disabled with a note. */
  readonly check?: string | undefined;
  /** How the kit is checked (default: R1's restore check route); `null` turns the step off. */
  readonly checkKit?: CheckKit | null | undefined;
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
  checkKit = checkWithRestore,
  copied,
  onCopy,
  onDone,
  open,
}: SaveChecklistProps): ReactElement {
  const [moved, setMoved] = useState(false);
  const [written, setWritten] = useState(false);
  const [checked, setChecked] = useState<CheckState>('idle');
  const [note, setNote] = useState<string | undefined>(undefined);
  const canCheck = checkKit !== null && check !== undefined;

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
    if (checkKit === null || check === undefined) return;
    setChecked('working');
    setNote(undefined);
    void checkKit(check, facts.code).then(setChecked, () => setChecked('failed'));
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
      {note === undefined ? null : <InlineError>{note}</InlineError>}
      <div className="bk-actions">
        <Button variant="primary" disabled={!allTicked} onClick={onDone}>
          {S.finish}
        </Button>
        {allTicked ? null : <p className="al-text-caption al-muted">{S.doneEnableHint}</p>}
      </div>
    </section>
  );
}
