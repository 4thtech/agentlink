// First run (d1 Local-firstrun with DESIGN-ADJ-1 (a); 02 J1 step 3; D-120; 08 §1): protect approvals
// with a passkey that creates the owner key on this computer, see the owner fingerprint and the
// collapsed backup owner code, put the recovery kit off ("Later", M1-11b-3 builds the kit step), then
// hand back to the AI with a prompt to copy.
//
// The browser never signs: the passkey ceremony is the one gesture; the owner key is created, wrapped
// and stored by the local server (setup routes, M1-11s-c). The owner code arrives once, lives only in
// this component's state while the step is on screen, and is dropped when the owner moves on.
import { Banner, Button, CopyPrompt, Fingerprint, SecretDisplay } from '@4thtech-io/ui';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  LinkExpiredState,
  LoadingState,
  NotRunningState,
  rememberRecoveryKitLater,
} from '../../states/index.js';
import { createSetupPasskey, passkeysAvailable, type PasskeyResult } from './passkey.js';
import {
  createSetupApi,
  type CreationValues,
  type SetupApi,
  type SetupError,
} from './setup-api.js';
import { FIRST_RUN as T, SETUP_MESSAGES, STEPS } from './strings.js';

export interface FirstRunPageProps {
  /** Test seams; the page uses the real server and browser by default. */
  readonly api?: SetupApi;
  readonly createPasskey?: (values: CreationValues) => Promise<PasskeyResult>;
  readonly passkeysAvailable?: () => boolean;
}

interface Done {
  readonly confirmed: boolean;
  readonly passkey: boolean;
  readonly fingerprint: string;
  /** Present only while the "Approvals are protected" step is on screen. */
  readonly ownerCode?: string;
}

type View =
  | { readonly k: 'loading' }
  | { readonly k: 'protect'; readonly working: boolean; readonly message?: string }
  | { readonly k: 'unsupported' }
  | { readonly k: 'already' }
  | { readonly k: 'expired' }
  | { readonly k: 'down' }
  | { readonly k: 'stuck'; readonly message: string }
  | { readonly k: 'done'; readonly done: Done }
  | { readonly k: 'kit'; readonly done: Done }
  | { readonly k: 'ready'; readonly done: Done };

/** A fixed problem code in plain words (never server or browser text). */
export function setupMessage(problem: SetupError | { readonly problem: 'cancelled' }): string {
  if (problem.problem === 'wait') {
    return SETUP_MESSAGES.wait('retryAfter' in problem ? (problem.retryAfter ?? 1) : 1);
  }
  return SETUP_MESSAGES[problem.problem];
}

function Steps({ current }: { current: 1 | 2 | 3 }): ReactElement {
  return (
    <nav aria-label="Setup steps">
      <ol className="al-text-label">
        {STEPS.map((name, i) => (
          <li key={name} aria-current={i + 1 === current ? 'step' : undefined}>
            {i + 1 < current ? `✓ ${name}` : `${String(i + 1)} ${name}`}
          </li>
        ))}
      </ol>
      <p className="al-text-label al-muted">{T.stepOf(current)}</p>
    </nav>
  );
}

function CodeBlock({ code }: { code: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <section className="al-secret" aria-label={T.backupLabel}>
      <div className="al-secret-head">
        <span className="al-text-label">{T.backupLabel}</span>
      </div>
      <div className="al-secret-val al-text-code-lg">
        {code.split(' ').map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      <p className="al-text-body-sm al-muted">{T.backupExplain}</p>
      <div className="al-secret-actions">
        <Button
          size="sm"
          icon={copied ? 'check' : 'copy'}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(code)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? T.copied : T.copy}
        </Button>
      </div>
    </section>
  );
}

export function FirstRunPage({
  api: given,
  createPasskey = createSetupPasskey,
  passkeysAvailable: available = passkeysAvailable,
}: FirstRunPageProps = {}): ReactElement {
  const [api] = useState<SetupApi>(() => given ?? createSetupApi());
  const [view, setView] = useState<View>({ k: 'loading' });

  useEffect(() => {
    let live = true;
    void api.status().then((result) => {
      if (!live) return;
      if (result.kind === 'ok') {
        if (result.owner === 'set_up') setView({ k: 'already' });
        // IR-M1-11b-1-1 L-1: a failed check is never "no owner": doctor, not setup.
        else if (result.owner === 'unknown') {
          setView({ k: 'stuck', message: SETUP_MESSAGES.unknown });
        } else setView(available() ? { k: 'protect', working: false } : { k: 'unsupported' });
      } else if (result.problem === 'session_expired') setView({ k: 'expired' });
      else if (result.problem === 'offline') setView({ k: 'down' });
      else setView({ k: 'stuck', message: setupMessage(result) });
    });
    return () => {
      live = false;
    };
  }, [api, available]);

  const protect = useCallback(async () => {
    setView({ k: 'protect', working: true });
    const begun = await api.begin();
    if (begun.kind === 'owner_exists') return setView({ k: 'already' });
    if (begun.kind === 'error') {
      if (begun.problem === 'session_expired') return setView({ k: 'expired' });
      return setView({ k: 'protect', working: false, message: setupMessage(begun) });
    }
    const made = await createPasskey(begun.publicKey);
    if (made.kind === 'unsupported') return setView({ k: 'unsupported' });
    if (made.kind === 'cancelled') {
      return setView({ k: 'protect', working: false, message: SETUP_MESSAGES.cancelled });
    }
    let finished;
    try {
      finished = await api.finish(made.body);
    } finally {
      made.body.fill(0);
    }
    if (finished.kind === 'owner_exists') return setView({ k: 'already' });
    if (finished.kind === 'error') {
      if (finished.problem === 'session_expired') return setView({ k: 'expired' });
      if (finished.problem === 'offline') {
        // IR-M1-11b-1-1 L-2: the server may have saved the owner before the answer was lost, so
        // check again before offering anything; never a plain retry over a kept owner.
        const now = await api.status();
        if (now.kind === 'ok' && now.owner === 'missing') {
          return setView({ k: 'protect', working: false, message: SETUP_MESSAGES.notFinished });
        }
        if (now.kind === 'ok' && now.owner === 'set_up') {
          return setView({ k: 'stuck', message: SETUP_MESSAGES.finishedNoCode });
        }
        if (now.kind === 'error' && now.problem === 'offline') return setView({ k: 'down' });
        if (now.kind === 'error' && now.problem === 'session_expired') {
          return setView({ k: 'expired' });
        }
        return setView({ k: 'stuck', message: SETUP_MESSAGES.unknown });
      }
      if (
        finished.problem === 'keychain' ||
        finished.problem === 'check_failed' ||
        finished.problem === 'internal' ||
        finished.problem === 'unknown'
      ) {
        // Something may have been kept: never offer "try again" over it (08 §1).
        return setView({ k: 'stuck', message: setupMessage(finished) });
      }
      return setView({ k: 'protect', working: false, message: setupMessage(finished) });
    }
    return setView({
      k: 'done',
      done: {
        confirmed: finished.confirmed,
        passkey: finished.passkey,
        fingerprint: finished.fingerprint,
        ownerCode: finished.ownerCode,
      },
    });
  }, [api, createPasskey]);

  // The owner code is dropped from state when the owner leaves the step that shows it.
  const toKit = (done: Done): void =>
    setView({
      k: 'kit',
      done: { confirmed: done.confirmed, passkey: done.passkey, fingerprint: done.fingerprint },
    });

  switch (view.k) {
    case 'loading':
      return <LoadingState text={T.loading} />;
    case 'expired':
      return <LinkExpiredState />;
    case 'down':
      return <NotRunningState />;
    case 'stuck':
      return (
        <section aria-labelledby="fr-h">
          <h1 id="fr-h" className="al-text-title-1">
            {T.protectTitle}
          </h1>
          <Banner tone="warning">{view.message}</Banner>
        </section>
      );
    case 'already':
      return (
        <section aria-labelledby="fr-h">
          <h1 id="fr-h" className="al-text-title-1">
            {T.alreadyTitle}
          </h1>
          <p className="al-text-body al-muted">{T.alreadyBody}</p>
        </section>
      );
    case 'unsupported':
      return (
        <section aria-labelledby="fr-h">
          <Steps current={1} />
          <h1 id="fr-h" className="al-text-title-1">
            {T.unsupportedTitle}
          </h1>
          <p className="al-text-body al-muted">{T.unsupportedBody}</p>
          <CopyPrompt command={T.unsupportedCommand} />
        </section>
      );
    case 'protect':
      return (
        <section aria-labelledby="fr-h">
          <Steps current={1} />
          <h1 id="fr-h" className="al-text-display">
            {T.protectTitle}
          </h1>
          <p className="al-text-body-lg al-muted">{T.protectBody}</p>
          {view.message === undefined ? null : <Banner tone="warning">{view.message}</Banner>}
          <Button
            variant="primary"
            size="lg"
            icon="key-round"
            disabled={view.working}
            onClick={() => void protect()}
          >
            {view.message === undefined ? T.createPasskey : T.tryAgain}
          </Button>
          <p className="al-text-caption al-muted" role="status" aria-live="polite">
            {view.working ? T.waiting : T.passkeyNote}
          </p>
          <p className="al-text-body-sm al-muted">{T.desktopTip}</p>
          <aside className="al-card" aria-label={T.untilTitle}>
            <p className="al-text-label al-muted">{T.untilTitle}</p>
            <p className="al-text-body">{T.untilBody}</p>
          </aside>
        </section>
      );
    case 'done': {
      const { done } = view;
      const code = done.ownerCode ?? '';
      return (
        <section aria-labelledby="fr-h">
          <Steps current={1} />
          <h1 id="fr-h" className="al-text-display">
            {T.doneTitle}
          </h1>
          {done.confirmed ? null : (
            <Banner tone="warning" title={T.unconfirmedTitle}>
              {T.unconfirmed}
            </Banner>
          )}
          <p className="al-text-body-lg al-muted">
            {done.passkey ? T.doneBody : T.doneNoPasskeyBody}
          </p>
          <p className="al-text-body">
            <Fingerprint value={done.fingerprint} prefix={T.fingerprintLabel} />
          </p>
          <p className="al-text-caption al-muted">{T.fingerprintNote}</p>
          {done.passkey ? (
            <>
              <details>
                <summary className="al-text-body">{T.backupSummary}</summary>
                <CodeBlock code={code} />
              </details>
              <Button variant="primary" size="lg" onClick={() => toKit(done)}>
                {T.continue}
              </Button>
            </>
          ) : (
            <SecretDisplay
              label={T.backupLabel}
              value={code}
              explain={T.backupExplain}
              onContinue={() => toKit(done)}
            />
          )}
        </section>
      );
    }
    case 'kit':
      return (
        <section aria-labelledby="fr-h">
          <Steps current={2} />
          <h1 id="fr-h" className="al-text-display">
            {T.kitTitle}
          </h1>
          <p className="al-text-body-lg al-muted">{T.kitBody}</p>
          <Button variant="primary" size="lg" disabled aria-describedby="fr-kit-soon">
            {T.saveKit}
          </Button>
          <p id="fr-kit-soon" className="al-text-caption al-muted">
            {T.saveKitSoon}
          </p>
          <Button
            onClick={() => {
              rememberRecoveryKitLater();
              setView({ k: 'ready', done: view.done });
            }}
          >
            {T.later}
          </Button>
          <p className="al-text-caption al-muted">{T.laterNote}</p>
        </section>
      );
    case 'ready':
      return (
        <section aria-labelledby="fr-h">
          <Steps current={3} />
          <h1 id="fr-h" className="al-text-display">
            {T.readyTitle}
          </h1>
          <p className="al-text-body-lg al-muted">{T.readyBody}</p>
          <CopyPrompt size="hero" title={T.readyPromptTitle} prompt={T.readyPrompt} />
          <p className="al-text-body">{T.readyRestart}</p>
          <p className="al-text-body al-muted">{T.readyClose}</p>
        </section>
      );
  }
}
