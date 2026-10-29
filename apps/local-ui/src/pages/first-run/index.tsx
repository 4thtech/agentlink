// First run (d1 Local-firstrun with DESIGN-ADJ-1 (a); 02 J1 step 3; D-120; 08 §1; U3-g, b11 §28):
// Welcome, pick your AI app, one screen that names the agent and protects approvals with a passkey
// that creates the owner key on this computer (one gesture), the owner fingerprint and the backup
// code, the recovery kit put off ("Later", M1-11b-3 builds the kit step), then "Connect your AI app"
// as its own signed step that "Later" skips, and the end on Home (U3-a, D-138).
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
import { Banner, Button, CopyPrompt, Fingerprint, ProgressBar, TextField } from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import {
  LinkExpiredState,
  LoadingState,
  NotRunningState,
  rememberRecoveryKitLater,
} from '../../states/index.js';
import { passkeyProof as browserPasskeyProof } from '../contacts/owner.js';
import type { PasskeyInfo, PresenceProof } from '../contacts/owner.js';
import { WelcomeScreen, useTitleFocus } from '../welcome/index.js';
import { createAppsApi, type AppsApi, type DetectedApp } from './apps-api.js';
import { ConnectApp } from './connect-app.js';
import { AppMark, PickApp, type PickList } from './pick-app.js';
import {
  createSetupPasskey,
  createUpgradePasskey as browserUpgradePasskey,
  detectPlatform,
  encodeUpgradeBody,
  passkeysAvailable,
  prfSupport as browserPrfSupport,
  type PasskeyOptions,
  type PasskeyResult,
  type PrfSupport,
  type UpgradePasskeyResult,
} from './passkey.js';
import {
  createSetupApi,
  createUpgradeApi,
  type CreationValues,
  type SendFolderOutcome,
  type SetupApi,
  type SetupError,
  type UpgradeApi,
  type UpgradeResult,
  type UpgradeValues,
} from './setup-api.js';
import './first-run.css';
import {
  FIRST_RUN as T,
  NAME as N,
  NAME_MAX,
  SENSOR,
  SETUP_MESSAGES,
  UPGRADE as U,
  UPGRADE_MESSAGES,
  WORKING_BROWSER,
  type Platform,
} from './strings.js';

/** U3-a (D-138; 08 §1): first run, and the passkey switch on this page, finish on Home. */
const HOME = '/settings/home';

/** Home, with a full load: the shell then reads the new owner and agent fresh. */
function openHome(): void {
  window.location.assign(HOME);
}

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
  /** M1-UX-FIRSTRUN-V2-c: the passkey switch for an existing owner (`/api/owner/passkey`). */
  readonly upgradeApi?: UpgradeApi;
  readonly createUpgradePasskey?: (
    values: UpgradeValues,
    options: PasskeyOptions,
  ) => Promise<UpgradePasskeyResult>;
  /** U3-g: the AI apps (pick, connect). Default: the app's own server calls. */
  readonly appsApi?: AppsApi;
  /** U3-g: one passkey gesture for the connect step. Default: the browser's. */
  readonly passkeyProof?: (info: PasskeyInfo) => Promise<PresenceProof | undefined>;
  /** U3-g: where first run ends. Default: Home, with a full load. */
  readonly goHome?: () => void;
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
  /** U3-g (b11 §28.1): no owner yet. */
  | { readonly k: 'welcome' }
  /** U3-g (b11 §28.2): which AI app. */
  | { readonly k: 'pick' }
  | {
      /** U3-g (b11 §28.3): name the agent and protect approvals, one gesture. */
      readonly k: 'protect';
      readonly working: boolean;
      readonly message?: string;
      /** The name's own problem, shown under the field. */
      readonly fieldError?: string;
      /** M1-UX-PRF-MATRIX: the browser reports no passkey with PRF here. */
      readonly noPrf?: boolean;
    }
  /** U3-g: the backup code is saved; deciding between "Connect your AI app" and Home. */
  | { readonly k: 'leaving' }
  | {
      /** U3-g (b11 §28.4): connect the chosen AI app, a separate signed step. */
      readonly k: 'connect';
      readonly appId: string;
      readonly appName: string;
      readonly folder: string;
      readonly label: string;
    }
  | { readonly k: 'unsupported' }
  | {
      /** M1-UX-FIRSTRUN-V2-c (B-9): an owner without a passkey: backup code once, one gesture. */
      readonly k: 'upgrade';
      readonly values: UpgradeValues;
      readonly working: boolean;
      readonly noPrf: boolean;
      readonly message?: string;
    }
  | { readonly k: 'upgraded' }
  | { readonly k: 'already' }
  | { readonly k: 'expired' }
  | { readonly k: 'down' }
  | { readonly k: 'stuck'; readonly message: string }
  | { readonly k: 'done'; readonly done: Done };

/** A fixed problem code in plain words (never server or browser text). */
export function setupMessage(problem: SetupError | { readonly problem: 'cancelled' }): string {
  if (problem.problem === 'wait') {
    return SETUP_MESSAGES.wait('retryAfter' in problem ? (problem.retryAfter ?? 1) : 1);
  }
  return SETUP_MESSAGES[problem.problem];
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

/**
 * U3-g (b11 §28.3): name the agent and protect approvals on one screen. The name is a plain text
 * field (any text up to 32 characters; the server checks it again before Touch ID); the one primary
 * button is the one gesture. Enter in the field does not submit: focus moves to the button.
 */
function NameStep({
  view,
  name,
  app,
  noPrf,
  label,
  platform,
  onName,
  onChange,
  onBack,
  onGo,
}: {
  view: Extract<View, { k: 'protect' }>;
  name: string;
  app: DetectedApp | undefined;
  noPrf: boolean;
  label: string;
  platform: Platform;
  onName: (value: string) => void;
  onChange: () => void;
  onBack: () => void;
  onGo: (withoutPasskey: boolean) => void;
}): ReactElement {
  const title = useTitleFocus<HTMLHeadingElement>();
  const press = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    document.getElementById('fr-go')?.focus();
  };
  return (
    <section className="fr-card" aria-labelledby="fr-h">
      <h1 id="fr-h" ref={title} tabIndex={-1} className="al-text-title-1">
        {T.protectTitle}
      </h1>
      {app === undefined ? null : (
        <div className="fr-chosen">
          <div className="fr-chosen-name">
            <AppMark name={app.name} />
            <span className="al-text-body">{app.name}</span>
          </div>
          <Button variant="ghost" size="sm" aria-label={N.changeLabel(app.name)} onClick={onChange}>
            {N.change}
          </Button>
        </div>
      )}
      <TextField
        label={N.label}
        hint={N.hint}
        name="agent-name"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={name}
        readOnly={view.working}
        {...(view.fieldError === undefined ? {} : { error: view.fieldError })}
        onChange={(event) => onName(event.currentTarget.value)}
        onKeyDown={press}
        onFocus={(event) => {
          // Selected on open: the suggested name is replaced by typing.
          event.currentTarget.select();
        }}
      />
      {noPrf ? (
        <Banner tone="warning">{T.noPrf(SENSOR[platform], WORKING_BROWSER[platform])}</Banner>
      ) : null}
      {view.message === undefined ? null : <Banner tone="warning">{view.message}</Banner>}
      <div className="fr-actions">
        {view.working ? (
          <ProgressBar label={N.setting} indeterminate />
        ) : (
          <Button
            id="fr-go"
            variant="primary"
            size="lg"
            icon="key-round"
            onClick={() => onGo(noPrf)}
          >
            {view.message !== undefined ? T.tryAgain : noPrf ? T.backupOnly : label}
          </Button>
        )}
        {noPrf || view.working ? null : (
          <Button variant="ghost" size="sm" onClick={() => onGo(true)}>
            {N.backupInstead}
          </Button>
        )}
        <p className="al-text-caption al-muted" role="status" aria-live="polite">
          {view.working ? T.waiting : T.passkeyNote}
        </p>
      </div>
      <aside className="fr-folders" aria-labelledby="fr-folders">
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
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          {N.back}
        </Button>
      </div>
    </section>
  );
}

export function FirstRunPage({
  api: given,
  createPasskey = createSetupPasskey,
  passkeysAvailable: available = passkeysAvailable,
  platform: givenPlatform,
  prfSupport = browserPrfSupport,
  upgradeApi: givenUpgrade,
  createUpgradePasskey = browserUpgradePasskey,
  appsApi: givenApps,
  passkeyProof = browserPasskeyProof,
  goHome = openHome,
}: FirstRunPageProps = {}): ReactElement {
  const [api] = useState<SetupApi>(() => given ?? createSetupApi());
  const [upgradeApi] = useState<UpgradeApi>(() => givenUpgrade ?? createUpgradeApi());
  const [appsApi] = useState<AppsApi>(() => givenApps ?? createAppsApi());
  const [platform] = useState<Platform>(() => givenPlatform ?? detectPlatform());
  const [view, setView] = useState<View>({ k: 'loading' });
  // M1-UX-FIRSTRUN-V2-c: the backup code as typed, only while the switch is on screen.
  const [code, setCode] = useState('');
  const sensor = SENSOR[platform];
  // U3-g: what the person chose before the one gesture. Nothing here is sent until they press it.
  const [list, setList] = useState<PickList>({ k: 'loading' });
  const [choice, setChoice] = useState('');
  const [name, setName] = useState('');
  const [edited, setEdited] = useState(false);
  const [noPrfHere, setNoPrfHere] = useState(false);
  const asked = useRef(false);
  const backupTitle = useTitleFocus<HTMLHeadingElement>(view.k);
  const mounted = useRef(true);
  const picked = choice !== '' ? choice : list.k === 'ok' ? (list.apps[0]?.id ?? 'later') : 'later';
  const chosenApp: DetectedApp | undefined =
    list.k === 'ok' ? list.apps.find((a) => a.id === picked) : undefined;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * M1-UX-FIRSTRUN-V2-c: an owner exists. Without a usable passkey (and with passkeys in this
   * browser) the page offers the switch; otherwise approvals are already protected. A failed read
   * never offers setup.
   */
  const existingOwner = useCallback(
    async (isLive: () => boolean = () => true): Promise<void> => {
      const info = await upgradeApi.info();
      if (!isLive()) return;
      if (info.kind !== 'ok' || info.registered || !available()) {
        if (info.kind === 'error' && info.problem === 'session_expired') {
          setView({ k: 'expired' });
        } else setView({ k: 'already' });
        return;
      }
      const prf = await prfSupport().catch((): PrfSupport => 'unknown');
      if (isLive()) {
        setView({ k: 'upgrade', values: info.values, working: false, noPrf: prf === 'no' });
      }
    },
    [upgradeApi, available, prfSupport],
  );

  useEffect(() => {
    let live = true;
    void api.status().then((result) => {
      if (!live) return;
      if (result.kind === 'ok') {
        if (result.owner === 'set_up') void existingOwner(() => live);
        // IR-M1-11b-1-1 L-1: a failed check is never "no owner": doctor, not setup.
        else if (result.owner === 'unknown') {
          setView({ k: 'stuck', message: SETUP_MESSAGES.unknown });
        } else if (!available()) setView({ k: 'unsupported' });
        else {
          void prfSupport()
            .catch((): PrfSupport => 'unknown')
            .then((prf) => {
              if (!live) return;
              setNoPrfHere(prf === 'no');
              setView({ k: 'welcome' });
            });
        }
      } else if (result.problem === 'session_expired') setView({ k: 'expired' });
      else if (result.problem === 'offline') setView({ k: 'down' });
      else setView({ k: 'stuck', message: setupMessage(result) });
    });
    return () => {
      live = false;
    };
  }, [api, available, prfSupport, existingOwner]);

  /** U3-g (b11 §28.2): the look for AI apps runs once, when the pick screen first opens. */
  const toPick = useCallback((): void => {
    setView({ k: 'pick' });
    if (asked.current) return;
    asked.current = true;
    void appsApi.list().then((result) => {
      if (!mounted.current) return;
      if (result.kind === 'ok') setList({ k: 'ok', apps: result.apps });
      else if (result.kind === 'session_expired') setView({ k: 'expired' });
      else if (result.kind === 'offline') setView({ k: 'down' });
      else setList({ k: 'unavailable' });
    });
  }, [appsApi]);

  /** U3-g (b11 §28.3): the suggested name follows the app until the person edits it. */
  const toName = (): void => {
    if (!edited) setName(N.suggested(chosenApp?.name));
    setView({ k: 'protect', working: false, noPrf: noPrfHere });
  };

  const protect = useCallback(
    async (noPrf: boolean) => {
      const label = name.trim();
      // The same protect view, with the PRF hint kept for "Try again".
      const again = (message?: string, fieldError?: string): void =>
        setView({
          k: 'protect',
          working: false,
          noPrf,
          ...(message === undefined ? {} : { message }),
          ...(fieldError === undefined ? {} : { fieldError }),
        });
      const problem = (error: SetupError): void => {
        if (error.problem === 'session_expired') return setView({ k: 'expired' });
        if (error.problem === 'label_invalid')
          return again(undefined, SETUP_MESSAGES.label_invalid);
        again(setupMessage(error));
      };
      const size = [...label].length;
      if (size === 0) return again(undefined, N.empty);
      if (size > NAME_MAX) return again(undefined, N.tooLong);
      setView({ k: 'protect', working: true, noPrf });
      // The server says whether it would sign this name before Touch ID is asked for.
      const checked = await api.labelCheck(label);
      if (checked.kind === 'refused') return again(undefined, SETUP_MESSAGES.label_invalid);
      if (checked.kind === 'error') {
        if (checked.problem === 'offline') return setView({ k: 'down' });
        return problem(checked);
      }
      const begun = await api.begin(label);
      if (begun.kind === 'owner_exists') return existingOwner();
      if (begun.kind === 'error') return problem(begun);
      // Without PRF here, any passkey: the gesture proves presence, the backup code approves.
      const made = await createPasskey(begun.publicKey, { platform: !noPrf });
      if (made.kind === 'unsupported') return setView({ k: 'unsupported' });
      if (made.kind === 'cancelled') return again(SETUP_MESSAGES.cancelled);
      let finished;
      try {
        finished = await api.finish(made.body, label);
      } finally {
        made.body.fill(0);
      }
      if (finished.kind === 'owner_exists') return existingOwner();
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
        return problem(finished);
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
    [api, createPasskey, existingOwner, name],
  );

  /**
   * M1-UX-FIRSTRUN-V2-c (B-9): the backup code once, then one passkey gesture, in one owner
   * operation of the server (`POST /api/owner/passkey`), which checks the code (with the wrong-code
   * backoff) and keeps the same owner. The code goes only into that one body; its bytes are zeroed
   * after sending and the field is cleared once the server has answered.
   */
  const upgrade = useCallback(
    async (values: UpgradeValues, noPrf: boolean, typed: string) => {
      const again = (message: string, clear: boolean): void => {
        if (clear) setCode('');
        setView({ k: 'upgrade', values, working: false, noPrf, message });
      };
      if (typed.length === 0) return again(UPGRADE_MESSAGES.empty, false);
      setView({ k: 'upgrade', values, working: true, noPrf });
      const made = await createUpgradePasskey(values, { platform: !noPrf });
      if (made.kind === 'cancelled') return again(UPGRADE_MESSAGES.cancelled, false);
      if (made.kind === 'unsupported') {
        return again(UPGRADE_MESSAGES.unsupported(WORKING_BROWSER[platform]), true);
      }
      const secret = new TextEncoder().encode(typed);
      let body: Uint8Array;
      try {
        body = encodeUpgradeBody(secret, made.body);
      } catch {
        return again(UPGRADE_MESSAGES.presence_required, true);
      } finally {
        secret.fill(0);
        made.body.fill(0);
      }
      let result: UpgradeResult;
      try {
        result = await upgradeApi.register(body);
      } finally {
        body.fill(0);
      }
      setCode('');
      if (result.kind === 'registered') return setView({ k: 'upgraded' });
      const problem = result.problem;
      if (problem === 'passkey_exists') return setView({ k: 'already' });
      if (problem === 'session_expired') return setView({ k: 'expired' });
      if (problem === 'offline') return setView({ k: 'down' });
      if (problem === 'wait') return again(UPGRADE_MESSAGES.wait(result.retryAfter ?? 1), true);
      if (problem === 'passkey_unsupported') {
        return again(UPGRADE_MESSAGES.unsupported(WORKING_BROWSER[platform]), true);
      }
      if (
        problem === 'presence_rejected' ||
        problem === 'presence_required' ||
        problem === 'busy' ||
        problem === 'forbidden'
      ) {
        return again(UPGRADE_MESSAGES[problem], true);
      }
      // needs_setup, failed, unknown: never offer a plain retry; doctor tells what is wrong.
      return setView({ k: 'stuck', message: UPGRADE_MESSAGES.failed });
    },
    [createUpgradePasskey, upgradeApi, platform],
  );

  // The owner code is dropped from state when the owner leaves the step that shows it. The recovery
  // kit is put off ("Later", remembered for the banner); with an AI app chosen and an agent folder
  // to connect it to, "Connect your AI app" follows, otherwise Home.
  const leave = async (): Promise<void> => {
    rememberRecoveryKitLater();
    setView({ k: 'leaving' });
    const app = chosenApp;
    if (app === undefined) return goHome();
    const agent = await appsApi.currentAgent();
    if (!mounted.current) return;
    if (agent.kind !== 'ok') return goHome();
    setView({
      k: 'connect',
      appId: app.id,
      appName: app.name,
      folder: agent.folder,
      label: name.trim(),
    });
  };
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
    case 'upgrade': {
      const { values, noPrf } = view;
      return (
        <section aria-labelledby="fr-h">
          <h1 id="fr-h" className="al-text-display">
            {U.title(platform)}
          </h1>
          <p className="al-text-body-lg al-muted">{U.body(sensor)}</p>
          {noPrf ? (
            <Banner tone="warning">{U.noPrf(SENSOR[platform], WORKING_BROWSER[platform])}</Banner>
          ) : null}
          {view.message === undefined ? null : <Banner tone="warning">{view.message}</Banner>}
          {/* A real form so a password manager can fill the code; it never navigates (no action;
              the page's CSP has form-action 'none') and sends nothing itself. */}
          <form
            autoComplete="on"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (!view.working) void upgrade(values, noPrf, code);
            }}
          >
            <TextField
              label={U.codeLabel}
              hint={U.codeHint}
              name="backup-code"
              type="password"
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              mono
              value={code}
              disabled={view.working}
              onChange={(event) => setCode(event.currentTarget.value)}
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              icon="key-round"
              disabled={view.working}
            >
              {noPrf ? T.usePasskey : label}
            </Button>
          </form>
          <p className="al-text-caption al-muted" role="status" aria-live="polite">
            {view.working ? T.waiting : T.passkeyNote}
          </p>
        </section>
      );
    }
    case 'upgraded':
      return (
        <section aria-labelledby="fr-h">
          <h1 id="fr-h" className="al-text-display">
            {U.doneTitle(platform)}
          </h1>
          <p className="al-text-body-lg al-muted">{U.doneBody(sensor)}</p>
          <a className="al-btn al-btn-primary al-btn-lg" href={HOME}>
            {U.toHome}
          </a>
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
          <h1 id="fr-h" className="al-text-title-1">
            {T.unsupportedTitle}
          </h1>
          <p className="al-text-body al-muted">{T.unsupportedBody}</p>
          <CopyPrompt command={T.unsupportedCommand} />
        </section>
      );
    case 'welcome':
      return <WelcomeScreen onStart={toPick} />;
    case 'pick':
      return (
        <PickApp
          list={list}
          choice={picked}
          onChoose={setChoice}
          onContinue={toName}
          onBack={() => setView({ k: 'welcome' })}
        />
      );
    case 'leaving':
      return <LoadingState text={T.leaving} />;
    case 'connect':
      return (
        <ConnectApp
          appsApi={appsApi}
          appId={view.appId}
          appName={view.appName}
          folder={view.folder}
          agentLabel={view.label}
          sensor={sensor}
          passkeyProof={passkeyProof}
          onDone={goHome}
        />
      );
    case 'protect': {
      const noPrf = view.noPrf === true;
      return (
        <NameStep
          view={view}
          name={name}
          app={chosenApp}
          noPrf={noPrf}
          label={label}
          platform={platform}
          onName={(value) => {
            setName(value);
            setEdited(true);
          }}
          onChange={toPick}
          onBack={toPick}
          onGo={(withoutPasskey) => void protect(withoutPasskey)}
        />
      );
    }
    case 'done': {
      const { done } = view;
      const line = sendLine(done.sendFolder);
      return (
        <section aria-labelledby="fr-h">
          <h1 id="fr-h" ref={backupTitle} tabIndex={-1} className="al-text-display">
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
            onSaved={() => void leave()}
          />
        </section>
      );
    }
  }
}
