// Files (M1-11c-a3; d1 Local-files with DESIGN-ADJ-1 FI-3; 04 §4; 06 §3; 11 §5, §6.2; D-99, D-118,
// D-119; UX audit 4b, 10a).
//
// The folders the AI may send files from, each with its real location when that differs, and one
// next action: "Allow a folder". Adding or removing a folder is reviewed by the local server first
// (04 §4: realpath, links followed, protected and too-broad folders refused, D-99), which answers the
// folder that would be signed and every warning. The confirm screen shows that real folder, lists
// each warning in plain words with its own tick, and stays off until every one is ticked (D-119).
// Then the owner's passkey gesture or owner code goes to the local server, which signs; the browser
// never signs. A `?folder=` link (from the AI's "allow a folder" step) only fills the field.
//
// Three tabs (MSG-FILES-IO-f): Received and Sent (io.tsx, read-only) and this page as Send folders.
// Out of scope here: inbox folder and link expiry (UX audit 4b "More options"), and Storage
// (folded in by D-120 later).
import { Banner, Button, EmptyState, Icon, TextField, UnderTheHood } from '@4thtech-io/ui';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { EARLIER_OWNER_CODE_HINT, PAGE_TITLES } from '../../strings.js';
import {
  COMMIT_PATH,
  LIST_PATH,
  parseList,
  parseReview,
  parseReviewProblem,
  reviewPath,
  type FolderRow,
  type Review,
  type ReviewProblem,
} from './data.js';
import {
  createFilesApi,
  passkeyPresence,
  passkeysAvailable,
  type CommitOutcome,
  type FilesApi,
  type PasskeyInfo,
} from './files-api.js';
import { FilesSkeleton, FilesTabs, ReceivedPanel, SentPanel, type FilesTab } from './io.js';
import {
  FILES_IO_STRINGS as IO,
  FILES_STRINGS as S,
  WARNING_TEXT,
  opensAt,
  refusalText,
  removeLabel,
  waitText,
} from './strings.js';
import './files.css';

type ListState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'not_set_up' }
  | { readonly phase: 'error' }
  | {
      readonly phase: 'ok';
      readonly folders: readonly FolderRow[];
      readonly version: number | null;
    };

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'enter'; readonly checking: boolean; readonly problem?: string }
  | { readonly kind: 'confirm'; readonly review: Review };

interface Notice {
  readonly tone: 'success' | 'warning' | 'danger' | 'info';
  readonly text: string;
  readonly rules?: boolean;
  /** L-1: the list is out of date; the banner offers to reload it. */
  readonly reload?: boolean;
}

function problemText(problem: ReviewProblem): Notice {
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

function outcomeText(outcome: CommitOutcome, change: 'add' | 'remove'): Notice {
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
const RETRYABLE: ReadonlySet<CommitOutcome['kind']> = new Set([
  'presence_rejected',
  'presence_required',
  'wait',
  'busy',
  'offline',
]);

function NoticeBanner({ notice }: { notice: Notice }): ReactElement {
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

interface ConfirmProps {
  readonly review: Review;
  readonly passkey: PasskeyInfo | undefined;
  readonly sending: boolean;
  readonly notice: Notice | undefined;
  readonly onConfirm: (acknowledged: readonly string[], code: string | undefined) => void;
  readonly onCancel: () => void;
}

function Confirm({
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
        <TextField
          name="owner-code"
          type="password"
          autoComplete="off"
          label={S.ownerCode}
          hint={`${S.ownerCodeHint} ${EARLIER_OWNER_CODE_HINT}`}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={sending}
          mono
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

export interface FilesPageProps {
  /** The tab to open on; by default Received, or Send folders for a `?folder=` link. */
  initialTab?: FilesTab;
  /** For tests: the fetch and session token; the page's own same-origin calls by default. */
  readonly fetch?: typeof fetch;
  readonly token?: string;
}

const prefill = (): string => {
  try {
    const value = new URLSearchParams(window.location.search).get('folder');
    return value !== null && value.length <= 4096 ? value : '';
  } catch {
    return '';
  }
};

/** Send folders: the folders the AI may send files from (today's page, unchanged). */
function SendFolders({ api }: { readonly api: FilesApi }): ReactElement {
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  const [initial] = useState(prefill);
  const [step, setStep] = useState<Step>(
    initial.length > 0 ? { kind: 'enter', checking: false } : { kind: 'idle' },
  );
  const [typed, setTyped] = useState(initial);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [passkey, setPasskey] = useState<PasskeyInfo | undefined>(undefined);
  const [sending, setSending] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const answer = await api.get(LIST_PATH);
    if (answer.kind !== 'answer') return setList({ phase: 'error' });
    if (answer.status === 409) return setList({ phase: 'not_set_up' });
    const parsed = answer.status === 200 ? parseList(answer.json) : undefined;
    setList(parsed === undefined ? { phase: 'error' } : { phase: 'ok', ...parsed });
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const startReview = async (change: 'add' | 'remove', path: string): Promise<void> => {
    setNotice(undefined);
    // L-1: the review names the version this list was read at; without one, nothing can change.
    const version = list.phase === 'ok' ? list.version : null;
    if (version === null) {
      if (change === 'add') setStep({ kind: 'enter', checking: false, problem: S.rulesUnreadable });
      setNotice({ tone: 'warning', text: S.rulesUnreadable });
      return;
    }
    if (change === 'add') setStep({ kind: 'enter', checking: true });
    const answer = await api.get(reviewPath(change, path, version));
    const review =
      answer.kind === 'answer' && answer.status === 200 ? parseReview(answer.json) : undefined;
    if (review === undefined) {
      const problem: Notice =
        answer.kind === 'offline'
          ? { tone: 'warning', text: S.offline }
          : problemText(parseReviewProblem(answer.status, answer.json));
      if (change === 'add') {
        setStep(
          problem.rules === true
            ? { kind: 'enter', checking: false }
            : { kind: 'enter', checking: false, problem: problem.text },
        );
      }
      if (change === 'remove') setStep({ kind: 'idle' });
      setNotice(problem);
      // The rules changed since this list was read: read it again, so trying again works.
      if (problem.reload === true) await load();
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
        const gesture = await passkeyPresence(passkey);
        if (gesture.kind !== 'ok') {
          setNotice({ tone: 'info', text: S.passkeyNotUsed });
          return;
        }
        outcome = await api.commit(
          COMMIT_PATH,
          { review: review.review, acknowledged: [...acknowledged] },
          { kind: 'passkey', body: gesture.body },
        );
      } else {
        outcome = await api.commit(
          COMMIT_PATH,
          { review: review.review, acknowledged: [...acknowledged] },
          { kind: 'code', code: code ?? '' },
        );
      }
      const shown = outcomeText(outcome, review.change);
      setNotice(shown);
      if (outcome.kind === 'applied') {
        setStep({ kind: 'idle' });
        setTyped('');
        await load();
      } else if (!RETRYABLE.has(outcome.kind)) {
        // The review was used up: start again from the folder.
        setStep(review.change === 'add' ? { kind: 'enter', checking: false } : { kind: 'idle' });
      }
    } finally {
      setSending(false);
    }
  };

  const cancel = (): void => {
    setStep({ kind: 'idle' });
    setNotice(undefined);
  };

  let content: ReactElement;
  if (list.phase === 'loading') {
    content = <FilesSkeleton word={S.loading} />;
  } else if (list.phase === 'not_set_up') {
    content = <Banner tone="info">{S.notSetUp}</Banner>;
  } else if (list.phase === 'error') {
    content = <Banner tone="warning">{S.unavailable}</Banner>;
  } else {
    content = (
      <>
        {list.folders.length === 0 && step.kind === 'idle' ? (
          <EmptyState
            icon="folder"
            title={S.emptyTitle}
            prompt={S.emptyPrompt}
            action={
              <Button
                variant="primary"
                icon="plus"
                onClick={() => setStep({ kind: 'enter', checking: false })}
              >
                {S.allowFolder}
              </Button>
            }
          />
        ) : null}
        {list.folders.length > 0 ? (
          <ul className="fl-list">
            {list.folders.map((row) => (
              <li key={row.path} className="fl-row">
                <Icon name="folder" size={16} />
                <div className="fl-row-main">
                  <span className="al-text-code">{row.path}</span>
                  {row.resolved === null ? (
                    <span className="al-text-caption al-muted">{S.folderMissing}</span>
                  ) : row.resolved !== row.path ? (
                    <span className="al-text-caption al-muted">{opensAt(row.resolved)}</span>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="x"
                  aria-label={removeLabel(row.path)}
                  title={removeLabel(row.path)}
                  disabled={step.kind !== 'idle'}
                  onClick={() => void startReview('remove', row.path)}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {step.kind === 'idle' && list.folders.length > 0 ? (
          <Button
            block
            icon="plus"
            onClick={() => {
              setNotice(undefined);
              setStep({ kind: 'enter', checking: false });
            }}
          >
            {S.allowFolder}
          </Button>
        ) : null}
        {step.kind === 'enter' ? (
          <form
            className="fl-enter"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.length > 0 && !step.checking) void startReview('add', typed);
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
              <Button
                type="submit"
                variant="primary"
                disabled={typed.length === 0 || step.checking}
              >
                {step.checking ? S.checking : S.check}
              </Button>
              <Button variant="ghost" onClick={cancel}>
                {S.cancel}
              </Button>
            </div>
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
        {step.kind !== 'confirm' && notice !== undefined && step.kind !== 'enter' ? (
          <NoticeBanner notice={notice} />
        ) : null}
        {step.kind === 'enter' && notice?.rules === true ? <NoticeBanner notice={notice} /> : null}
        <p className="al-text-caption al-muted">{S.everyChange}</p>
      </>
    );
  }

  return (
    <section className="fl-panel" aria-labelledby="fl-folders">
      <h2 id="fl-folders" className="al-text-label al-muted">
        {S.foldersLabel}
      </h2>
      {content}
      {list.phase === 'ok' ? (
        <UnderTheHood
          fields={[{ kind: 'count', label: IO.hoodFolders, value: String(list.folders.length) }]}
        />
      ) : null}
    </section>
  );
}

export function FilesPage({
  fetch: givenFetch,
  token,
  initialTab,
}: FilesPageProps = {}): ReactElement {
  const api: FilesApi = useMemo(
    () =>
      createFilesApi({
        ...(givenFetch === undefined ? {} : { fetch: givenFetch }),
        ...(token === undefined ? {} : { token }),
      }),
    [givenFetch, token],
  );
  const [tab, setTab] = useState<FilesTab>(
    () => initialTab ?? (prefill().length > 0 ? 'folders' : 'received'),
  );
  const [waiting, setWaiting] = useState<Readonly<Partial<Record<FilesTab, number>>>>({});
  const onReceived = useCallback((n: number) => setWaiting((w) => ({ ...w, received: n })), []);
  const onSent = useCallback((n: number) => setWaiting((w) => ({ ...w, sent: n })), []);
  return (
    <div className="fl-page">
      <h1 className="al-text-title-1">{PAGE_TITLES.files}</h1>
      <p className="al-text-body-sm al-muted">{IO.explainer}</p>
      <FilesTabs tab={tab} onTab={setTab} counts={waiting} />
      <div id="fl-tabpanel" role="tabpanel" aria-labelledby={`fl-tab-${tab}`}>
        {tab === 'received' ? (
          <ReceivedPanel get={api.get} reveal={api.reveal} onWaiting={onReceived} />
        ) : null}
        {tab === 'sent' ? <SentPanel get={api.get} onWaiting={onSent} /> : null}
        {tab === 'folders' ? <SendFolders api={api} /> : null}
      </div>
    </div>
  );
}
