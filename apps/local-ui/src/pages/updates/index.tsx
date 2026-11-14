// DESK051-UPD, REL051-UPD2: Settings > Updates, the one update surface in the desktop app and in the
// browser app (listed by nav.ts settingsPages). The app's version, "Check for updates", and when a
// newer version is ready, the one right action for how this copy was installed:
// - desktop app: "Download update" with short steps. The link opens in the default browser (the app
//   window's link rules); the page never builds a link itself and uses only the exact forms data.ts
//   accepts.
// - browser app from the installer's `agentlink` or npx: "Restart AgentLink to update" (both start
//   the newest version every time) and the start command with Copy.
// - browser app from a global npm install: the one update command with Copy, then the start command.
// The commands are fixed strings (strings.ts), never taken from an answer. Nothing is installed from
// the page. Styled from the Settings pages (design-1112 §3.1): same surfaces, tokens and type as Storage.
// UPD-5 (the Mac app with the in-app update on): "Update now" → Downloading (progress bar, %) →
// "Checking the new version" → "Restart now" (a note first when a request waits for the owner) →
// "Restarting"; "Couldn't update here" keeps the download link. Both buttons are POSTs with no body
// (owner session + CSRF); the shell installs only the update it verified itself.
import { Button, CopyButton, InlineError, ProgressBar, Skeleton, Surface } from '@4thtech-io/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { inDesktopApp } from '../../desktop.js';
import { detectOs, type OsName } from '../../layout/os.js';
import { SettingsIcon } from '../settings/icons.js';
import { SETUP_EXIT as X } from '../start/strings.js';
import {
  APP_UPDATE_CHECK_PATH,
  APP_UPDATE_INSTALL_PATH,
  APP_UPDATE_PATH,
  APP_UPDATE_RESTART_PATH,
  WINDOWS_SETUP_URL,
  parseUpdate,
  type UpdateState,
  type UpdateView,
} from './data.js';
import { UPDATES_STRINGS as S } from './strings.js';
import './updates.css';

export interface UpdatesPageProps {
  /** The client (default: the production one); a test passes its own. */
  readonly api?: ApiClient;
  /** How long to wait between reads while a check runs (tests pass 0). */
  readonly pollMs?: number;
  /** FIRSTRUN-EXIT test seams: the platform and whether this is the desktop app's window. */
  readonly os?: OsName;
  readonly desktop?: boolean;
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'not_here' }
  | { readonly kind: 'ready'; readonly view: UpdateView };

/** A read: the view, `not_here` (this server has no update check, 501), or undefined (failed). */
type Read = UpdateView | 'not_here' | undefined;

/** A check is given this many reads to finish (the shell gives up after 15 s). */
const MAX_POLLS = 30;
/** UPD-5: a download and its checks are followed for up to an hour of reads. */
const MAX_INSTALL_POLLS = 3600;
/** The states the page follows by reading again (a restart ends the page's server). */
const FOLLOWED: readonly UpdateState[] = ['checking', 'downloading', 'verifying'];
/** UPD-5: an in-app update is under way (no check meanwhile). */
const RUNNING: readonly UpdateState[] = ['downloading', 'verifying', 'ready', 'restarting'];

function statusLine(view: UpdateView): string | undefined {
  switch (view.state) {
    case 'idle':
      return S.idle;
    case 'checking':
      return S.checking;
    case 'current':
      return S.current;
    case 'failed':
      return S.failed;
    case 'offline':
      return S.offline;
    case 'off':
      return S.off;
    default:
      return undefined;
  }
}

/** One fixed command with Copy (REL051-UPD2). */
function Command({ command }: { readonly command: string }): ReactElement {
  return (
    <span className="upd-cmd">
      <span className="upd-cmd-row">
        <code className="upd-cmd-text al-text-code">{command}</code>
        <CopyButton
          text={command}
          variant="secondary"
          label={S.copy}
          copiedLabel={S.copied}
          failedLabel={S.copyFailed}
        />
      </span>
    </span>
  );
}

/** The browser app: restart (installer, npx) or the update command first (global). */
function BrowserReady({ view }: { readonly view: UpdateView }): ReactElement {
  const start = view.install === 'npx' ? S.npxCommand : S.installerCommand;
  const global = view.install === 'global';
  return (
    <Surface as="section" level={1} className="upd-card upd-ready" aria-labelledby="upd-ready-t">
      <h2 id="upd-ready-t" className="al-text-h3">
        {S.ready(view.latest)}
      </h2>
      <p className="al-text-body-sm al-muted">{global ? S.commandLead : S.restartLead}</p>
      <ol className="upd-steps" aria-label={S.stepsLabel}>
        <li className="al-text-body-sm">{S.stopStep}</li>
        {global ? (
          <li className="al-text-body-sm">
            {S.updateStep}
            <Command command={S.globalCommand} />
          </li>
        ) : null}
        <li className="al-text-body-sm">
          {S.startStep}
          <Command command={start} />
        </li>
        <li className="al-text-body-sm">{S.reopen}</li>
      </ol>
      <p className="al-text-body-sm al-muted">{S.keeps}</p>
    </Surface>
  );
}

/** UPD-5: the in-app update, one card per state. */
function InApp({
  view,
  onUpdate,
  onRestart,
  sending,
}: {
  readonly view: UpdateView;
  readonly onUpdate: () => void;
  readonly onRestart: () => void;
  readonly sending: boolean;
}): ReactElement {
  const title = view.state === 'available' ? S.availableTitle(view.latest) : S.ready(view.latest);
  return (
    <Surface
      as="section"
      level={1}
      className="upd-card upd-ready"
      aria-labelledby="upd-ready-t"
      data-update-state={view.state}
    >
      <h2 id="upd-ready-t" className="al-text-h3">
        {title}
      </h2>
      {view.state === 'available' ? (
        <>
          <p className="al-text-body-sm al-muted">{S.availableLead}</p>
          <div>
            <Button variant="primary" onClick={onUpdate} disabled={sending}>
              {S.updateNow}
            </Button>
          </div>
        </>
      ) : view.state === 'downloading' ? (
        <ProgressBar
          label={S.downloading}
          value={view.percent}
          max={100}
          amount={S.percent(view.percent)}
        />
      ) : view.state === 'verifying' ? (
        <ProgressBar label={S.verifying} indeterminate />
      ) : view.state === 'ready' ? (
        <>
          <p className="al-text-body-sm al-muted">{S.readyRestartLead}</p>
          {view.busy ? (
            <p className="al-text-body-sm upd-warn" role="note">
              {S.busy}
            </p>
          ) : null}
          <div>
            <Button variant="primary" onClick={onRestart} disabled={sending}>
              {S.restartNow}
            </Button>
          </div>
        </>
      ) : (
        <p className="al-text-body-sm" role="status" aria-live="polite">
          {S.restarting}
        </p>
      )}
      <p className="al-text-body-sm al-muted">{S.keeps}</p>
    </Surface>
  );
}

/**
 * FIRSTRUN-EXIT: the Windows app has no in-app update, so it always offers the newest setup file,
 * also when the check can't run (a broken first run, offline, no answer).
 */
function WindowsDownload(): ReactElement {
  return (
    <Surface as="section" level={1} className="upd-card" aria-labelledby="upd-win-t">
      <h2 id="upd-win-t" className="al-text-h3">
        {X.windowsTitle}
      </h2>
      <p className="al-text-body-sm al-muted">{X.windowsLead}</p>
      <div>
        <a
          className="al-btn al-btn-secondary"
          href={WINDOWS_SETUP_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {X.windowsDownload}
        </a>
      </div>
      <ol className="upd-steps" aria-label={S.stepsLabel}>
        {S.winSteps.map((step) => (
          <li key={step} className="al-text-body-sm">
            {step}
          </li>
        ))}
      </ol>
    </Surface>
  );
}

/** FIRSTRUN-EXIT: the browser app, always: how to update (the fixed commands of REL051-UPD2). */
function BrowserHow({
  install,
}: {
  readonly install: UpdateView['install'] | undefined;
}): ReactElement {
  const global = install === 'global';
  const command = global
    ? S.globalCommand
    : install === 'installer'
      ? S.installerCommand
      : S.npxCommand;
  return (
    <Surface as="section" level={1} className="upd-card" aria-labelledby="upd-how-t">
      <h2 id="upd-how-t" className="al-text-h3">
        {X.browserHowTitle}
      </h2>
      <p className="al-text-body-sm al-muted">{global ? S.commandLead : X.browserHowLead}</p>
      <Command command={command} />
    </Surface>
  );
}

function Ready({ view }: { readonly view: UpdateView }): ReactElement {
  if (view.install !== 'desktop') return <BrowserReady view={view} />;
  const steps = view.macFile ? S.macSteps : view.winFile ? S.winSteps : S.otherSteps;
  const failed = view.state === 'install_failed';
  return (
    <Surface as="section" level={1} className="upd-card upd-ready" aria-labelledby="upd-ready-t">
      <h2 id="upd-ready-t" className="al-text-h3">
        {S.ready(view.latest)}
      </h2>
      {failed ? <InlineError>{S.cantUpdate}</InlineError> : null}
      <p className="al-text-body-sm al-muted">{S.readyLead}</p>
      <div>
        <a
          className="al-btn al-btn-primary"
          href={view.download}
          target="_blank"
          rel="noopener noreferrer"
        >
          {S.download}
        </a>
      </div>
      <ol className="upd-steps" aria-label={S.stepsLabel}>
        {steps.map((step) => (
          <li key={step} className="al-text-body-sm">
            {step}
          </li>
        ))}
      </ol>
      <p className="al-text-body-sm al-muted">{S.keeps}</p>
    </Surface>
  );
}

export function UpdatesPage({
  api: givenApi,
  pollMs = 1000,
  os: givenOs,
  desktop: givenDesktop,
}: UpdatesPageProps): ReactElement {
  const [os] = useState<OsName>(() => givenOs ?? detectOs());
  const [desktop] = useState<boolean>(() => givenDesktop ?? inDesktopApp());
  const [api] = useState<ApiClient>(() => givenApi ?? createApiClient());
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const alive = useRef(true);
  const polling = useRef(false);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const readOnce = useCallback(
    async (path: string): Promise<Read> => {
      try {
        const result = await api.get(path);
        if (result.kind === 'not_available') return 'not_here';
        return result.kind === 'ok' ? parseUpdate(result.data) : undefined;
      } catch {
        return undefined;
      }
    },
    [api],
  );

  /** Reads until a running check ends (at most MAX_POLLS reads). */
  const follow = useCallback(
    async (first: Read): Promise<void> => {
      if (first === 'not_here') {
        if (alive.current) setLoad({ kind: 'not_here' });
        return;
      }
      let view = first;
      if (alive.current) setLoad(view === undefined ? { kind: 'failed' } : { kind: 'ready', view });
      if (polling.current) return;
      polling.current = true;
      try {
        const followed = (v: UpdateView | undefined): boolean =>
          v !== undefined && FOLLOWED.includes(v.state);
        const cap = view?.state === 'checking' ? MAX_POLLS : MAX_INSTALL_POLLS;
        for (let i = 0; i < cap && followed(view); i += 1) {
          await new Promise((r) => setTimeout(r, pollMs));
          if (!alive.current) return;
          const next = await readOnce(APP_UPDATE_PATH);
          if (next === undefined || next === 'not_here') continue;
          view = next;
          if (alive.current) setLoad({ kind: 'ready', view });
        }
      } finally {
        polling.current = false;
      }
    },
    [pollMs, readOnce],
  );

  const read = useCallback((): void => {
    setLoad({ kind: 'loading' });
    void readOnce(APP_UPDATE_PATH).then(follow);
  }, [readOnce, follow]);
  useEffect(read, [read]);

  const check = (): void => {
    void readOnce(APP_UPDATE_CHECK_PATH).then(follow);
  };

  // UPD-5: Update now / Restart now: one POST with no body each; the answer is the new state.
  const [sending, setSending] = useState(false);
  const step = (path: string): void => {
    if (sending) return;
    setSending(true);
    void api
      .post(path)
      .then(
        (result): Read =>
          result.kind === 'not_available'
            ? 'not_here'
            : result.kind === 'ok'
              ? parseUpdate(result.data)
              : undefined,
        (): Read => undefined,
      )
      .then(async (next) => {
        if (alive.current) setSending(false);
        // A refused or unreadable answer: read the state again rather than guess.
        await follow(next === undefined ? await readOnce(APP_UPDATE_PATH) : next);
      });
  };

  const view = load.kind === 'ready' ? load.view : undefined;
  const line = view === undefined ? undefined : statusLine(view);
  const canCheck =
    view !== undefined &&
    view.state !== 'off' &&
    view.state !== 'checking' &&
    !RUNNING.includes(view.state);
  // FIRSTRUN-EXIT: the always-there fallbacks, unless the page already shows that version's card.
  const versionCard =
    view !== undefined && (view.state === 'available' || view.state === 'install_failed');
  const settled = load.kind !== 'loading';
  const appWindow = view === undefined ? desktop : view.install === 'desktop';
  const windowsFallback = settled && appWindow && os === 'windows' && !versionCard;
  const browserHow = settled && !appWindow && !versionCard;
  const inApp =
    view !== undefined &&
    view.install === 'desktop' &&
    (RUNNING.includes(view.state) || (view.state === 'available' && view.installable));

  return (
    <div className="upd-page">
      <header className="upd-head">
        <h1 className="al-text-title-1">{S.title}</h1>
        <p className="al-text-body al-muted">{S.lead}</p>
      </header>

      {load.kind === 'loading' ? (
        <div role="status" aria-label={S.loading}>
          <Skeleton loading lines={2} />
        </div>
      ) : load.kind === 'not_here' ? (
        <p className="al-text-body al-muted">{S.notHere}</p>
      ) : load.kind === 'failed' ? (
        <div className="upd-failed" role="alert">
          <p className="al-text-body">{S.unreadable}</p>
          <Button variant="secondary" onClick={read}>
            {S.retry}
          </Button>
        </div>
      ) : (
        <>
          <Surface as="section" level={1} className="upd-card" aria-labelledby="upd-version">
            <div className="upd-row">
              <span className="upd-ic" aria-hidden="true">
                <SettingsIcon name="download" />
              </span>
              <div className="upd-text">
                <h2 id="upd-version" className="upd-version">
                  {S.version(load.view.current)}
                </h2>
                {line === undefined ? null : (
                  <p
                    className="al-text-body-sm al-muted"
                    role="status"
                    aria-live="polite"
                    data-state={load.view.state}
                  >
                    {line}
                  </p>
                )}
              </div>
              {load.view.state === 'off' ? null : (
                <Button variant="secondary" onClick={check} disabled={!canCheck}>
                  {load.view.state === 'checking' ? S.checking : S.check}
                </Button>
              )}
            </div>
          </Surface>
          {inApp ? (
            <InApp
              view={load.view}
              sending={sending}
              onUpdate={() => step(APP_UPDATE_INSTALL_PATH)}
              onRestart={() => step(APP_UPDATE_RESTART_PATH)}
            />
          ) : load.view.state === 'available' || load.view.state === 'install_failed' ? (
            <Ready view={load.view} />
          ) : null}
        </>
      )}
      {windowsFallback ? <WindowsDownload /> : null}
      {browserHow ? <BrowserHow install={view?.install} /> : null}
    </div>
  );
}
