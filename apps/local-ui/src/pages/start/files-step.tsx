// FILES-ONB-1 (D-152; 08 §1 "Files step" and "Choose another folder"; 11 §5.7; b11 §8 row 24, no new
// design: the wizard step frame and the Settings › Files folder rows): step 4 of 5 of Get started and
// New ID, between Connected and Invite. Connect another AI app has no Files step.
//
// - Read-only by default: the folder list and the Inbox folder are GETs (folders-summary.ts). Continue
//   and Skip for now change nothing: the default Send folder stays allowed (owner decision (a)).
// - Show in Finder / Show in Explorer: the FILES-REVEAL routes, an empty POST, no path from the page.
// - Not allowed (the first rules carried no Send folder): the line of 11 §5.7 and Allow Send folder,
//   the Home banner's flow (a mark-kind POST, nothing signed here; the owner confirms in Settings ›
//   Files with their own presence).
// - Choose another folder: the existing Settings › Files add review and confirm (files/add-folder.tsx;
//   D-99 checks, D-119 ticks, Touch ID / Windows Hello in a browser or the master code; never WebAuthn
//   in the desktop app's window). It only adds a folder through the one existing signed route.
// - The tip of the AI app picked in step 1: fixed text, never a status (the app can't see it).
import { Banner, Button, Icon, Skeleton } from '@4thtech-io/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createRevealApi, type RevealApi } from '../../api/reveal-folder.js';
import { navigate } from '../../router.js';
import { SEND_FOLDER_CHECK_KEY } from '../../strings.js';
import { AddFolder } from '../files/add-folder.js';
import { createFilesApi, type FilesApi } from '../files/files-api.js';
import { FolderRows } from '../files/folder-rows.js';
import { FILES_COPY as C, appTip, computerWord } from '../files/folders-copy.js';
import { loadFilesSummary, type FilesSummary } from '../files/folders-summary.js';
import type { SendFolderOutcome } from '../first-run/setup-api.js';
import { FIRST_RUN as T } from '../first-run/strings.js';
import {
  createSendFolderApi,
  filesLinkFor,
  type SendFolderApi,
} from '../home/send-folder-banner.js';
import { useTitleFocus } from '../welcome/index.js';
import { FILES_STEP as F } from './strings.js';
import { BackButton } from './wizard.js';
import '../files/files.css';
import './start.css';

export interface FilesStepProps {
  /** The AI app picked in step 1 (its tip); undefined: the unknown-app tip. */
  readonly appName?: string | undefined;
  /** What first run's one gesture did to the Send folder (`not_confirmed` is said). */
  readonly sendOutcome?: SendFolderOutcome | undefined;
  /** The Connect card's "Change": open the folder choice at once. */
  readonly chooseFirst?: boolean;
  readonly onBack: () => void;
  readonly onContinue: () => void;
  readonly onSkip: () => void;
  /** Test seams; the page's own same-origin calls by default. */
  readonly api?: FilesApi;
  readonly reveal?: RevealApi;
  readonly sendFolder?: SendFolderApi;
  readonly go?: (to: string) => void;
}

type Load =
  | { readonly k: 'loading' }
  | { readonly k: 'ok'; readonly summary: FilesSummary }
  | { readonly k: 'error' };

export function FilesStep({
  appName,
  sendOutcome,
  chooseFirst = false,
  onBack,
  onContinue,
  onSkip,
  api: givenApi,
  reveal: givenReveal,
  sendFolder: givenSendFolder,
  go = navigate,
}: FilesStepProps): ReactElement {
  const title = useTitleFocus<HTMLHeadingElement>();
  const [api] = useState<FilesApi>(() => givenApi ?? createFilesApi());
  const [reveal] = useState<RevealApi>(() => givenReveal ?? createRevealApi());
  const [sendFolder] = useState<SendFolderApi>(() => givenSendFolder ?? createSendFolderApi());
  const [load, setLoad] = useState<Load>({ k: 'loading' });
  const [allowing, setAllowing] = useState<'idle' | 'working' | 'failed'>('idle');
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const read = useCallback(async (): Promise<void> => {
    const result = await loadFilesSummary((path) => api.get(path));
    if (!live.current) return;
    setLoad(result.kind === 'ok' ? { k: 'ok', summary: result.summary } : { k: 'error' });
  }, [api]);
  useEffect(() => {
    void read();
  }, [read]);

  const allow = async (): Promise<void> => {
    setAllowing('working');
    const folder = await sendFolder.prepare();
    if (!live.current) return;
    if (folder === undefined) {
      setAllowing('failed');
      return;
    }
    // IR-1 L-2 (as Home's banner): Settings › Files checks at once only for the folder set up here.
    try {
      sessionStorage.setItem(SEND_FOLDER_CHECK_KEY, folder);
    } catch {
      // Without it, Files only fills the field.
    }
    go(filesLinkFor(folder));
  };

  const computer = computerWord();
  let body: ReactElement;
  if (load.k === 'loading') {
    body = <Skeleton loading label={C.panelTitle} lines={3} />;
  } else if (load.k === 'error') {
    body = <Banner tone="warning">{C.unavailable}</Banner>;
  } else {
    const { summary } = load;
    body = (
      <>
        {summary.send.state === 'not_allowed' ? (
          allowing === 'failed' ? (
            <Banner tone="warning">{C.allowFailed}</Banner>
          ) : (
            <Banner
              tone="info"
              icon="folder"
              action={
                <Button
                  size="sm"
                  variant="primary"
                  disabled={allowing === 'working'}
                  onClick={() => void allow()}
                >
                  {allowing === 'working' ? C.working : C.allowSendFolder}
                </Button>
              }
            >
              {C.notAllowedLine}
            </Banner>
          )
        ) : null}
        <FolderRows summary={summary} reveal={reveal} />
        <AddFolder api={api} label={F.choose} open={chooseFirst} onAdded={() => void read()} />
      </>
    );
  }

  return (
    <section className="st-screen st-w-600" aria-labelledby="st-h" data-files-step>
      <BackButton onBack={onBack} label={F.back} />
      <div className="st-intro">
        <span className="st-eyebrow">{F.eyebrow}</span>
        <h1 id="st-h" ref={title} tabIndex={-1} className="st-title-2">
          {F.title}
        </h1>
        <p className="st-lead">{C.oneLine}</p>
      </div>
      {sendOutcome === 'not_confirmed' ? (
        <Banner tone="warning">{T.sendNotConfirmed}</Banner>
      ) : null}
      {body}
      <div className="st-panel">
        <p className="al-text-label">{C.aiAppHeading}</p>
        <p className="al-text-body-sm al-muted" data-app-tip>
          <Icon name="info" size={14} /> {appTip(appName, computer)}
        </p>
      </div>
      <div className="st-row st-end">
        <Button variant="ghost" size="lg" onClick={onSkip}>
          {F.skip}
        </Button>
        <Button variant="primary" size="lg" className="al-press" onClick={onContinue}>
          {F.next}
        </Button>
      </div>
    </section>
  );
}
