// Files (M1-11c-a3; d1 Local-files with DESIGN-ADJ-1 FI-3; 04 §4; 06 §3; 11 §5, §6.2; D-99, D-118,
// D-119; UX audit 4b, 10a).
//
// The folders the AI may send files from, each with its real location when that differs, and one
// next action: "Allow a folder". Adding or removing a folder is reviewed by the local server first
// (04 §4: realpath, links followed, protected and too-broad folders refused, D-99), which answers the
// folder that would be signed and every warning. The confirm screen shows that real folder, lists
// each warning in plain words with its own tick, and stays off until every one is ticked (D-119).
// Then the owner's passkey gesture or master code goes to the local server, which signs; the browser
// never signs. A `?folder=` link (from the AI's "allow a folder" step) only fills the field;
// ATT-SENDFOLDER-FIX: with `check=1` (Home's Send folder banner) the field is also checked once, so
// the owner lands on the confirm step. Checking reads only; confirming still needs presence.
//
// Three tabs (MSG-FILES-IO-f): Received and Sent (io.tsx, read-only) and this page as Send folders.
// Out of scope here: inbox folder and link expiry (UX audit 4b "More options"), and Storage
// (folded in by D-120 later).
import { Banner, Button, EmptyState, Icon, TextField } from '@4thtech-io/ui';
import { UnderTheHood } from '../../lazy/hood.js';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { createApiClient } from '../../api/client.js';
import { createRevealApi } from '../../api/reveal-folder.js';
import { useFileMarks } from '../moving/use-file-marks.js';
import { PAGE_TITLES, SEND_FOLDER_CHECK_KEY } from '../../strings.js';
import {
  COMMIT_PATH,
  LIST_PATH,
  parseList,
  parseReview,
  parseReviewProblem,
  reviewPath,
  type FolderRow,
  type Review,
} from './data.js';
import {
  createFilesApi,
  passkeyPresence,
  passkeysAvailable,
  type CommitOutcome,
  type FilesApi,
  type PasskeyInfo,
} from './files-api.js';
import { createSaveApi } from '../inbox/save-api.js';
import {
  Confirm,
  NoticeBanner,
  RETRYABLE,
  outcomeText,
  problemText,
  type Notice,
} from './add-folder.js';
import { RevealButton } from './folder-rows.js';
import { FILES_COPY as C, appTip, computerWord } from './folders-copy.js';
import { RECEIVED_PATH, listPath, parseInboxFolder } from './io-api.js';
import { markSeen } from './folders-summary.js';
import { useAppName } from './use-app-name.js';
import { FilesSkeleton, FilesTabs, ReceivedPanel, SentPanel, type FilesTab } from './io.js';
import { FILES_IO_STRINGS as IO, FILES_STRINGS as S, opensAt, removeLabel } from './strings.js';
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

/** FILES-HOME-PANEL: Home's "Manage folders" opens this page on the Send folders tab. */
const wantsFolders = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).get('tab') === 'folders';
  } catch {
    return false;
  }
};

/**
 * ATT-SENDFOLDER-FIX: a `?folder=...&check=1` link checks the filled-in folder once, only when Home's
 * banner set it (IR-1 L-2: the one-time SEND_FOLDER_CHECK_KEY names this folder; it is removed
 * here). A pasted link only fills the field.
 */
const autoCheck = (folder: string): boolean => {
  try {
    if (new URLSearchParams(window.location.search).get('check') !== '1') return false;
    const set = sessionStorage.getItem(SEND_FOLDER_CHECK_KEY);
    sessionStorage.removeItem(SEND_FOLDER_CHECK_KEY);
    return set !== null && set === folder;
  } catch {
    return false;
  }
};

/** The ID's own Send folders in the server's order (send-folder-file.ts): the first found gets Show in Finder. */
const SEND_ORDER = [
  '~/AgentLink/Send',
  ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `~/AgentLink/Send-${String(n)}`),
];

/** Send folders: the folders the AI may send files from. */
function SendFolders({
  api,
  fetch: givenFetch,
  token,
}: {
  readonly api: FilesApi;
  readonly fetch?: typeof fetch | undefined;
  readonly token?: string | undefined;
}): ReactElement {
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  // FILES-SETTINGS-COPY (D-152): Show in Finder for the Send folder card and the Inbox line, the
  // one line and the fixed tip of the AI app. Reads only; no folder is named to the server.
  const reveal = useMemo(
    () =>
      createRevealApi({
        ...(givenFetch === undefined ? {} : { fetch: givenFetch }),
        ...(token === undefined ? {} : { token }),
      }),
    [givenFetch, token],
  );
  const appName = useAppName();
  // Show in Finder on one card only: the one the server opens (the first Send folder, in its order,
  // that is found), never another allowed folder.
  const revealable =
    list.phase === 'ok'
      ? SEND_ORDER.map((path) => list.folders.find((r) => r.path === path)).find(
          (r) => r !== undefined && r.resolved !== null,
        )?.path
      : undefined;
  const [inbox, setInbox] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void api.get(listPath(RECEIVED_PATH, null)).then((answer) => {
      if (live && answer.kind === 'answer' && answer.status === 200) {
        setInbox(parseInboxFolder(answer.json));
      }
    });
    return () => {
      live = false;
    };
  }, [api]);
  const [initial] = useState(prefill);
  const [checkOnce, setCheckOnce] = useState(() => initial.length > 0 && autoCheck(initial));
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

  // ATT-SENDFOLDER-FIX: once the list (and its version) is read, check the filled-in folder once.
  useEffect(() => {
    if (!checkOnce || list.phase !== 'ok') return;
    setCheckOnce(false);
    void startReview('add', initial);
    // startReview is recreated each render; the one-shot flag keeps this to a single review.
  }, [checkOnce, list.phase]);

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
        <p className="al-text-body-sm">{C.oneLine}</p>
        <p className="al-text-body-sm al-muted" data-app-tip>
          <span className="al-text-label">{C.aiAppHeading}</span> {appTip(appName, computerWord())}
        </p>
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
                {row.path === revealable ? <RevealButton which="send" reveal={reveal} /> : null}
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
        {inbox === undefined ? null : (
          <div className="fl-row" data-row="inbox">
            <Icon name="inbox" size={16} />
            <div className="fl-row-main">
              <span className="al-text-label">{C.inboxLabel}</span>
              <span className="al-text-code">{inbox}</span>
              <span className="al-text-caption al-muted">{C.inboxLine}</span>
            </div>
            <RevealButton which="inbox" reveal={reveal} />
          </div>
        )}
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
          fields={[
            { kind: 'count', label: IO.hoodFolders, value: String(list.folders.length) },
            ...list.folders
              .slice(0, 5)
              .map((row, i) => ({ kind: 'path', label: IO.hoodFolder(i + 1), value: row.path })),
            ...(list.folders.length > 5
              ? [
                  {
                    kind: 'text',
                    label: IO.hoodMoreFolders,
                    value: IO.hoodMore(list.folders.length - 5),
                  },
                ]
              : []),
          ]}
        />
      ) : null}
    </section>
  );
}

/**
 * Received and Sent, with the moving-row mark (U3-map-2). The flow read lives here, so the Send
 * folders tab (which never shows a stream) reads nothing.
 */
function FileLists({
  tab,
  api,
  fetch: givenFetch,
  token,
  onReceived,
  onSent,
}: {
  readonly tab: 'received' | 'sent';
  readonly api: FilesApi;
  readonly fetch: typeof fetch | undefined;
  readonly token: string | undefined;
  readonly onReceived: (n: number) => void;
  readonly onSent: (n: number) => void;
}): ReactElement {
  const client = useMemo(
    () =>
      createApiClient({
        ...(givenFetch === undefined ? {} : { fetch: givenFetch }),
        ...(token === undefined ? {} : { token }),
      }),
    [givenFetch, token],
  );
  const marks = useFileMarks(client);
  // W4-FILES-SAVE: Save to Inbox with the owner's presence; only the item's ID is sent.
  const save = useMemo(
    () => ({
      api: createSaveApi({
        ...(givenFetch === undefined ? {} : { fetch: givenFetch }),
        ...(token === undefined ? {} : { token }),
      }),
      passkey: () => api.passkey(),
    }),
    [givenFetch, token, api],
  );
  return tab === 'received' ? (
    <ReceivedPanel
      get={api.get}
      reveal={api.reveal}
      onWaiting={onReceived}
      marks={marks}
      save={save}
    />
  ) : (
    <SentPanel get={api.get} onWaiting={onSent} marks={marks} />
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
    () => initialTab ?? (prefill().length > 0 || wantsFolders() ? 'folders' : 'received'),
  );
  // FILES-HOME-PANEL: Home's "{n} new" counts what arrived since Files was last opened.
  useEffect(() => {
    markSeen();
  }, []);
  const [waiting, setWaiting] = useState<Readonly<Partial<Record<FilesTab, number>>>>({});
  const onReceived = useCallback((n: number) => setWaiting((w) => ({ ...w, received: n })), []);
  const onSent = useCallback((n: number) => setWaiting((w) => ({ ...w, sent: n })), []);
  return (
    <div className="fl-page">
      <h1 className="al-text-title-1">{PAGE_TITLES.files}</h1>
      <p className="al-text-body-sm al-muted">{IO.explainer}</p>
      <FilesTabs tab={tab} onTab={setTab} counts={waiting} />
      <div id="fl-tabpanel" role="tabpanel" aria-labelledby={`fl-tab-${tab}`}>
        {tab === 'received' || tab === 'sent' ? (
          <FileLists
            tab={tab}
            api={api}
            fetch={givenFetch}
            token={token}
            onReceived={onReceived}
            onSent={onSent}
          />
        ) : null}
        {tab === 'folders' ? <SendFolders api={api} fetch={givenFetch} token={token} /> : null}
      </div>
    </div>
  );
}
