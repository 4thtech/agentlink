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
//
// W4-WIZARD (W4 UX v2 layer 1; artboards A1 to A3): first run is Get started, four steps, each its
// own route (`/start/app` → `/start/connect` → `/start/connected` → `/start/invite`), with a progress
// bar and "Skip to Home" on every step (pages/start/wizard.tsx). Step 1 picks the AI app (found on
// this computer or not yet); step 2 is the one Touch ID (D-140) and then the backup code, still shown
// once; step 3 is Connected ✓ (or E1: the agent is kept and Connect is offered); step 4 invites
// someone. The same steps serve an owner who has one already: New agent when no agent is open (or
// `?add=agent`), else Connect another AI app (the signed AI apps step with the exact entry). The page
// mounts again on every step, so the non-secret choices live in pages/start/store.ts; the backup
// code never leaves this component's state.
//
// W4-WIRE-2 (owner Decision 52 (2)): Add agent (the agent dropdown's "Add agent", Agents' "New agent",
// `/start/app?add=agent`) names the agent first ("Name your agent", the agent-name rules, then the
// server's check), then the pick, then the one Touch ID that creates and connects (W4-ONE-TOUCH
// begin/finish). `?add=agent` stays on every step, so an open agent never turns it into Connect
// another AI app, and a new Add agent starts with nothing kept from an earlier run. It ends on Home
// in the app (no reload), and the agents are read again.
import { Banner, Button, CopyPrompt, Fingerprint, ProgressBar, TextField } from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { lazyPart } from '../../lazy/index.js';
import { INVITE_PATH } from '../../nav.js';
import { createInviteApi, type InviteApi } from '../contacts/invite-api.js';
import { navigate } from '../../router.js';
import { announceAgentsChanged } from '../agents/use-agents.js';
import { createAgentsApi, type AgentsApi } from '../agents/api.js';
import {
  LinkExpiredState,
  LoadingState,
  NotRunningState,
  rememberRecoveryKitLater,
} from '../../states/index.js';
import { passkeyProof as browserPasskeyProof } from '../contacts/owner.js';
import type { PasskeyInfo, PresenceProof } from '../contacts/owner.js';
import { useTitleFocus } from '../welcome/index.js';
import { CreateAgentGate } from '../apps/create-agent-gate.js';
import type { CreateAgentApi } from '../apps/create-agent-api.js';
import { readAgentSignal } from '../home/start-here-api.js';
import type { AgentSignal } from '../home/start-here.js';
import { markLeavingStart, skipToHome } from '../start/guard.js';
import {
  forgetAbandonedAdd,
  markAutoShown,
  rememberWizard,
  resetWizard,
  wizardMemory,
  type WizardOutcome,
} from '../start/store.js';
import {
  CONNECT_STEP as S,
  NAME_STEP as NS,
  PICK_STEP as P,
  type StepId,
} from '../start/strings.js';
import {
  AgentCard,
  BackButton,
  ConnectedStep,
  FingerprintGlyph,
  InviteStep,
  NameStep,
  PickStep,
  WizardFrame,
  appTiles,
  defaultChoice,
  stepOf,
  stepPath,
} from '../start/wizard.js';
import { createAppsApi, type AppsApi, type DetectedApp } from './apps-api.js';
import { ConnectApp } from './connect-app.js';
import type { PickList } from './pick-app.js';
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
import { createJoinApi, type JoinRead } from '../join/api.js';
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

/**
 * W4-WIRE: Get started step 4 is U4's invite panel (the same one as the Invite screen), loaded on
 * first use so the first load of the app does not carry it.
 */
const INVITE_PANEL = lazyPart(async () => (await import('../invite/invite-panel.js')).InvitePanel);

/** W4-WIRE: the invite calls of step 4, with the cancels still on their way. */
function trackCancels(base: InviteApi): { api: InviteApi; settled: () => Promise<void> } {
  const inFlight = new Set<Promise<unknown>>();
  const api: InviteApi = {
    ...base,
    cancel: (id) => {
      const sent = base.cancel(id);
      inFlight.add(sent);
      void sent.finally(() => inFlight.delete(sent)).catch(() => undefined);
      return sent;
    },
  };
  const settled = (): Promise<void> =>
    Promise.race([
      Promise.allSettled([...inFlight]).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  return { api, settled };
}

/** U3-a (D-138; 08 §1): first run, and the passkey switch on this page, finish on Home. */
const HOME = '/settings/home';

/** U3-invite (08 §4, b11 §33.2): first run ends on the waiting invite, when there is one. */
const JOIN = '/settings/join';

/**
 * Home, with a full load: the shell then reads the new owner and agent fresh. U3-invite: when
 * `agentlink join` left an invite waiting, first run ends on "Accept {name}'s invite?" instead.
 */
function openHome(): void {
  void endFirstRun(() => createJoinApi().read());
}

/** Where first run ends: the join screen while an invite waits, else Home (tests pass `read`). */
export function endFirstRun(read: () => Promise<JoinRead>): Promise<void> {
  return read()
    .catch((): JoinRead => ({ kind: 'failed' }))
    .then((answer) => {
      const waiting = answer.kind === 'ok' && answer.state !== 'none';
      // IR-W4-WIZARD-1: this full load ends Get started; its open-on-launch check keeps Home.
      // W4-WIRE (U2 low): only an ending on Home needs the mark (the join screen is never guarded).
      if (!waiting) markLeavingStart();
      window.location.assign(waiting ? JOIN : HOME);
    });
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
  /** W4-WIZARD test seams: the step (default: from the path), how a step opens (default: the app's
   *  router), "Skip to Home", New agent's server calls, U4's invite panel, the open agent's signal. */
  readonly step?: StepId;
  readonly go?: (path: string, replace?: boolean) => void;
  readonly onSkip?: () => void;
  readonly createAgentApi?: CreateAgentApi;
  readonly invitePanel?: ReactNode;
  readonly readSignal?: () => Promise<AgentSignal | undefined>;
  /** U3-invite: whether `agentlink join` left an invite waiting, and how its screen opens. */
  readonly readJoin?: () => Promise<JoinRead>;
  readonly openJoin?: () => void;
  /** W4-WIRE-2: the agents (names already used, and opening the new one). Default: the server's. */
  readonly agentsApi?: Pick<AgentsApi, 'list' | 'switchTo'>;
}

interface Done {
  readonly confirmed: boolean;
  readonly passkey: boolean;
  readonly fingerprint: string;
  readonly sendFolder: SendFolderOutcome;
  /** Present only while the "Your backup code" step is on screen. */
  readonly ownerCode?: string;
  readonly computerName?: string;
  /** W4-ONE-TOUCH: the app the one gesture connected (or tried to). */
  readonly app?: { readonly id: string; readonly name: string; readonly connected: boolean };
}

type View =
  | { readonly k: 'loading' }
  /** W4-WIZARD: the step the path names, for the mode (pick, New agent, Connect another app). */
  | { readonly k: 'step' }
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
 * W4-WIZARD (A1 step 2, "Confirm it's you"): the agent card with its suggested name ("Change name"
 * opens the field), and one primary button for the one gesture (D-140: it creates the owner and the
 * agent and connects the picked app). The backup code stays the alternative. Enter in the field does
 * not submit: focus moves to the button.
 */
function ConnectFirstStep({
  view,
  name,
  appName,
  noPrf,
  sensorWords,
  platform,
  onName,
  onBack,
  onGo,
}: {
  view: Extract<View, { k: 'protect' }>;
  name: string;
  /** The picked app's name; undefined when it is not on this computer (no app is connected). */
  appName: string | undefined;
  noPrf: boolean;
  sensorWords: string;
  platform: Platform;
  onName: (value: string) => void;
  onBack: () => void;
  onGo: (withoutPasskey: boolean) => void;
}): ReactElement {
  const title = useTitleFocus<HTMLHeadingElement>();
  const [renaming, setRenaming] = useState(false);
  const editing = renaming || view.fieldError !== undefined;
  const press = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    document.getElementById('fr-go')?.focus();
  };
  const shown = name.trim() === '' ? N.suggested(appName) : name.trim();
  return (
    <section className="st-screen st-w-560" aria-labelledby="fr-h">
      <BackButton onBack={onBack} label={S.back} />
      <div className="st-intro">
        <span className="st-eyebrow">
          {appName === undefined ? T.protectTitle : S.eyebrow(appName)}
        </span>
        <h1 id="fr-h" ref={title} tabIndex={-1} className="st-title">
          {S.title}
        </h1>
        <p className="st-lead">{S.body(appName ?? T.yourAiApp)}</p>
      </div>
      <AgentCard
        name={shown}
        line={appName === undefined ? T.noAppYet : S.worksIn(appName)}
        action={
          editing ? null : (
            <Button
              variant="ghost"
              size="sm"
              aria-label={S.renameLabel(shown)}
              disabled={view.working}
              onClick={() => setRenaming(true)}
            >
              {S.rename}
            </Button>
          )
        }
      />
      {editing ? (
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
      ) : null}
      {noPrf ? (
        <Banner tone="warning">{T.noPrf(SENSOR[platform], WORKING_BROWSER[platform])}</Banner>
      ) : null}
      {view.message === undefined ? null : <Banner tone="warning">{view.message}</Banner>}
      <div className="st-actions">
        {view.working ? (
          <ProgressBar label={N.setting} indeterminate />
        ) : (
          <Button
            id="fr-go"
            variant="primary"
            size="lg"
            className="st-go al-press"
            onClick={() => onGo(noPrf)}
          >
            {noPrf ? null : <FingerprintGlyph />}
            {view.message !== undefined ? T.tryAgain : noPrf ? T.backupOnly : sensorWords}
          </Button>
        )}
        {noPrf || view.working ? null : (
          <Button variant="ghost" size="sm" onClick={() => onGo(true)}>
            {N.backupInstead}
          </Button>
        )}
        <p className="st-note" role="status" aria-live="polite">
          {view.working
            ? T.waiting
            : appName === undefined
              ? T.passkeyNote
              : S.restartNote(appName)}
        </p>
      </div>
      {/* D-130 (2): what the one confirmation also sets up, before it is given. */}
      <details className="st-folders">
        <summary className="st-note">{T.foldersTitle}</summary>
        <dl>
          {T.folders.map(([what, where]) => (
            <div key={where}>
              <dt className="st-note">{what}</dt>
              <dd className="al-text-code">{where}</dd>
            </div>
          ))}
        </dl>
        <p className="st-note">{T.foldersNote}</p>
      </details>
    </section>
  );
}

/** W4-WIZARD: what Get started does here, decided from the real state at load (never a flag). */
type Mode =
  /** No owner yet: the one gesture creates the owner, the agent and the app's entry (D-140). */
  | { readonly k: 'first' }
  /** An owner and no open agent, or "Add agent": New agent's one gesture (create + connect). */
  | { readonly k: 'add' }
  /** An owner and an open agent: connect another AI app to it (the signed AI apps step). */
  | { readonly k: 'more'; readonly folder: string };

/** The path the page is on, kept current as the app moves between the steps. */
function useStartPath(): string {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('popstate', onChange);
      window.addEventListener('agentlink:navigate', onChange);
      return () => {
        window.removeEventListener('popstate', onChange);
        window.removeEventListener('agentlink:navigate', onChange);
      };
    },
    () => location.pathname,
  );
}

/** "Add agent" reuses the steps: `/start/app?add=agent`. */
// IR-W4-WIZARD-SEC-1 L2: `add` (value `agent`) is the only query key Get started reads; any other
// key or value is ignored and never reaches a request.
function wantsNewAgent(): boolean {
  return new URLSearchParams(location.search).get('add') === 'agent';
}

/** The query Add agent keeps on every step. */
const ADD_QUERY = '?add=agent';

// The agent-name rule here: no control characters, and (IR-W4-WIRE-2X-SEC-1) no bidi controls or
// invisible format characters, which could make a name read as another; the server checks again.
const CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/**
 * W4-WIRE-2: Add agent starts from nothing (a name or a pick of an earlier run is not kept), and a
 * run that is not Add agent drops what Add agent kept. The look for AI apps is kept either way.
 */
function startRun(): void {
  const memory = wizardMemory();
  const adding = wantsNewAgent();
  if (adding === (memory.adding === true)) return;
  const apps = memory.apps;
  resetWizard();
  rememberWizard({ ...(apps === undefined ? {} : { apps }), ...(adding ? { adding } : {}) });
}

/** W4-WIRE-2: Add agent ends on Home in the app (no reload); the agents are read again. */
function leaveAddAgent(): void {
  resetWizard();
  announceAgentsChanged();
  skipToHome();
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
  goHome: givenHome,
  step: givenStep,
  go = (path: string, replace?: boolean) => navigate(path, replace === true),
  onSkip,
  createAgentApi,
  invitePanel,
  readSignal = readAgentSignal,
  readJoin = () => createJoinApi().read(),
  openJoin = () => window.location.assign(JOIN),
  agentsApi: givenAgents,
}: FirstRunPageProps = {}): ReactElement {
  // W4-WIRE-2: decided once per mount, before the remembered choices are read.
  useState(startRun);
  const goHome = givenHome ?? (wantsNewAgent() ? leaveAddAgent : openHome);
  const [api] = useState<SetupApi>(() => given ?? createSetupApi());
  const [upgradeApi] = useState<UpgradeApi>(() => givenUpgrade ?? createUpgradeApi());
  const [appsApi] = useState<AppsApi>(() => givenApps ?? createAppsApi());
  const [platform] = useState<Platform>(() => givenPlatform ?? detectPlatform());
  const path = useStartPath();
  const step: StepId = givenStep ?? stepOf(path);
  const [view, setView] = useState<View>({ k: 'loading' });
  const [mode, setMode] = useState<Mode | undefined>(undefined);
  // M1-UX-FIRSTRUN-V2-c: the backup code as typed, only while the switch is on screen.
  const [code, setCode] = useState('');
  const sensor = SENSOR[platform];
  // What the person chose on earlier steps (kept in memory while the steps change; no secret).
  const memory = wizardMemory();
  // W4-WIRE: step 4's invite panel (U4) loads with the first step, so it is there, in place, when
  // step 4 opens (no move when it arrives).
  useEffect(() => {
    if (invitePanel === undefined) void INVITE_PANEL.load().catch(() => undefined);
  }, [invitePanel]);
  // A link that never left step 4 is cancelled when the panel goes (U4's rule). "Go to Home" is a
  // full load, which would cut that cancel off: the panel goes first, its cancel is answered (at
  // most 1.5 s), then Home opens.
  const stepInvites = useMemo(() => trackCancels(createInviteApi()), []);
  const [inviteGone, setInviteGone] = useState(false);
  const leaveInvite = (): void => {
    setInviteGone(true);
    window.setTimeout(() => void stepInvites.settled().then(goHome), 0);
  };
  const [list, setList] = useState<PickList>(() =>
    memory.apps === undefined
      ? { k: 'loading' }
      : memory.apps === 'unavailable'
        ? { k: 'unavailable' }
        : { k: 'ok', apps: memory.apps },
  );
  const [choice, setChoiceState] = useState(memory.choice ?? '');
  const [name, setNameState] = useState(memory.name ?? '');
  // W4-WIRE-2: Add agent's "Name your agent" step: passed, why a name can't be used, checking.
  const [named, setNamedState] = useState(memory.named === true);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [naming, setNaming] = useState(false);
  const [agents] = useState(() => givenAgents ?? createAgentsApi());
  // IR-W4-WIRE-2X-1: the names the owner's agents have, for the "already have" hint (Add agent).
  const [takenNames, setTakenNames] = useState<ReadonlySet<string>>(() => new Set());
  const setNamed = (value: boolean): void => {
    setNamedState(value);
    rememberWizard({ named: value });
  };
  const [noPrfHere, setNoPrfHere] = useState(false);
  const backupTitle = useTitleFocus<HTMLHeadingElement>(view.k);
  const mounted = useRef(true);
  const tiles = useMemo(
    () =>
      list.k === 'loading'
        ? ('loading' as const)
        : appTiles(
            list.k === 'ok' ? list.apps : undefined,
            mode?.k === 'more' ? mode.folder : undefined,
          ),
    [list, mode],
  );
  const picked = choice !== '' ? choice : tiles === 'loading' ? '' : defaultChoice(tiles);
  const pickedTile = tiles === 'loading' ? undefined : tiles.find((t) => t.id === picked);
  // Only an app found on this computer is connected; a "Not found yet" pick creates the agent alone.
  const chosenApp: DetectedApp | undefined =
    list.k === 'ok' ? list.apps.find((a) => a.id === picked) : undefined;
  const setChoice = (id: string): void => {
    setChoiceState(id);
    rememberWizard({ choice: id });
  };
  const setName = (value: string): void => {
    setNameState(value);
    setNameError(undefined);
    rememberWizard({ name: value });
  };
  useEffect(() => {
    mounted.current = true;
    // Get started is open: the app does not open it again by itself in this page's life.
    markAutoShown();
    return () => {
      mounted.current = false;
      // IR-W4-WIRE-2X-1: leaving Get started (not moving between its steps) ends an Add agent.
      if (!location.pathname.startsWith('/start/')) forgetAbandonedAdd();
    };
  }, []);

  /** The look for AI apps runs once per page life (kept while the steps change). */
  const lookForApps = useCallback((): void => {
    if (wizardMemory().apps !== undefined) return;
    rememberWizard({ apps: 'unavailable' });
    void appsApi.list().then((result) => {
      if (result.kind === 'ok') rememberWizard({ apps: result.apps });
      else rememberWizard({ apps: undefined });
      if (!mounted.current) return;
      if (result.kind === 'ok') setList({ k: 'ok', apps: result.apps });
      else if (result.kind === 'session_expired') setView({ k: 'expired' });
      else if (result.kind === 'offline') setView({ k: 'down' });
      else setList({ k: 'unavailable' });
    });
  }, [appsApi]);

  /**
   * M1-UX-FIRSTRUN-V2-c: an owner exists. Without a usable passkey (and with passkeys in this
   * browser) the page offers the switch first. Otherwise Get started goes on for this owner: New
   * agent when no agent is open (or "Add agent"), else Connect another AI app. `race`: the owner
   * appeared while this page was setting one up: say so and never offer setup.
   */
  const existingOwner = useCallback(
    async (isLive: () => boolean = () => true, race = false): Promise<void> => {
      const info = await upgradeApi.info();
      if (!isLive()) return;
      if (info.kind === 'error' && info.problem === 'session_expired') {
        setView({ k: 'expired' });
        return;
      }
      if (race) {
        setView({ k: 'already' });
        return;
      }
      if (info.kind === 'ok' && !info.registered && available()) {
        const prf = await prfSupport().catch((): PrfSupport => 'unknown');
        if (isLive()) {
          setView({ k: 'upgrade', values: info.values, working: false, noPrf: prf === 'no' });
        }
        return;
      }
      const agent = await appsApi.currentAgent();
      if (!isLive()) return;
      if (agent.kind === 'ok' && !wantsNewAgent()) {
        setMode({ k: 'more', folder: agent.folder });
      } else setMode({ k: 'add' });
      lookForApps();
      setView({ k: 'step' });
    },
    [upgradeApi, available, prfSupport, appsApi, lookForApps],
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
              setMode({ k: 'first' });
              lookForApps();
              setView({ k: 'step' });
            });
        }
      } else if (result.problem === 'session_expired') setView({ k: 'expired' });
      else if (result.problem === 'offline') setView({ k: 'down' });
      else setView({ k: 'stuck', message: setupMessage(result) });
    });
    return () => {
      live = false;
    };
  }, [api, available, prfSupport, existingOwner, lookForApps]);

  // The look's answer, when it arrived while another step was on screen.
  useEffect(() => {
    if (list.k !== 'loading') return undefined;
    const known = wizardMemory().apps;
    if (known !== undefined && known !== 'unavailable') setList({ k: 'ok', apps: known });
    return undefined;
  }, [list, view]);

  // W4-WIRE-2: Add agent keeps `?add=agent` on every step.
  const toStep = (next: StepId, replace = false): void =>
    go(stepPath(next) + (wantsNewAgent() ? ADD_QUERY : ''), replace);

  /**
   * W4-WIRE-2: "Name your agent" → the pick. The agent-name rules first (1 to 32 characters, no
   * control characters), then the server says whether it would sign this name; nothing is created.
   */
  const submitName = async (): Promise<void> => {
    const typed = name.trim();
    const size = [...typed].length;
    if (size === 0) return setNameError(N.empty);
    if (size > NAME_MAX) return setNameError(N.tooLong);
    if (CONTROL.test(typed)) return setNameError(SETUP_MESSAGES.label_invalid);
    setNaming(true);
    const checked = await api.labelCheck(typed);
    if (!mounted.current) return;
    setNaming(false);
    if (checked.kind === 'refused') return setNameError(SETUP_MESSAGES.label_invalid);
    if (checked.kind === 'error') {
      if (checked.problem === 'offline') return setView({ k: 'down' });
      if (checked.problem === 'session_expired') return setView({ k: 'expired' });
      return setNameError(setupMessage(checked));
    }
    setName(typed);
    setNamed(true);
  };

  // IR-W4-WIRE-2X-1: Add agent reads the agents' names once, for the hint (never a rule).
  const adding = mode?.k === 'add';
  useEffect(() => {
    if (!adding) return undefined;
    let live = true;
    void agents.list().then(
      (result) => {
        if (live && result.kind === 'ok') {
          setTakenNames(new Set(result.list.agents.map((a) => a.label)));
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [adding, agents]);

  /** W4-WIRE-2: "Open {name}" on Add agent's Connected: open the new agent, then Home. */
  const openNewAgent = async (folder: string): Promise<void> => {
    const read = await agents.list().catch(() => undefined);
    const generation = read?.kind === 'ok' ? read.list.generation : undefined;
    if (generation !== undefined) await agents.switchTo(folder, generation).catch(() => undefined);
    goHome();
  };

  /** Step 1 → 2: the name follows the app until the person edits it. */
  const toConnect = (): void => {
    if (pickedTile === undefined) return;
    // Remembered for the next step's page (this one is about to leave).
    rememberWizard({ choice: pickedTile.id });
    toStep('connect');
  };

  const label = name.trim() === '' ? N.suggested(pickedTile?.name) : name.trim();

  const protect = useCallback(
    async (noPrf: boolean) => {
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
      // W4-ONE-TOUCH (D-140): the picked app (found on this computer) is connected by the same one
      // gesture; begin fixes the plan, finish carries only its nonce.
      const app = chosenApp;
      const begun = await api.begin(label, app?.id);
      if (begun.kind === 'owner_exists') return existingOwner(undefined, true);
      if (begun.kind === 'error') return problem(begun);
      // Without PRF here, any passkey: the gesture proves presence, the backup code approves.
      const made = await createPasskey(begun.publicKey, { platform: !noPrf });
      if (made.kind === 'unsupported') return setView({ k: 'unsupported' });
      if (made.kind === 'cancelled') return again(SETUP_MESSAGES.cancelled);
      let finished;
      try {
        finished = await api.finish(made.body, begun.nonce);
      } finally {
        made.body.fill(0);
      }
      if (finished.kind === 'owner_exists') return existingOwner(undefined, true);
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
          ...(finished.app === undefined || app === undefined || finished.app !== app.id
            ? {}
            : { app: { id: app.id, name: app.name, connected: finished.connected === true } }),
        },
      });
    },
    [api, createPasskey, existingOwner, label, chosenApp],
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

  /** The connect step ends: remember the outcome (no secret) and open Connected. */
  const finishStep = (outcome: WizardOutcome): void => {
    rememberWizard({ outcome });
    setView({ k: 'step' });
    toStep('connected');
  };

  // The owner code is dropped from state when the owner leaves the step that shows it. The recovery
  // kit is put off ("Later", remembered for the banner). W4-WIZARD: then Connected (A2).
  const leave = (done: Done): void => {
    rememberRecoveryKitLater();
    // The backup code leaves the page now, whichever screen comes next (L-3).
    setView({ k: 'leaving' });
    // U3-invite (08 §4, b11 §33.2): an invite left waiting by `agentlink join` comes first.
    void readJoin()
      .catch((): JoinRead => ({ kind: 'failed' }))
      .then((answer) => {
        if (answer.kind === 'ok' && answer.state !== 'none') return openJoin();
        finishStep({ label, ...(done.app === undefined ? {} : { app: done.app }) });
      });
  };

  /** E1 (04 §2.8 "created_not_connected"): Connect, the ordinary signed AI apps step. */
  const connectNow = async (app: { readonly id: string; readonly name: string }): Promise<void> => {
    setView({ k: 'leaving' });
    const agent = await appsApi.currentAgent();
    if (!mounted.current) return;
    if (agent.kind !== 'ok') return goHome();
    setView({
      k: 'connect',
      appId: app.id,
      appName: app.name,
      folder: agent.folder,
      label: wizardMemory().outcome?.label ?? label,
    });
  };

  // Each step opens its own view once the mode is known (a direct visit to a later step without its
  // earlier choices goes back to step 1; Connected without an outcome reads the real state).
  useEffect(() => {
    // Back to step 1 (the browser's Back, or "Back"): the pick shows again.
    // IR-W4-WIZARD-SEC-1 L1: leaving step 2 while the backup code shows (Back/Forward, a typed
    // address) is "I saved it" without the click: the code leaves the state and the page, never
    // hidden to come back; the kit is put off as with the click.
    if (view.k === 'done' && step !== 'connect') {
      rememberRecoveryKitLater();
      rememberWizard({
        outcome: { label, ...(view.done.app === undefined ? {} : { app: view.done.app }) },
      });
      setView({ k: 'step' });
      return;
    }
    if (step === 'app' && view.k === 'protect' && !view.working) {
      setView({ k: 'step' });
      return;
    }
    if (view.k !== 'step' || mode === undefined) return;
    if (step === 'connect') {
      if (wizardMemory().choice === undefined) return toStep('app', true);
      // W4-WIRE-2: Add agent's connect step needs its name first.
      if (mode.k === 'add' && wizardMemory().named !== true) return toStep('app', true);
      if (mode.k === 'first') setView({ k: 'protect', working: false, noPrf: noPrfHere });
    }
  }, [view, mode, step, noPrfHere]);

  // Connected (A2), opened without this page's outcome (a reload, a deep link): from the real state.
  const [derived, setDerived] = useState<WizardOutcome | 'none' | undefined>(undefined);
  useEffect(() => {
    if (step !== 'connected' || wizardMemory().outcome !== undefined) return undefined;
    let live = true;
    void readSignal().then(
      (signal) => {
        if (!live) return;
        if (signal?.connected === true && signal.appName !== null) {
          setDerived({ label: '', app: { id: '', name: signal.appName, connected: true } });
        } else {
          setDerived('none');
          toStep('app', true);
        }
      },
      () => {
        if (live) setDerived('none');
      },
    );
    return () => {
      live = false;
    };
  }, [step]);

  const sensorWords = S.connect(sensor);
  const frame = (body: ReactElement, at: StepId = step): ReactElement => (
    <WizardFrame step={at} {...(onSkip === undefined ? {} : { onSkip })}>
      {body}
    </WizardFrame>
  );

  // Steps 3 and 4 need no owner read: they show what happened, or the real state.
  if (step === 'connected' && view.k !== 'connect' && view.k !== 'leaving') {
    const outcome = wizardMemory().outcome ?? (typeof derived === 'object' ? derived : undefined);
    if (outcome === undefined) return frame(<LoadingState text={T.loading} />);
    const app = outcome.app;
    return frame(
      <ConnectedStep
        label={outcome.label}
        {...(app === undefined ? {} : { app })}
        {...(wantsNewAgent() && outcome.agent !== undefined
          ? { onOpen: () => void openNewAgent(outcome.agent ?? '') }
          : {})}
        onInvite={() => toStep('invite')}
        onHome={goHome}
        {...(app === undefined || app.connected || app.id === ''
          ? {}
          : { onConnect: () => void connectNow(app) })}
      />,
    );
  }
  if (step === 'invite') {
    return frame(
      <InviteStep
        inviteHref={INVITE_PATH}
        onHome={invitePanel === undefined ? leaveInvite : goHome}
        panel={
          invitePanel ?? (inviteGone ? <></> : <INVITE_PANEL.Part invites={stepInvites.api} />)
        }
      />,
    );
  }

  switch (view.k) {
    case 'loading':
      return frame(<LoadingState text={T.loading} />);
    case 'expired':
      return <LinkExpiredState />;
    case 'down':
      return <NotRunningState />;
    case 'stuck':
      return frame(
        <section className="st-screen st-w-560" aria-labelledby="fr-h">
          <h1 id="fr-h" className="st-title-2">
            {T.protectTitle}
          </h1>
          <Banner tone="warning">{view.message}</Banner>
        </section>,
      );
    case 'upgrade': {
      const { values, noPrf } = view;
      return frame(
        <section className="st-screen st-w-560" aria-labelledby="fr-h">
          <h1 id="fr-h" className="st-title-2">
            {U.title(platform)}
          </h1>
          <p className="st-lead">{U.body(sensor)}</p>
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
              {noPrf ? T.usePasskey : platformButton(platform)}
            </Button>
          </form>
          <p className="st-note" role="status" aria-live="polite">
            {view.working ? T.waiting : T.passkeyNote}
          </p>
        </section>,
      );
    }
    case 'upgraded':
      return frame(
        <section className="st-screen st-w-560" aria-labelledby="fr-h">
          <h1 id="fr-h" className="st-title-2">
            {U.doneTitle(platform)}
          </h1>
          <p className="st-lead">{U.doneBody(sensor)}</p>
          <div className="st-actions">
            <a className="al-btn al-btn-primary al-btn-lg" href={HOME}>
              {U.toHome}
            </a>
          </div>
        </section>,
      );
    case 'already':
      return frame(
        <section className="st-screen st-w-560" aria-labelledby="fr-h">
          <h1 id="fr-h" className="st-title-2">
            {T.alreadyTitle}
          </h1>
          <p className="st-lead">{T.alreadyBody}</p>
        </section>,
      );
    case 'unsupported':
      return frame(
        <section className="st-screen st-w-560" aria-labelledby="fr-h">
          <h1 id="fr-h" className="st-title-2">
            {T.unsupportedTitle}
          </h1>
          <p className="st-lead">{T.unsupportedBody}</p>
          <CopyPrompt command={T.unsupportedCommand} />
        </section>,
      );
    case 'leaving':
      return frame(<LoadingState text={T.leaving} />);
    case 'connect':
      // E1: Connect after created_not_connected (the AI apps step, with the exact entry).
      return frame(
        <ConnectApp
          appsApi={appsApi}
          appId={view.appId}
          appName={view.appName}
          folder={view.folder}
          agentLabel={view.label}
          sensor={sensor}
          passkeyProof={passkeyProof}
          onDone={goHome}
          onConnected={() =>
            finishStep({
              label: view.label,
              app: { id: view.appId, name: view.appName, connected: true },
            })
          }
        />,
        'connect',
      );
    case 'protect': {
      const noPrf = view.noPrf === true;
      return frame(
        <ConnectFirstStep
          view={view}
          name={name === '' ? label : name}
          appName={chosenApp?.name}
          noPrf={noPrf}
          sensorWords={sensorWords}
          platform={platform}
          onName={setName}
          onBack={() => toStep('app')}
          onGo={(withoutPasskey) => void protect(withoutPasskey)}
        />,
      );
    }
    case 'done': {
      const { done } = view;
      const line = sendLine(done.sendFolder);
      return frame(
        <section className="st-screen st-w-560" aria-labelledby="fr-h">
          <h1 id="fr-h" ref={backupTitle} tabIndex={-1} className="st-title-2">
            {T.backupTitle}
          </h1>
          {done.confirmed ? null : (
            <Banner tone="warning" title={T.unconfirmedTitle}>
              {T.unconfirmed}
            </Banner>
          )}
          <p className="st-lead">{done.passkey ? T.doneBody : T.doneNoPasskeyBody}</p>
          {line === undefined ? null : (
            <Banner tone={done.sendFolder === 'allowed' ? 'success' : 'warning'}>{line}</Banner>
          )}
          <p className="al-text-body">
            <Fingerprint value={done.fingerprint} prefix={T.fingerprintLabel} />
          </p>
          <p className="st-note">{T.fingerprintNote}</p>
          <BackupCode
            code={done.ownerCode ?? ''}
            computer={done.computerName ?? ''}
            sensor={done.passkey ? sensor : SENSOR.other}
            onSaved={() => leave(done)}
          />
        </section>,
        'connect',
      );
    }
    case 'step':
      break;
  }

  // view 'step': the mode decides what this step shows.
  if (mode === undefined) return frame(<LoadingState text={T.loading} />);
  const eyebrow =
    mode.k === 'first' ? P.eyebrow : mode.k === 'add' ? P.eyebrowAdd : P.eyebrowConnect;
  if (step === 'app' && mode.k === 'add' && !named) {
    // W4-WIRE-2: Add agent names the agent first.
    return (
      <WizardFrame step="app" stepName={NS.stepName} {...(onSkip === undefined ? {} : { onSkip })}>
        <NameStep
          value={name}
          onChange={setName}
          onContinue={() => void submitName()}
          taken={takenNames.has(name.trim())}
          working={naming}
          {...(nameError === undefined ? {} : { error: nameError })}
        />
      </WizardFrame>
    );
  }
  if (step === 'app') {
    return frame(
      <PickStep
        tiles={tiles}
        choice={picked}
        onChoose={setChoice}
        onContinue={toConnect}
        eyebrow={eyebrow}
        lookFailed={list.k === 'unavailable'}
        mac={platform === 'mac'}
        {...(mode.k === 'add' ? { onBack: () => setNamed(false) } : {})}
      />,
    );
  }
  // Step 2 for an owner who has one already: New agent, or Connect another AI app.
  const appName = pickedTile?.name ?? '';
  if (mode.k === 'add') {
    return frame(
      <section className="st-screen st-w-560" aria-labelledby="fr-h">
        <BackButton onBack={() => toStep('app')} label={S.back} />
        <div className="st-intro">
          <span className="st-eyebrow">{S.eyebrow(appName)}</span>
          <h1 id="fr-h" className="st-title">
            {S.title}
          </h1>
          <p className="st-lead">{S.body(appName)}</p>
        </div>
        <AgentCard name={label} line={S.worksIn(appName)} />
        <CreateAgentGate
          label={label}
          summary=""
          app={chosenApp ?? null}
          goLabel={sensorWords}
          {...(createAgentApi === undefined ? {} : { api: createAgentApi })}
          appsApi={appsApi}
          onCancel={() => toStep('app')}
          onDone={(created) =>
            finishStep({
              label: created.label,
              agent: created.name,
              ...(created.app === undefined ? {} : { app: created.app }),
            })
          }
        />
        <p className="st-note">{S.restartNote(appName)}</p>
      </section>,
    );
  }
  // First run's step 2 is the protect view (set by the effect above, or between steps): wait.
  if (mode.k === 'first') return frame(<LoadingState text={T.loading} />);
  const folder = mode.folder;
  if (chosenApp === undefined) {
    // "Not found yet": nothing on this computer to connect; say what to do, then back or Home.
    return frame(
      <section className="st-screen st-w-560" aria-labelledby="fr-h">
        <BackButton onBack={() => toStep('app')} label={S.back} />
        <div className="st-intro">
          <span className="st-eyebrow">{S.eyebrow(appName)}</span>
          <h1 id="fr-h" className="st-title-2">
            {T.notFoundTitle(appName)}
          </h1>
          <p className="st-lead">{T.notFoundBody(appName)}</p>
        </div>
      </section>,
    );
  }
  return frame(
    <ConnectApp
      appsApi={appsApi}
      appId={chosenApp.id}
      appName={chosenApp.name}
      folder={folder}
      agentLabel={folder}
      sensor={sensor}
      passkeyProof={passkeyProof}
      onDone={goHome}
      onConnected={() =>
        finishStep({
          label: folder,
          app: { id: chosenApp.id, name: chosenApp.name, connected: true },
        })
      }
    />,
  );
}

/** The upgrade button's words for the platform. */
function platformButton(platform: Platform): string {
  return platform === 'mac'
    ? T.useTouchId
    : platform === 'windows'
      ? T.useWindowsHello
      : T.usePasskey;
}
