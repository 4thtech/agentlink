// The add-a-folder review and confirm of Settings › Files (M1-11c-a3; 04 §4; D-99, D-119), shared
// with Get started's Files step (FILES-ONB-1, D-152; 08 §1 "Choose another folder"). One flow, one
// policy-changing path: the local server reviews the typed folder (realpath, links followed,
// protected and too-broad folders refused) and answers the real folder and every warning; the
// confirm lists each warning with its own tick and stays off until every one is ticked; then the
// owner's passkey or master code goes to the local server, which signs (`POST /api/ui/files/folders`).
// The browser never signs. In the desktop app's window no passkey is offered (files-api
// `passkeysAvailable`, presence/webauthn-here.ts): the master code only, never WebAuthn.
//
// `Confirm` and the notice helpers moved here unchanged from files/index.tsx; `AddFolder` is the
// add half of that page's `SendFolders` (same calls, same order) for a screen that is not the
// folder list.
import { Banner, Button, Icon, TextField } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import { EARLIER_OWNER_CODE_HINT, HOLDS_FILES_LINE } from '../../strings.js';
import { BackupCodeField } from '../first-run/backup-code.js';
import {
  COMMIT_PATH,
  LIST_PATH,
  parseList,
  parseReview,
  parseReviewProblem,
  reviewPath,
  type Review,
  type ReviewProblem,
} from './data.js';
import {
  passkeyPresence,
  passkeysAvailable,
  type CommitOutcome,
  type FilesApi,
  type PasskeyInfo,
} from './files-api.js';
import { FILES_STRINGS as S, WARNING_TEXT, refusalText, waitText } from './strings.js';

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

export function outcomeText(outcome: CommitOutcome, change: 'add' | 'remove'): Notice {
  switch (outcome.kind) {
    case 'applied':
      return outcome.confirmed
        ? { tone: 'success', text: change === 'add' ? S.added : S.removed }
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
        {add ? S.confirmAddTitle : S.confirmRemoveTitle}
      </h2>
      <p className="fl-folder al-text-code">
        <Icon name="folder" size={16} />
        <span>{review.folder}</span>
      </p>
      {add && review.elsewhere ? (
        <p className="al-text-body-sm al-muted">{S.elsewhere(review.typed)}</p>
      ) : null}
      <p className="al-text-body-sm">{add ? S.confirmAddBody : S.confirmRemoveBody}</p>
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
          {sending ? S.sending : add ? S.confirmAdd : S.confirmRemove}
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

type AddStep =
  | { readonly kind: 'idle' }
  | { readonly kind: 'enter'; readonly checking: boolean; readonly problem?: string }
  | { readonly kind: 'confirm'; readonly review: Review };

export interface AddFolderProps {
  readonly api: FilesApi;
  /** The button that opens the field ("Choose another folder"). */
  readonly label: string;
  /** Open the field at once (Get started's Connect card "Change"). */
  readonly open?: boolean;
  /** A folder was added: the caller reads its folders again. */
  readonly onAdded?: () => void;
}

/** Add one allowed folder: the typed path, the server's review, the confirm with presence. */
export function AddFolder({ api, label, open = false, onAdded }: AddFolderProps): ReactElement {
  const [step, setStep] = useState<AddStep>(
    open ? { kind: 'enter', checking: false } : { kind: 'idle' },
  );
  const [typed, setTyped] = useState('');
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [passkey, setPasskey] = useState<PasskeyInfo | undefined>(undefined);
  const [sending, setSending] = useState(false);

  const startReview = async (path: string): Promise<void> => {
    setNotice(undefined);
    setStep({ kind: 'enter', checking: true });
    // L-1: the review names the version the folder list is read at; without one, nothing changes.
    const listed = await api.get(LIST_PATH);
    const version =
      listed.kind === 'answer' && listed.status === 200
        ? (parseList(listed.json)?.version ?? null)
        : null;
    if (version === null) {
      setStep({
        kind: 'enter',
        checking: false,
        problem: listed.kind === 'offline' ? S.offline : S.rulesUnreadable,
      });
      return;
    }
    const answer = await api.get(reviewPath('add', path, version));
    const review =
      answer.kind === 'answer' && answer.status === 200 ? parseReview(answer.json) : undefined;
    if (review === undefined || review.change !== 'add') {
      const problem: Notice =
        answer.kind === 'offline'
          ? { tone: 'warning', text: S.offline }
          : review !== undefined
            ? { tone: 'warning', text: S.failed }
            : problemText(parseReviewProblem(answer.status, answer.json));
      setStep(
        problem.rules === true
          ? { kind: 'enter', checking: false }
          : { kind: 'enter', checking: false, problem: problem.text },
      );
      setNotice(problem);
      return;
    }
    setPasskey(passkeysAvailable() ? await api.passkey() : undefined);
    setStep({ kind: 'confirm', review });
  };

  const confirm = async (
    review: Review,
    acknowledged: readonly string[],
    code: string | undefined,
  ): Promise<void> => {
    setSending(true);
    setNotice(undefined);
    try {
      let outcome: CommitOutcome;
      if (code === undefined && passkey !== undefined) {
        const chosen = passkeyPresence(passkey);
        if (chosen.kind !== 'ok') {
          setNotice({ tone: 'info', text: S.passkeyNotUsed });
          return;
        }
        let notUsed = false;
        outcome = await api.commit(
          COMMIT_PATH,
          { review: review.review, acknowledged: [...acknowledged] },
          {
            kind: 'passkey',
            gesture: async (publicKey) => {
              const body = await chosen.gesture(publicKey);
              if (body === undefined) notUsed = true;
              return body;
            },
          },
        );
        if (notUsed) {
          setNotice({ tone: 'info', text: S.passkeyNotUsed });
          return;
        }
      } else {
        outcome = await api.commit(
          COMMIT_PATH,
          { review: review.review, acknowledged: [...acknowledged] },
          { kind: 'code', code: code ?? '' },
        );
      }
      setNotice(outcomeText(outcome, 'add'));
      if (outcome.kind === 'applied') {
        setStep({ kind: 'idle' });
        setTyped('');
        onAdded?.();
      } else if (!RETRYABLE.has(outcome.kind)) {
        // The review was used up: start again from the folder.
        setStep({ kind: 'enter', checking: false });
      }
    } finally {
      setSending(false);
    }
  };

  const cancel = (): void => {
    setStep({ kind: 'idle' });
    setNotice(undefined);
  };

  return (
    <div className="fl-add" data-add-folder>
      {step.kind === 'idle' ? (
        <Button
          variant="secondary"
          size="sm"
          icon="plus"
          onClick={() => {
            setNotice(undefined);
            setStep({ kind: 'enter', checking: false });
          }}
        >
          {label}
        </Button>
      ) : null}
      {step.kind === 'enter' ? (
        <form
          className="fl-enter"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.length > 0 && !step.checking) void startReview(typed);
          }}
        >
          <TextField
            name="folder"
            label={S.folderField}
            {...(step.problem === undefined ? { hint: S.folderHint } : { error: step.problem })}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            mono
          />
          <div className="fl-actions">
            <Button type="submit" variant="primary" disabled={typed.length === 0 || step.checking}>
              {step.checking ? S.checking : S.check}
            </Button>
            <Button variant="ghost" onClick={cancel}>
              {S.cancel}
            </Button>
          </div>
          {notice?.rules === true ? <NoticeBanner notice={notice} /> : null}
        </form>
      ) : null}
      {step.kind === 'confirm' ? (
        <Confirm
          key={step.review.review}
          review={step.review}
          passkey={passkey}
          sending={sending}
          notice={notice}
          onConfirm={(acknowledged, code) => void confirm(step.review, acknowledged, code)}
          onCancel={cancel}
        />
      ) : null}
      {step.kind === 'idle' && notice !== undefined ? <NoticeBanner notice={notice} /> : null}
    </div>
  );
}
