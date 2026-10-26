// First run (d1 Local-firstrun with DESIGN-ADJ-1 (a); 02 J1 step 3; D-120; 08 §1): protect approvals
// with a passkey that creates the owner key on this computer, see the owner fingerprint and the
// collapsed backup owner code, put the recovery kit off ("Later", M1-11b-3 builds the kit step), then
// hand back to the AI with a prompt to copy.
//
// The browser never signs: the passkey ceremony is the one gesture; the owner key is created, wrapped
// and stored by the local server (setup routes, M1-11s-c). The owner code arrives once, lives only in
// this component's state while the step is on screen, and is dropped when the owner moves on.
//
// M1-UX-FIRSTRUN-V2 (D-130 (1), (2); 08 §1 first run v2; 11 §5.5, §6.2.1; proposed, owner confirms
// at merge): step 1 shows the folders setup creates, then one button named for the platform ("Use
// Touch ID"); the same gesture also allows the Send folder (the server signs the first policy).
// Step 2, "Your backup code", shows the code once as readable text and in a real form (username
// `autocomplete="username"` = "AgentLink backup code – <computer>", code `autocomplete="new-password"`)
// so "Save in my password manager" lets the browser's own save sheet appear; Copy is secondary with
// the clipboard warning; only "I saved it" moves on, and the code leaves the page then. Where the
// browser reports no passkey with PRF, the page names a browser that works, or continues with a
// backup code only. Q-130-1 (screen readers and the shown code) stays open: the code is plain text.
import { Banner, Button, CopyPrompt, Fingerprint, TextField } from '@4thtech-io/ui';
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  LinkExpiredState,
  LoadingState,
  NotRunningState,
  rememberRecoveryKitLater,
} from '../../states/index.js';
import {
  createSetupPasskey,
  detectPlatform,
  passkeysAvailable,
  prfSupport as browserPrfSupport,
  type PasskeyOptions,
  type PasskeyResult,
  type PrfSupport,
} from './passkey.js';
import {
  createSetupApi,
  type CreationValues,
  type SendFolderOutcome,
  type SetupApi,
  type SetupError,
} from './setup-api.js';
import {
  FIRST_RUN as T,
  SENSOR,
  SETUP_MESSAGES,
  STEPS,
  WORKING_BROWSER,
  type Platform,
} from './strings.js';

export interface FirstRunPageProps {
  /** Test seams; the page uses the real server and browser by default. */
  readonly api?: SetupApi;
  readonly createPasskey?: (
    values: CreationValues,
    options: PasskeyOptions,
  ) => Promise<PasskeyResult>;
  readonly passkeysAvailable?: () => boolean;
  /** The platform (button label, browser hint). Default: detected from the browser. */
  readonly platform?: Platform;
  /** Whether a passkey with PRF is available. Default: asked of the browser. */
  readonly prfSupport?: () => Promise<PrfSupport>;
}

interface Done {
  readonly confirmed: boolean;
  readonly passkey: boolean;
  readonly fingerprint: string;
  readonly sendFolder: SendFolderOutcome;
  /** Present only while the "Your backup code" step is on screen. */
  readonly ownerCode?: string;
  readonly computerName?: string;
}

type View =
  | { readonly k: 'loading' }
  | {
      readonly k: 'protect';
      readonly working: boolean;
      readonly message?: string;
      /** M1-UX-PRF-MATRIX: the browser reports no passkey with PRF here. */
      readonly noPrf?: boolean;
    }
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

function Steps({ current }: { current: 1 | 2 | 3 | 4 }): ReactElement {
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

/** The once-shown backup code: readable text, a real save form, Copy, and "I saved it". */
function BackupCode({
  code,
  computer,
  sensor,
  onSaved,
}: {
  code: string;
  computer: string;
  sensor: string;
  onSaved: () => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const [asked, setAsked] = useState(false);
  // A real form: submitting it lets the browser's own save sheet appear. It never navigates and
  // never sends anything (no action; the page's CSP has form-action 'none').
  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setAsked(true);
  };
  return (
    <section className="al-secret" aria-label={T.backupLabel}>
      <div className="al-secret-head">
        <span className="al-text-label">{T.backupLabel}</span>
        <span className="al-text-caption al-muted">{T.shownOnce}</span>
      </div>
      <div className="al-secret-val al-text-code-lg">
        {code.split(' ').map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      <p className="al-text-body-sm">{T.backupBody(sensor)}</p>
      <p className="al-text-body-sm al-muted">{T.backupLost}</p>
      <form onSubmit={save} autoComplete="on">
        <TextField
          label={T.savedAs}
          name="username"
          autoComplete="username"
          value={T.savedAsLabel(computer)}
          readOnly
        />
        <TextField
          label={T.backupLabel}
          name="password"
          type="password"
          autoComplete="new-password"
          value={code}
          readOnly
          mono
        />
        <div className="al-secret-actions">
          <Button type="submit" variant="primary" icon="key-round">
            {T.saveToManager}
          </Button>
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
      </form>
      <p className="al-text-caption al-muted">{T.clipboardWarning}</p>
      <p className="al-text-caption al-muted" role="status" aria-live="polite">
        {asked ? T.saveAsked : ''}
      </p>
      <Button variant="secondary" size="lg" block onClick={onSaved}>
        {T.savedIt}
      </Button>
    </section>
  );
}

/** The first policy's outcome in plain words (D-130 (2)); nothing when no policy was signed. */
function sendLine(outcome: SendFolderOutcome): string | undefined {
  if (outcome === 'allowed') return T.sendAllowed;
  if (outcome === 'not_allowed') return T.sendNotAllowed;
  if (outcome === 'not_confirmed') return T.sendNotConfirmed;
  return undefined;
}

export function FirstRunPage({
  api: given,
  createPasskey = createSetupPasskey,
  passkeysAvailable: available = passkeysAvailable,
  platform: givenPlatform,
  prfSupport = browserPrfSupport,
}: FirstRunPageProps = {}): ReactElement {
  const [api] = useState<SetupApi>(() => given ?? createSetupApi());
  const [platform] = useState<Platform>(() => givenPlatform ?? detectPlatform());
  const [view, setView] = useState<View>({ k: 'loading' });
  const sensor = SENSOR[platform];

  useEffect(() => {
    let live = true;
    void api.status().then((result) => {
      if (!live) return;
      if (result.kind === 'ok') {
        if (result.owner === 'set_up') setView({ k: 'already' });
        // IR-M1-11b-1-1 L-1: a failed check is never "no owner": doctor, not setup.
        else if (result.owner === 'unknown') {
          setView({ k: 'stuck', message: SETUP_MESSAGES.unknown });
        } else if (!available()) setView({ k: 'unsupported' });
        else {
          void prfSupport()
            .catch((): PrfSupport => 'unknown')
            .then((prf) => {
              if (live) setView({ k: 'protect', working: false, noPrf: prf === 'no' });
            });
        }
      } else if (result.problem === 'session_expired') setView({ k: 'expired' });
      else if (result.problem === 'offline') setView({ k: 'down' });
      else setView({ k: 'stuck', message: setupMessage(result) });
    });
    return () => {
      live = false;
    };
  }, [api, available, prfSupport]);

  const protect = useCallback(
    async (noPrf: boolean) => {
      // The same protect view, with the PRF hint kept for "Try again".
      const again = (message: string): void =>
        setView({ k: 'protect', working: false, message, noPrf });
      setView({ k: 'protect', working: true, noPrf });
      const begun = await api.begin();
      if (begun.kind === 'owner_exists') return setView({ k: 'already' });
      if (begun.kind === 'error') {
        if (begun.problem === 'session_expired') return setView({ k: 'expired' });
        return again(setupMessage(begun));
      }
      // Without PRF here, any passkey: the gesture proves presence, the backup code approves.
      const made = await createPasskey(begun.publicKey, { platform: !noPrf });
      if (made.kind === 'unsupported') return setView({ k: 'unsupported' });
      if (made.kind === 'cancelled') return again(SETUP_MESSAGES.cancelled);
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
          if (now.kind === 'ok' && now.owner === 'missing')
            return again(SETUP_MESSAGES.notFinished);
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
        return again(setupMessage(finished));
      }
      return setView({
        k: 'done',
        done: {
          confirmed: finished.confirmed,
          passkey: finished.passkey,
          fingerprint: finished.fingerprint,
          sendFolder: finished.sendFolder,
          ownerCode: finished.ownerCode,
          computerName: finished.computerName,
        },
      });
    },
    [api, createPasskey],
  );

  // The owner code is dropped from state when the owner leaves the step that shows it.
  const toKit = (done: Done): void =>
    setView({
      k: 'kit',
      done: {
        confirmed: done.confirmed,
        passkey: done.passkey,
        fingerprint: done.fingerprint,
        sendFolder: done.sendFolder,
      },
    });
  const label =
    platform === 'mac' ? T.useTouchId : platform === 'windows' ? T.useWindowsHello : T.usePasskey;

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
    case 'protect': {
      const noPrf = view.noPrf === true;
      return (
        <section aria-labelledby="fr-h">
          <Steps current={1} />
          <h1 id="fr-h" className="al-text-display">
            {T.protectTitle}
          </h1>
          <p className="al-text-body-lg al-muted">{T.protectBody(sensor)}</p>
          <aside className="al-card" aria-labelledby="fr-folders">
            <p id="fr-folders" className="al-text-label al-muted">
              {T.foldersTitle}
            </p>
            <dl className="al-text-body">
              {T.folders.map(([what, where]) => (
                <div key={where}>
                  <dt className="al-text-body-sm al-muted">{what}</dt>
                  <dd className="al-text-code">{where}</dd>
                </div>
              ))}
            </dl>
            <p className="al-text-body-sm al-muted">{T.foldersNote}</p>
          </aside>
          {noPrf ? (
            <Banner tone="warning">{T.noPrf(SENSOR[platform], WORKING_BROWSER[platform])}</Banner>
          ) : null}
          {view.message === undefined ? null : <Banner tone="warning">{view.message}</Banner>}
          <Button
            variant="primary"
            size="lg"
            icon="key-round"
            disabled={view.working}
            onClick={() => void protect(noPrf)}
          >
            {view.message !== undefined ? T.tryAgain : noPrf ? T.backupOnly : label}
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
    }
    case 'done': {
      const { done } = view;
      const line = sendLine(done.sendFolder);
      return (
        <section aria-labelledby="fr-h">
          <Steps current={2} />
          <h1 id="fr-h" className="al-text-display">
            {T.backupTitle}
          </h1>
          {done.confirmed ? null : (
            <Banner tone="warning" title={T.unconfirmedTitle}>
              {T.unconfirmed}
            </Banner>
          )}
          <p className="al-text-body-lg al-muted">
            {done.passkey ? T.doneBody : T.doneNoPasskeyBody}
          </p>
          {line === undefined ? null : (
            <Banner tone={done.sendFolder === 'allowed' ? 'success' : 'warning'}>{line}</Banner>
          )}
          <p className="al-text-body">
            <Fingerprint value={done.fingerprint} prefix={T.fingerprintLabel} />
          </p>
          <p className="al-text-caption al-muted">{T.fingerprintNote}</p>
          <BackupCode
            code={done.ownerCode ?? ''}
            computer={done.computerName ?? ''}
            sensor={done.passkey ? sensor : SENSOR.other}
            onSaved={() => toKit(done)}
          />
        </section>
      );
    }
    case 'kit':
      return (
        <section aria-labelledby="fr-h">
          <Steps current={3} />
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
          <Steps current={4} />
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
