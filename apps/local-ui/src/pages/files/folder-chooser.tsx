// FILES-FOLDER-PICKER (D-161, proposed, owner confirms at merge; 08 §1 "Choosing a folder"; 04 §4,
// §4.1; D-99, D-116, D-119; I-4). One folder control for Settings › Files, the Files step and
// Home's Files panel, in the way mature desktop apps choose a download location:
//
// - FolderLine: a folder row: icon, the folder's name, the full path under it (cut in the middle
//   when long; the whole path is its title and is read out), an optional chip and its actions.
// - FolderChooser: "Change…" (the Inbox) or "Add folder…" (a Send folder).
//   - In the desktop app the click opens the native folder dialog (window.agentlinkDesktop, the
//     window's one preload; apps/desktop/src/main/folder-picker.ts), preselected at the current
//     folder. It answers one path or nothing; cancelling changes nothing and focus returns to the
//     button.
//   - In a browser there is no real folder dialog (a browser never gives a page a path), so the
//     click opens an inline path field with an example, paste help and the tip that the app can
//     pick in Finder or Explorer. No fake dialog.
//   - Either way the path is only text: the local server reviews it (Send: realpath, links,
//     protected and too-broad folders, D-99, not the Inbox; Inbox: the same plus 04 §4.1, not a
//     link, owned, writable, not a Send folder) and answers the real folder and every warning. The
//     row shows that folder at once as pending ("Not saved yet"), the confirm sheet follows (every
//     warning ticked, D-119; the owner's passkey or master code; the browser never signs), then the
//     success line; a refusal is said in plain words next to the row.
import { Banner, Button, Icon, InlineError, StatusChip, TextField } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  Confirm,
  NoticeBanner,
  RETRYABLE,
  outcomeText,
  problemText,
  type Notice,
} from './add-folder.js';
import {
  COMMIT_PATH,
  INBOX_COMMIT_PATH,
  LIST_PATH,
  inboxReviewPath,
  parseList,
  parseReview,
  parseReviewProblem,
  reviewPath,
  type Review,
} from './data.js';
import {
  passkeyPresence,
  passkeysAvailable,
  type CommitOutcome,
  type FilesApi,
  type PasskeyInfo,
} from './files-api.js';
import {
  PICKER_COPY as P,
  computerWord,
  folderName,
  inboxRefusalText,
  middleTruncate,
} from './folders-copy.js';
import { FILES_STRINGS as S } from './strings.js';
import './files.css';

export type FolderPurpose = 'send' | 'inbox';

type ChooseFolder = (request: {
  readonly purpose: FolderPurpose;
  readonly current?: string;
}) => Promise<string | null>;

/** The app window's native folder dialog (the one preload), or undefined in a browser. */
export function desktopPicker(): ChooseFolder | undefined {
  try {
    const bridge = (globalThis as { agentlinkDesktop?: { chooseFolder?: unknown } })
      .agentlinkDesktop;
    const choose = bridge?.chooseFolder;
    if (typeof choose !== 'function') return undefined;
    return async (request) => {
      try {
        const picked: unknown = await (choose as ChooseFolder).call(bridge, request);
        return typeof picked === 'string' && picked.length > 0 && picked.length <= 4096
          ? picked
          : null;
      } catch {
        return null;
      }
    };
  } catch {
    return undefined;
  }
}

export interface FolderLineProps {
  readonly icon?: 'folder' | 'inbox';
  /** The row's label (Send, Inbox); the folder's own name is shown when there is none. */
  readonly label?: string;
  readonly path: string | undefined;
  readonly line?: ReactNode;
  readonly chip?: ReactNode;
  readonly actions?: ReactNode;
  readonly below?: ReactNode;
  readonly pending?: boolean;
  readonly row?: string;
}

/** One folder row (see the header). The path is text only. */
export function FolderLine({
  icon = 'folder',
  label,
  path,
  line,
  chip,
  actions,
  below,
  pending = false,
  row,
}: FolderLineProps): ReactElement {
  const name = path === undefined ? undefined : folderName(path);
  return (
    <li
      className="fl-line"
      {...(row === undefined ? {} : { 'data-row': row })}
      {...(pending ? { 'data-pending': '' } : {})}
    >
      <div className="fl-row fl-line-head">
        <span className="fl-line-icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
        <div className="fl-row-main">
          <span className="fl-line-name al-text-body">
            {label ?? name}
            {label !== undefined &&
            name !== undefined &&
            name.toLowerCase() !== label.toLowerCase() ? (
              <span className="al-muted"> · {name}</span>
            ) : null}
          </span>
          {path === undefined ? null : (
            <span className="fl-line-path al-text-code al-muted" title={path}>
              <span aria-hidden="true">{middleTruncate(path)}</span>
              <span className="fl-sr-only">{path}</span>
            </span>
          )}
          {line === undefined ? null : <span className="al-text-caption al-muted">{line}</span>}
          {chip === undefined ? null : <span className="fl-line-chip">{chip}</span>}
        </div>
        {actions === undefined ? null : <div className="fl-row-actions">{actions}</div>}
      </div>
      {below === undefined ? null : <div className="fl-line-below">{below}</div>}
    </li>
  );
}

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'picking' }
  | { readonly kind: 'enter'; readonly problem?: string }
  | { readonly kind: 'checking'; readonly path: string }
  | { readonly kind: 'refused'; readonly path: string; readonly problem: string }
  | { readonly kind: 'confirm'; readonly review: Review };

export interface FolderChooserProps {
  readonly api: FilesApi;
  readonly purpose: FolderPurpose;
  /** The folder in use now (the dialog opens there; `~` for home). */
  readonly current?: string | undefined;
  /** The button's words; by default Change… (Inbox) or Add folder… (Send). */
  readonly label?: string;
  readonly variant?: 'primary' | 'secondary';
  /** Open at once (the Files step's Connect card "Change"; a `?folder=` link). */
  readonly open?: boolean;
  /** A path to fill in (a `?folder=` link); with `check`, it is checked once at once. */
  readonly initialPath?: string;
  readonly check?: boolean;
  /** Test seam: the native dialog; by default the app window's, none in a browser. */
  readonly picker?: ChooseFolder | null;
  /** The folder changed: the caller reads its folders again. */
  readonly onDone?: () => void;
}

/** "Change…" / "Add folder…" with the review and confirm (see the header). */
export function FolderChooser({
  api,
  purpose,
  current,
  label,
  variant = 'secondary',
  open = false,
  initialPath = '',
  check = false,
  picker,
  onDone,
}: FolderChooserProps): ReactElement {
  const [choose] = useState<ChooseFolder | undefined>(() =>
    picker === null ? undefined : (picker ?? desktopPicker()),
  );
  const [step, setStep] = useState<Step>(
    open || initialPath.length > 0 ? { kind: 'enter' } : { kind: 'idle' },
  );
  const [typed, setTyped] = useState(initialPath);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [passkey, setPasskey] = useState<PasskeyInfo | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const button = useRef<HTMLSpanElement>(null);
  const alive = useRef(true);
  const checkedOnce = useRef(false);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const focusButton = (): void => {
    // After the dialog or the sheet: back to the row's own button.
    setTimeout(() => button.current?.querySelector('button')?.focus(), 0);
  };
  const inbox = purpose === 'inbox';
  const buttonLabel = label ?? (inbox ? P.change : P.addFolder);
  const computer = computerWord();

  const review = async (path: string): Promise<void> => {
    setNotice(undefined);
    setStep({ kind: 'checking', path });
    // L-1: the review names the rules version the folders were read at.
    const listed = await api.get(LIST_PATH);
    if (!alive.current) return;
    const version =
      listed.kind === 'answer' && listed.status === 200
        ? (parseList(listed.json)?.version ?? null)
        : null;
    if (version === null) {
      setStep({
        kind: 'refused',
        path,
        problem: listed.kind === 'offline' ? S.offline : S.rulesUnreadable,
      });
      return;
    }
    const answer = await api.get(
      inbox ? inboxReviewPath(path, version) : reviewPath('add', path, version),
    );
    if (!alive.current) return;
    const parsed =
      answer.kind === 'answer' && answer.status === 200 ? parseReview(answer.json) : undefined;
    if (parsed === undefined || parsed.change !== (inbox ? 'inbox' : 'add')) {
      if (answer.kind === 'offline') {
        setStep({ kind: 'refused', path, problem: S.offline });
        return;
      }
      const problem = parseReviewProblem(answer.status, answer.json);
      const shown: Notice =
        parsed !== undefined
          ? { tone: 'warning', text: S.failed }
          : inbox && problem.kind === 'folder'
            ? { tone: 'warning', text: inboxRefusalText(problem.reason) }
            : problemText(problem);
      if (shown.rules === true) setNotice(shown);
      setStep({ kind: 'refused', path, problem: shown.text });
      return;
    }
    setPasskey(passkeysAvailable() ? await api.passkey() : undefined);
    if (!alive.current) return;
    setStep({ kind: 'confirm', review: parsed });
  };

  // A `?folder=...&check=1` link: checked once, as soon as it is shown.
  useEffect(() => {
    if (!check || checkedOnce.current || initialPath.length === 0) return;
    checkedOnce.current = true;
    void review(initialPath);
    // review is recreated each render; the ref keeps this to a single check.
  }, [check, initialPath]);

  const start = async (): Promise<void> => {
    setNotice(undefined);
    if (choose === undefined) {
      setStep({ kind: 'enter' });
      return;
    }
    setStep({ kind: 'picking' });
    const picked = await choose({ purpose, ...(current === undefined ? {} : { current }) });
    if (!alive.current) return;
    if (picked === null) {
      setStep({ kind: 'idle' });
      focusButton();
      return;
    }
    await review(picked);
  };

  const confirm = async (
    chosen: Review,
    acknowledged: readonly string[],
    code: string | undefined,
  ): Promise<void> => {
    setSending(true);
    setNotice(undefined);
    const path = inbox ? INBOX_COMMIT_PATH : COMMIT_PATH;
    try {
      let outcome: CommitOutcome;
      if (code === undefined && passkey !== undefined) {
        const gesture = passkeyPresence(passkey);
        if (gesture.kind !== 'ok') {
          setNotice({ tone: 'info', text: S.passkeyNotUsed });
          return;
        }
        let notUsed = false;
        outcome = await api.commit(
          path,
          { review: chosen.review, acknowledged: [...acknowledged] },
          {
            kind: 'passkey',
            gesture: async (publicKey) => {
              const body = await gesture.gesture(publicKey);
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
          path,
          { review: chosen.review, acknowledged: [...acknowledged] },
          { kind: 'code', code: code ?? '' },
        );
      }
      if (!alive.current) return;
      setNotice(outcomeText(outcome, inbox ? 'inbox' : 'add'));
      if (outcome.kind === 'applied') {
        setStep({ kind: 'idle' });
        setTyped('');
        focusButton();
        onDone?.();
      } else if (!RETRYABLE.has(outcome.kind)) {
        // The review was used up: start again from the folder.
        setStep({ kind: 'idle' });
      }
    } finally {
      if (alive.current) setSending(false);
    }
  };

  const cancel = (): void => {
    setStep({ kind: 'idle' });
    setNotice(undefined);
    focusButton();
  };

  const pendingPath =
    step.kind === 'checking' || step.kind === 'refused'
      ? step.path
      : step.kind === 'confirm'
        ? step.review.folder
        : undefined;

  return (
    <div className="fl-chooser" data-folder-chooser={purpose}>
      {step.kind === 'idle' || step.kind === 'picking' || step.kind === 'refused' ? (
        <span ref={button} className="fl-chooser-btn">
          <Button
            variant={variant}
            size="sm"
            icon={inbox ? 'folder' : 'plus'}
            disabled={step.kind === 'picking'}
            onClick={() => void start()}
          >
            {buttonLabel}
            <span className="fl-sr-only"> {inbox ? P.changeInboxLabel : P.addSendLabel}</span>
          </Button>
        </span>
      ) : null}
      {step.kind === 'enter' ? (
        <form
          className="fl-enter"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim().length > 0) void review(typed.trim());
          }}
        >
          <TextField
            name={inbox ? 'inbox-folder' : 'folder'}
            label={P.pathField}
            {...(step.problem === undefined
              ? { hint: `${inbox ? P.inboxExample : P.sendExample}. ${P.pasteHelp(computer)}` }
              : { error: step.problem })}
            placeholder={inbox ? '~/Documents/Received' : '~/Documents/Shared'}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            mono
          />
          {computer === 'computer' ? null : (
            <p className="al-text-caption al-muted" data-app-pick-tip>
              <Icon name="info" size={14} /> {P.appTip(computer)}
            </p>
          )}
          <div className="fl-actions">
            <Button type="submit" variant="primary" disabled={typed.trim().length === 0}>
              {P.use}
            </Button>
            <Button variant="ghost" onClick={cancel}>
              {P.cancel}
            </Button>
          </div>
        </form>
      ) : null}
      {pendingPath === undefined ? null : (
        <ul className="fl-list">
          <FolderLine
            icon={inbox ? 'inbox' : 'folder'}
            path={pendingPath}
            pending
            row="pending"
            chip={
              step.kind === 'checking' ? (
                <StatusChip status="recording">{P.checking}</StatusChip>
              ) : step.kind === 'confirm' ? (
                <StatusChip status="needs-approval">{P.pending}</StatusChip>
              ) : undefined
            }
            below={step.kind === 'refused' ? <InlineError>{step.problem}</InlineError> : undefined}
          />
        </ul>
      )}
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
      {step.kind !== 'confirm' && notice !== undefined ? (
        notice.tone === 'success' ? (
          <Banner tone="success" icon="check">
            {notice.text}
          </Banner>
        ) : (
          <NoticeBanner notice={notice} />
        )
      ) : null}
    </div>
  );
}
