// DESK051-UPD: Settings > Updates (desktop app only; listed by nav.ts settingsPages). The app's
// version, "Check for updates", and when a newer version is ready, "Download update" with three short
// steps. The link opens in the default browser (the app window's link rules); the page never builds a
// link itself and uses only the exact forms data.ts accepts. Styled from the Settings pages
// (design-1112 §3.1): same surfaces, tokens and type as Storage.
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
  | { readonly kind: 'ready'; readonly view: UpdateView };

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

function Ready({ view }: { readonly view: UpdateView }): ReactElement {
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
    async (path: string): Promise<UpdateView | undefined> => {
      try {
        const result = await api.get(path);
        return result.kind === 'ok' ? parseUpdate(result.data) : undefined;
      } catch {
        return undefined;
      }
    },
    [api],
  );

  /** Reads until a running check ends (at most MAX_POLLS reads). */
  const follow = useCallback(
    async (first: UpdateView | undefined): Promise<void> => {
      let view = first;
      if (alive.current) setLoad(view === undefined ? { kind: 'failed' } : { kind: 'ready', view });
      if (polling.current) return;
      polling.current = true;
      try {
        for (let i = 0; i < MAX_POLLS && view?.state === 'checking'; i += 1) {
          await new Promise((r) => setTimeout(r, pollMs));
          if (!alive.current) return;
          const next = await readOnce(APP_UPDATE_PATH);
          if (next === undefined) continue;
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
