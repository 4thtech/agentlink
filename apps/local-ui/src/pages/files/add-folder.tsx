// The add-a-folder review and confirm of Settings › Files (M1-11c-a3; 04 §4; D-99, D-119), shared
// with Get started's Files step (FILES-ONB-1, D-152; 08 §1 "Choose another folder"). One flow, one
// policy-changing path: the local server reviews the typed folder (realpath, links followed,
// protected and too-broad folders refused) and answers the real folder and every warning; the
// confirm lists each warning with its own tick and stays off until every one is ticked; then the
// owner's passkey or master code goes to the local server, which signs (`POST /api/ui/files/folders`).
// The browser never signs. In the desktop app's window no passkey is offered (files-api
// `passkeysAvailable`, presence/webauthn-here.ts): the master code only, never WebAuthn.
//
// `Confirm` and the notice helpers moved here unchanged from files/index.tsx. FILES-FOLDER-PICKER:
// the add flow itself is folder-chooser.tsx (the native dialog in the app, the path field in a
// browser), shared by Settings › Files, the Files step and Home's Files panel; `Confirm` also
// confirms a new Inbox folder.
import { Banner, Button, Icon } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import { EARLIER_OWNER_CODE_HINT, HOLDS_FILES_LINE } from '../../strings.js';
import { BackupCodeField } from '../first-run/backup-code.js';
import type { Review, ReviewProblem } from './data.js';
import type { CommitOutcome, PasskeyInfo } from './files-api.js';
import { FILES_STRINGS as S, WARNING_TEXT, refusalText, waitText } from './strings.js';
import { PICKER_COPY as P } from './folders-copy.js';

export interface Notice {
  readonly tone: 'success' | 'warning' | 'danger' | 'info';
  readonly text: string;
  readonly rules?: boolean;
  /** L-1: the list is out of date; the banner offers to reload it. */
  readonly reload?: boolean;
}

export function problemText(problem: ReviewProblem): Notice {
  switch (problem.kind) {
    case 'folder':
      return { tone: 'warning', text: refusalText(problem.reason, problem.protectedFolder) };
    case 'rules_unreadable':
      return { tone: 'warning', text: S.rulesUnreadable };
    case 'receipts_question':
      return { tone: 'info', text: S.receiptsQuestion, rules: true };
    case 'changed':
      return { tone: 'warning', text: S.changed };
    case 'stale':
      return { tone: 'warning', text: S.stale, reload: true };
    case 'not_set_up':
      return { tone: 'info', text: S.notSetUp };
    case 'unavailable':
      return { tone: 'warning', text: S.unavailable };
    default:
      return { tone: 'warning', text: S.failed };
  }
}

export function outcomeText(outcome: CommitOutcome, change: 'add' | 'remove' | 'inbox'): Notice {
  switch (outcome.kind) {
    case 'applied':
      return outcome.confirmed
        ? {
            tone: 'success',
            text: change === 'add' ? S.added : change === 'inbox' ? P.inboxChanged : S.removed,
          }
        : { tone: 'warning', text: S.notConfirmed };
    case 'wait':
      return { tone: 'warning', text: waitText(outcome.seconds) };
    case 'presence_rejected':
      return { tone: 'warning', text: S.presenceRejected };
    case 'presence_required':
      return { tone: 'warning', text: S.presenceRequired };
    case 'busy':
      return { tone: 'info', text: S.busy };
    case 'changed':
      return { tone: 'warning', text: S.changed };
    case 'expired':
      return { tone: 'warning', text: S.expired };
    case 'refused':
      return { tone: 'warning', text: S.refused };
    case 'not_set_up':
      return { tone: 'info', text: S.notSetUp };
    case 'session_expired':
      return { tone: 'warning', text: S.sessionExpired };
    case 'offline':
      return { tone: 'warning', text: S.offline };
    default:
      return { tone: 'warning', text: S.failed };
  }
}

/** The answers after which the same review can be confirmed again (nothing was used up). */
export const RETRYABLE: ReadonlySet<CommitOutcome['kind']> = new Set([
  'presence_rejected',
  'presence_required',
  'wait',
  'busy',
  'offline',
]);

export function NoticeBanner({ notice }: { notice: Notice }): ReactElement {
  return (
    <Banner
      tone={notice.tone}
      action={
        notice.rules === true ? (
          <a className="al-btn al-btn-secondary al-btn-sm" href="/settings/rules">
            {S.openRules}
          </a>
        ) : undefined
      }
    >
      {notice.text}
    </Banner>
  );
}

export interface ConfirmProps {
  readonly review: Review;
  readonly passkey: PasskeyInfo | undefined;
  readonly sending: boolean;
  readonly notice: Notice | undefined;
  readonly onConfirm: (acknowledged: readonly string[], code: string | undefined) => void;
  readonly onCancel: () => void;
}

export function Confirm({
  review,
  passkey,
  sending,
  notice,
  onConfirm,
  onCancel,
}: ConfirmProps): ReactElement {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [useCode, setUseCode] = useState(passkey === undefined);
  const [code, setCode] = useState('');
  const add = review.change === 'add';
  const inbox = review.change === 'inbox';
  const allTicked = review.warnings.every((w) => ticked.has(w));
  const ready = allTicked && !sending && (!useCode || code.length > 0);
  const toggle = (w: string): void => {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(w)) next.delete(w);
      else next.add(w);
      return next;
    });
  };
  return (
    <section className="fl-confirm" aria-labelledby="fl-confirm-title">
      <h2 id="fl-confirm-title" className="al-text-title-3">
        {inbox ? P.inboxConfirmTitle : add ? S.confirmAddTitle : S.confirmRemoveTitle}
      </h2>
      <p className="fl-folder al-text-code">
        <Icon name="folder" size={16} />
        <span>{review.folder}</span>
      </p>
      {add && review.elsewhere ? (
        <p className="al-text-body-sm al-muted">{S.elsewhere(review.typed)}</p>
      ) : null}
      <p className="al-text-body-sm">
        {inbox ? P.inboxConfirmBody : add ? S.confirmAddBody : S.confirmRemoveBody}
      </p>
      {add && review.holdsFiles ? (
        <p className="al-text-body-sm" data-holds-files>
          {HOLDS_FILES_LINE}
        </p>
      ) : null}
      {review.warnings.length > 0 ? (
        <fieldset className="fl-warnings">
          <legend className="al-text-body-sm">{S.warningsTitle}</legend>
          {review.warnings.map((w) => (
            <label key={w} className="al-check al-text-body">
              <input
                type="checkbox"
                checked={ticked.has(w)}
                onChange={() => toggle(w)}
                disabled={sending}
              />
              <span>{WARNING_TEXT[w] ?? S.failed}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {useCode ? (
        <BackupCodeField
          name="owner-code"
          label={S.ownerCode}
          hint={`${S.ownerCodeHint} ${EARLIER_OWNER_CODE_HINT}`}
          value={code}
          onValue={setCode}
          disabled={sending}
        />
      ) : (
        <p className="al-text-caption al-muted">{S.withPasskey}</p>
      )}
      {notice === undefined ? null : <NoticeBanner notice={notice} />}
      <div className="fl-actions">
        <Button
          variant="primary"
          disabled={!ready}
          onClick={() => {
            const given = useCode ? code : undefined;
            setCode('');
            onConfirm(review.warnings, given);
          }}
        >
          {sending ? S.sending : inbox ? P.inboxConfirm : add ? S.confirmAdd : S.confirmRemove}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={sending}>
          {S.cancel}
        </Button>
        {!useCode ? (
          <Button variant="ghost" onClick={() => setUseCode(true)} disabled={sending}>
            {S.useCode}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
