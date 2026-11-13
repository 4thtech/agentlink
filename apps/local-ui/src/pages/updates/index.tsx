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
import { Button, Skeleton, Surface } from '@4thtech-io/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { SettingsIcon } from '../settings/icons.js';
import { APP_UPDATE_CHECK_PATH, APP_UPDATE_PATH, parseUpdate, type UpdateView } from './data.js';
import { UPDATES_STRINGS as S } from './strings.js';
import './updates.css';

export interface UpdatesPageProps {
  /** The client (default: the production one); a test passes its own. */
  readonly api?: ApiClient;
  /** How long to wait between reads while a check runs (tests pass 0). */
  readonly pollMs?: number;
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
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState(false);
  const copy = (): void => {
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clip === undefined) {
      setProblem(true);
      return;
    }
    clip.writeText(command).then(
      () => {
        setProblem(false);
        setCopied(true);
      },
      () => setProblem(true),
    );
  };
  return (
    <span className="upd-cmd">
      <span className="upd-cmd-row">
        <code className="upd-cmd-text al-text-code">{command}</code>
        <Button size="sm" variant="secondary" onClick={copy}>
          {copied ? S.copied : S.copy}
        </Button>
      </span>
      <span className="al-visually-hidden" role="status" aria-live="polite">
        {copied ? S.copied : ''}
      </span>
      {problem ? <span className="al-text-body-sm al-muted">{S.copyFailed}</span> : null}
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

function Ready({ view }: { readonly view: UpdateView }): ReactElement {
  if (view.install !== 'desktop') return <BrowserReady view={view} />;
  const steps = view.macFile ? S.macSteps : S.otherSteps;
  return (
    <Surface as="section" level={1} className="upd-card upd-ready" aria-labelledby="upd-ready-t">
      <h2 id="upd-ready-t" className="al-text-h3">
        {S.ready(view.latest)}
      </h2>
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

export function UpdatesPage({ api: givenApi, pollMs = 1000 }: UpdatesPageProps): ReactElement {
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
        for (let i = 0; i < MAX_POLLS && view?.state === 'checking'; i += 1) {
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

  const view = load.kind === 'ready' ? load.view : undefined;
  const line = view === undefined ? undefined : statusLine(view);
  const canCheck = view !== undefined && view.state !== 'off' && view.state !== 'checking';

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
          {load.view.state === 'available' ? <Ready view={load.view} /> : null}
        </>
      )}
    </div>
  );
}
