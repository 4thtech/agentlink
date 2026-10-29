// Connect your AI app (U3-g; b11 §28.4, §30.3): a separate, signed step right after setup when an app
// was chosen. The page shows only the `agentlink` entry the server would add (never other entries or
// the file), then one Touch ID gesture applies it (`app.connect`, signed by the server; the page never
// signs and sends no path). "Later" skips it and writes nothing. We never close or restart an AI app.
//
// What the page asks of the server is in apps-api.ts; every answer is a fixed word, an app name, a
// display path or AgentLink's own entry, shown as text only.
import { Banner, Button, ProgressBar, TextField } from '@4thtech-io/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { LinkExpiredState, LoadingState, NotRunningState } from '../../states/index.js';
import { useTitleFocus } from '../welcome/index.js';
import type {
  AppChange,
  AppsApi,
  ApplyResult,
  PasskeyInfo,
  PresenceProof,
  PreviewResult,
} from './apps-api.js';
import { AppMark } from './pick-app.js';
import { CONNECT as T, FIRST_RUN, SETUP_MESSAGES } from './strings.js';
import './first-run.css';

type View =
  | { readonly k: 'loading' }
  | { readonly k: 'change'; readonly change: AppChange; readonly message?: string }
  | { readonly k: 'working'; readonly change: AppChange }
  | { readonly k: 'status'; readonly status: 'quit_first' | 'conflict' | 'unreadable' | 'present' }
  | { readonly k: 'failed'; readonly change: AppChange }
  | { readonly k: 'done' }
  | { readonly k: 'expired' }
  | { readonly k: 'down' };

export interface ConnectAppProps {
  readonly appsApi: AppsApi;
  readonly appId: string;
  /** The app's name as the server listed it (text). */
  readonly appName: string;
  /** The agent folder the entry runs (`--agent`). */
  readonly folder: string;
  /** The name the person gave the agent (text). */
  readonly agentLabel: string;
  /** What the platform calls its sensor ("Touch ID"). */
  readonly sensor: string;
  /** Test seam: one passkey gesture. */
  readonly passkeyProof: (info: PasskeyInfo) => Promise<PresenceProof | undefined>;
  /** Leaves for Home (Later, done, or nothing to connect). */
  readonly onDone: () => void;
}

/** `"agentlink": { … }` as the person would see it in the file; AgentLink's own entry only. */
export function entryText(entry: Readonly<Record<string, unknown>> | null): string {
  return entry === null ? '' : `"agentlink": ${JSON.stringify(entry, null, 2)}`;
}

function Entry({ title, entry }: { title: string; entry: AppChange['newEntry'] }): ReactElement {
  return (
    <div className="fr-entry-row">
      <span className="al-text-label al-muted">{title}</span>
      {/* Selectable text; focusable so a keyboard can reach and scroll it. */}
      <pre className="al-text-code" role="region" aria-label={title} tabIndex={0}>
        {entryText(entry)}
      </pre>
    </div>
  );
}

export function ConnectApp({
  appsApi,
  appId,
  appName,
  folder,
  agentLabel,
  sensor,
  passkeyProof,
  onDone,
}: ConnectAppProps): ReactElement {
  const [view, setView] = useState<View>({ k: 'loading' });
  const [info, setInfo] = useState<PasskeyInfo | undefined | 'unknown'>('unknown');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const live = useRef(true);
  const title = useTitleFocus<HTMLHeadingElement>(view.k);

  const show = useCallback(
    (result: PreviewResult): void => {
      if (!live.current) return;
      if (result.kind === 'change') {
        if (result.change.kind === 'disconnect') setView({ k: 'status', status: 'present' });
        else setView({ k: 'change', change: result.change });
      } else if (result.kind === 'status') {
        const s = result.status;
        setView({
          k: 'status',
          status: s === 'quit_first' || s === 'conflict' || s === 'present' ? s : 'unreadable',
        });
      } else if (result.kind === 'session_expired') setView({ k: 'expired' });
      else if (result.kind === 'offline') setView({ k: 'down' });
      // The route is not there yet (or failed): connecting waits; the person goes on to Home.
      else onDone();
    },
    [onDone],
  );

  const preview = useCallback(async (): Promise<void> => {
    setView({ k: 'loading' });
    show(await appsApi.preview(appId, folder));
  }, [appsApi, appId, folder, show]);

  useEffect(() => {
    live.current = true;
    void preview();
    void appsApi.passkey().then((p) => {
      if (live.current) setInfo(p);
    });
    return () => {
      live.current = false;
    };
  }, [appsApi, preview]);

  const fail = (change: AppChange, result: Exclude<ApplyResult, { kind: 'done' }>): void => {
    if (result.kind === 'session_expired') return setView({ k: 'expired' });
    if (result.kind === 'offline') return setView({ k: 'down' });
    if (result.kind === 'refused' && result.reason === 'quit_first') {
      return setView({ k: 'status', status: 'quit_first' });
    }
    if (result.kind === 'refused' && result.reason === 'changed') {
      setMessage(T.changed);
      return setView({ k: 'change', change });
    }
    if (result.kind === 'rejected' || result.kind === 'required') {
      setMessage(T.notYet);
      return setView({ k: 'change', change });
    }
    if (result.kind === 'wait') {
      setMessage(SETUP_MESSAGES.wait(result.seconds));
      return setView({ k: 'change', change });
    }
    if (result.kind === 'busy') {
      setMessage(SETUP_MESSAGES.busy);
      return setView({ k: 'change', change });
    }
    setView({ k: 'failed', change });
  };

  const apply = async (change: AppChange): Promise<void> => {
    setMessage(undefined);
    let proof: PresenceProof | undefined;
    if (info !== 'unknown' && info !== undefined) {
      proof = await passkeyProof(info);
    } else if (code !== '') {
      proof = { kind: 'code', code };
      setCode('');
    }
    if (proof === undefined) {
      setMessage(T.notYet);
      return;
    }
    setView({ k: 'working', change });
    const result = await appsApi.apply(change.changeId, proof);
    if (!live.current) return;
    if (result.kind === 'done') setView({ k: 'done' });
    else fail(change, result);
  };

  if (view.k === 'loading') return <LoadingState text={T.loading} />;
  if (view.k === 'expired') return <LinkExpiredState />;
  if (view.k === 'down') return <NotRunningState />;

  const heading = (text: string): ReactElement => (
    <h1 id="fr-connect-h" ref={title} tabIndex={-1} className="al-text-title-1">
      {text}
    </h1>
  );
  const named = (
    <div className="fr-chosen-name">
      <AppMark name={appName} />
      <span className="al-text-body">{appName}</span>
    </div>
  );

  if (view.k === 'done') {
    return (
      <section className="fr-card" aria-labelledby="fr-connect-h">
        {heading(T.restart(appName))}
        <Banner tone="success">
          <span role="status">{T.connected(appName)}</span>
        </Banner>
        <p className="al-text-body al-muted">{T.restartNote}</p>
        <div className="fr-actions">
          <Button variant="primary" size="lg" onClick={onDone}>
            {FIRST_RUN.toHome}
          </Button>
        </div>
      </section>
    );
  }

  if (view.k === 'status') {
    const status = view.status;
    return (
      <section className="fr-card" aria-labelledby="fr-connect-h">
        {heading(T.title(appName, agentLabel))}
        {named}
        {status === 'quit_first' ? (
          <>
            <Banner tone="warning" title={T.quitFirst(appName)}>
              {T.quitNote}
            </Banner>
            <div className="fr-actions">
              <Button variant="primary" size="lg" onClick={() => void preview()}>
                {T.checkAgain}
              </Button>
              <Button variant="ghost" size="sm" onClick={onDone}>
                {T.later}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Banner tone={status === 'present' ? 'success' : 'warning'}>
              {status === 'conflict'
                ? `${T.foreign} ${T.foreignNote}`
                : status === 'present'
                  ? T.alreadyDone(appName)
                  : T.unreadable}
            </Banner>
            <div className="fr-actions">
              {status === 'unreadable' ? (
                <Button variant="secondary" onClick={() => void preview()}>
                  {T.tryAgain}
                </Button>
              ) : null}
              <Button variant={status === 'present' ? 'primary' : 'ghost'} onClick={onDone}>
                {status === 'present' ? FIRST_RUN.toHome : T.later}
              </Button>
            </div>
          </>
        )}
      </section>
    );
  }

  const change = view.change;
  const working = view.k === 'working';
  const useCode = info === undefined;
  const failed = view.k === 'failed';
  return (
    <section className="fr-card" aria-labelledby="fr-connect-h">
      {heading(T.title(change.name, agentLabel))}
      {named}
      <p className="al-text-body">{T.intro(change.name)}</p>
      <div className="fr-entry">
        <div className="fr-entry-row">
          <span className="al-text-label al-muted">{T.file}</span>
          <code className="al-text-code">{change.path}</code>
        </div>
        {change.kind === 'move' ? (
          <div className="fr-move">
            <p className="al-text-body">
              {T.moveNote(change.name, change.oldAgent ?? '', change.newAgent ?? change.folder)}
            </p>
            <Entry title={T.removed} entry={change.oldEntry} />
            <Entry title={T.entryRegion} entry={change.newEntry} />
          </div>
        ) : (
          <Entry title={T.entryRegion} entry={change.newEntry} />
        )}
        <p className="al-text-body-sm al-muted">{T.folder(change.folder)}</p>
      </div>
      {failed ? (
        <Banner tone="warning">{T.couldntChange(change.name)}</Banner>
      ) : message === undefined ? null : (
        <Banner tone="warning">{message}</Banner>
      )}
      {working ? (
        <ProgressBar label={T.connecting} indeterminate />
      ) : failed ? (
        <div className="fr-actions">
          <Button variant="primary" size="lg" onClick={() => void preview()}>
            {T.tryAgain}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDone}>
            {T.later}
          </Button>
        </div>
      ) : (
        <div className="fr-actions">
          {useCode ? (
            <TextField
              label={T.codeLabel}
              hint={T.presenceHint}
              name="owner-code"
              type="password"
              autoComplete="off"
              spellCheck={false}
              mono
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
            />
          ) : null}
          <Button
            variant="primary"
            size="lg"
            icon="key-round"
            disabled={info === 'unknown' || (useCode && code === '')}
            onClick={() => void apply(change)}
          >
            {useCode ? T.applyCode : T.apply(sensor)}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDone}>
            {T.later}
          </Button>
        </div>
      )}
    </section>
  );
}
