// W4-ONE-TOUCH (D-140; 04 §2.8; 11 §5.8 "Create and connect"; b11 §29.4): the one screen of New
// agent: the statement ("Add {label}"), "Connect to {app}" prefilled with a detected AI app that no
// agent uses yet (unticked = "Not now"), and one button for the one gesture (or the backup code).
// The page never signs; begin fixes the plan on the server right before the gesture, and finish
// carries only the begin nonce and the proof (create-agent-api.ts).
//
// W8-F13 (04 §2.5; HOTFIX-045-TOUCHID's switch): an owner without a passkey on this computer is
// offered the switch first, inside the gate: the backup code once and one touch register the
// passkey (passkey-switch.ts, `POST /api/owner/passkey`; it signs nothing and creates nothing),
// then the new ID is created with its own touch (one entry, one operation, D-68). The server
// decides what it accepts; the gate offers the switch only when `GET /api/owner/passkey` gives the
// values for it. W8-F12: the code form says what the backup code is. W8-F11: one Back (none in
// Get started, whose own Back is on the screen), and the form spaces its field and buttons.
import { Banner, Button, TextField } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { EARLIER_OWNER_CODE_HINT } from '../../strings.js';
import { AppMark } from '../first-run/pick-app.js';
import { createAppsApi, type AppsApi, type DetectedApp } from '../first-run/apps-api.js';
import { readPasskeyStatus, type PasskeyStatus } from '../contacts/owner.js';
import {
  switchToPasskey,
  type PasskeySwitchOutcome,
  type SwitchToPasskey,
} from '../contacts/passkey-switch.js';
import { CONTACTS_STRINGS as C, PASSKEY_WHY } from '../contacts/strings.js';
import { detectPlatform } from '../first-run/passkey.js';
import {
  NAME,
  SENSOR,
  SETUP_MESSAGES,
  UPGRADE,
  UPGRADE_MESSAGES,
  WORKING_BROWSER,
  type Platform,
} from '../first-run/strings.js';
import { createAgentApi, type CreateAgentApi, type CreateFinish } from './create-agent-api.js';

/** What the sheet shows after the one gesture. */
export interface CreatedAgent {
  readonly name: string;
  readonly label: string;
  /** The app the gesture connected (or tried to), with whether its entry was written. */
  readonly app?: { readonly id: string; readonly name: string; readonly connected: boolean };
}

const MESSAGES: Partial<Record<CreateFinish['kind'] | string, string>> = {
  rejected: "That didn't work. Nothing changed. Try again.",
  required: SETUP_MESSAGES.presence_required,
  tries_exhausted: SETUP_MESSAGES.tries_exhausted,
  expired: SETUP_MESSAGES.expired,
  not_pending: SETUP_MESSAGES.expired,
  changed: SETUP_MESSAGES.changed,
  quit_first: SETUP_MESSAGES.quit_first,
  app_unavailable: SETUP_MESSAGES.app_unavailable,
  busy: SETUP_MESSAGES.busy,
  wait: SETUP_MESSAGES.wait(30),
  dismissed: SETUP_MESSAGES.cancelled,
  verification_required: SETUP_MESSAGES.presence_rejected,
  passkey_update_needed: 'Use your backup code this time.',
  label_invalid: SETUP_MESSAGES.label_invalid,
  session: SETUP_MESSAGES.session_expired,
  offline: SETUP_MESSAGES.offline,
  // F4: begin's fixed 409 `no_agent` with no ID left on this computer (the owner stays after the
  // last ID is removed). New ID builds its plan from a card naming the owner, so it can't run here
  // yet; the terminal path (init, then owner add-agent, 04 §2.8 M1-9x) can.
  no_agent:
    "No ID is left on this computer, so a new one can't be made here yet. Nothing changed. In your own terminal, run `agentlink init`, then the `agentlink owner add-agent` step it shows.",
};

/** The switch's outcome in plain words, as the presence sheet says it (presence-prompt.tsx). */
function switchNote(outcome: PasskeySwitchOutcome, platform: Platform): string {
  const unsupported = PASSKEY_WHY.switchUnsupported(SENSOR[platform], WORKING_BROWSER[platform]);
  if (outcome.kind === 'cancelled') return PASSKEY_WHY.switchCancelled;
  if (outcome.kind === 'unsupported') return unsupported;
  if (outcome.kind !== 'error') return UPGRADE_MESSAGES.failed;
  const problem = outcome.problem;
  if (problem === 'wait') return UPGRADE_MESSAGES.wait(outcome.retryAfter ?? 1);
  if (problem === 'passkey_unsupported') return unsupported;
  if (
    problem === 'presence_rejected' ||
    problem === 'presence_required' ||
    problem === 'busy' ||
    problem === 'forbidden' ||
    problem === 'offline' ||
    problem === 'session_expired'
  ) {
    return UPGRADE_MESSAGES[problem];
  }
  return UPGRADE_MESSAGES.failed;
}

/** Refusals after which the same plan may be tried again (Decision 45: the plan is kept). */
const KEEPS_PLAN: ReadonlySet<string> = new Set(['rejected', 'required', 'wait', 'busy']);

export function CreateAgentGate({
  label,
  summary,
  onDone,
  onCancel,
  api: givenApi,
  appsApi: givenApps,
  app: givenApp,
  goLabel,
  platform: givenPlatform,
  passkeyStatus = readPasskeyStatus,
  switchPasskey = switchToPasskey,
}: {
  label: string;
  /** The statement line ("Add {label}"). */
  summary: string;
  onDone: (created: CreatedAgent) => void;
  /** The gate's own Back; absent where the screen has one already (Get started). */
  onCancel?: () => void;
  /** Test seams; the app's own server calls by default. */
  api?: CreateAgentApi;
  appsApi?: AppsApi;
  /**
   * W4-WIZARD: the AI app picked in Get started (null: none). When given, the gate connects exactly
   * that app and shows no "Connect to {app}" choice; when absent, it offers the first free app.
   */
  app?: DetectedApp | null;
  /** W4-WIZARD: the one button's words ("Connect with Touch ID"). */
  goLabel?: string;
  /** The platform (the sensor's name). Default: detected from the browser. */
  platform?: Platform;
  /** W8-F13 seams (tests): the passkey state read and the one-time switch. */
  passkeyStatus?: () => Promise<PasskeyStatus>;
  switchPasskey?: SwitchToPasskey;
}): ReactElement {
  const [api] = useState<CreateAgentApi>(() => givenApi ?? createAgentApi());
  const [appsApi] = useState<AppsApi>(() => givenApps ?? createAppsApi());
  const [free, setFree] = useState<DetectedApp | undefined>(undefined);
  const [connect, setConnect] = useState(true);
  const [useCode, setUseCode] = useState(false);
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [canPasskey, setCanPasskey] = useState(true);
  // W8-F13: what `GET /api/owner/passkey` says (read once), the switch form and its outcome.
  const [status, setStatus] = useState<PasskeyStatus | undefined>(undefined);
  const [switching, setSwitching] = useState(false);
  const [switched, setSwitched] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const [platform] = useState<Platform>(() => givenPlatform ?? detectPlatform());
  const sensor = SENSOR[platform];
  // The held plan's nonce for retries with the backup code (Decision 45), and the app it was for.
  const held = useRef<{ nonce: string; app: string | undefined } | undefined>(undefined);
  // The one button, worded as every presence sheet of the app (Contacts, Rename, Remove).
  const useLabel = C.usePasskey;

  const readStatus = async (): Promise<PasskeyStatus> => {
    try {
      return await passkeyStatus();
    } catch {
      return { kind: 'unavailable', reason: 'unknown' };
    }
  };

  useEffect(() => {
    mounted.current = true;
    void readStatus().then((read) => {
      if (mounted.current) setStatus(read);
    });
    return () => {
      mounted.current = false;
    };
    // Read once per gate; a switch reads it again.
  }, []);

  useEffect(() => {
    if (givenApp !== undefined) {
      setFree(givenApp ?? undefined);
      return undefined;
    }
    let live = true;
    void appsApi.list().then((result) => {
      if (!live || result.kind !== 'ok') return;
      // A detected app no agent uses yet ("Not connected yet", b11 §29.2), never one that is open
      // and rewrites its file (Claude Desktop running).
      setFree(result.apps.find((a) => a.state === 'not_connected' && !a.quitFirst));
    });
    return () => {
      live = false;
    };
  }, [appsApi, givenApp]);

  const app = free !== undefined && connect ? free : undefined;

  const settle = (outcome: CreateFinish): void => {
    if (outcome.kind === 'done' || outcome.kind === 'created_not_connected') {
      held.current = undefined;
      onDone({
        name: outcome.name,
        label: outcome.label,
        ...(app === undefined || outcome.app !== app.id
          ? {}
          : { app: { id: app.id, name: app.name, connected: outcome.kind === 'done' } }),
      });
      return;
    }
    if (!KEEPS_PLAN.has(outcome.kind)) held.current = undefined;
    if (outcome.kind === 'passkey_update_needed') {
      setCanPasskey(false);
      setUseCode(true);
    }
    setError(MESSAGES[outcome.kind] ?? SETUP_MESSAGES.unknown);
  };

  /** Begins a plan (or keeps the held one for the same app) and returns its nonce. */
  const plan = async (
    keep: boolean,
  ): Promise<
    { nonce: string; pk?: Parameters<CreateAgentApi['finishPasskey']>[1] } | undefined
  > => {
    const id = app?.id;
    if (keep && held.current !== undefined && held.current.app === id) {
      return { nonce: held.current.nonce };
    }
    const begun = await api.begin(label, id);
    if (begun.kind !== 'ready') {
      setError(
        begun.kind === 'refused'
          ? (MESSAGES[begun.status] ?? SETUP_MESSAGES.unknown)
          : (MESSAGES[begun.kind] ?? SETUP_MESSAGES.unknown),
      );
      return undefined;
    }
    held.current = { nonce: begun.nonce, app: id };
    if (begun.publicKey.allowCredentials.length === 0) setCanPasskey(false);
    return { nonce: begun.nonce, pk: begun.publicKey };
  };

  const withPasskey = async (): Promise<void> => {
    setWorking(true);
    setError(undefined);
    try {
      const begun = await plan(false);
      if (begun?.pk === undefined) return;
      if (begun.pk.allowCredentials.length === 0) {
        setUseCode(true);
        return;
      }
      settle(await api.finishPasskey(begun.nonce, begun.pk));
    } finally {
      setWorking(false);
    }
  };

  const withCode = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (working || code.length === 0) return;
    setWorking(true);
    setError(undefined);
    try {
      const begun = await plan(true);
      if (begun === undefined) return;
      const typed = code;
      setCode('');
      settle(await api.finishCode(begun.nonce, typed));
    } finally {
      setWorking(false);
    }
  };

  const switchTo = status?.kind === 'unavailable' && !switched ? status.switchTo : undefined;
  // The server says this computer has no passkey for this owner: the Touch ID button could only
  // fall back to the code, so the code form (with why) is shown at once. Without the switch values
  // (no ID open) the switch can't be offered here (`POST /api/owner/passkey` needs an open ID).
  const noneHere =
    status?.kind === 'unavailable' && status.reason === 'not_set_up_here' && !switched;

  /** W8-F13: the backup code once and one touch register the passkey; nothing is created yet. */
  const submitSwitch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (switchTo === undefined || working) return;
    if (code.length === 0) {
      setNote(UPGRADE_MESSAGES.empty);
      return;
    }
    const typed = code;
    setWorking(true);
    setNote(undefined);
    setError(undefined);
    void (async () => {
      const outcome = await switchPasskey(switchTo, typed);
      if (!mounted.current) return;
      setCode('');
      if (
        outcome.kind === 'switched' ||
        (outcome.kind === 'error' && outcome.problem === 'passkey_exists')
      ) {
        const read = await readStatus();
        if (!mounted.current) return;
        setWorking(false);
        if (read.kind === 'ready') {
          setStatus(read);
          setSwitched(true);
          setSwitching(false);
          setUseCode(false);
          setCanPasskey(true);
        } else {
          setNote(UPGRADE_MESSAGES.failed);
        }
        return;
      }
      setWorking(false);
      setNote(switchNote(outcome, platform));
    })();
  };

  // Why the code is asked for instead of Touch ID, in plain words (HOTFIX-045-TOUCHID).
  const why =
    status?.kind === 'unavailable' && !switched
      ? status.reason === 'browser'
        ? PASSKEY_WHY.browser(sensor, WORKING_BROWSER[platform])
        : PASSKEY_WHY[status.reason](sensor)
      : undefined;
  const back =
    onCancel === undefined ? null : (
      <Button variant="ghost" disabled={working} onClick={onCancel}>
        {NAME.back}
      </Button>
    );
  const switchButton = (variant: 'primary' | 'secondary'): ReactElement => (
    <Button
      variant={variant}
      icon="key-round"
      disabled={working}
      onClick={() => {
        setSwitching(true);
        setNote(undefined);
        setCode('');
      }}
    >
      {UPGRADE.bannerAction(platform)}
    </Button>
  );
  const codeField = (
    <TextField
      label="Backup code"
      hint={EARLIER_OWNER_CODE_HINT}
      name="backup-code"
      type="password"
      autoComplete="current-password"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      mono
      value={code}
      disabled={working}
      onChange={(e) => setCode(e.currentTarget.value)}
    />
  );

  return (
    <div className="ag-sheet-body">
      {summary === '' ? null : <p className="al-text-title-3">{summary}</p>}
      {free === undefined || givenApp !== undefined ? null : (
        <label className="ag-check">
          <input
            type="checkbox"
            checked={connect}
            disabled={working}
            onChange={(e) => {
              setConnect(e.currentTarget.checked);
              held.current = undefined;
            }}
          />
          <AppMark name={free.name} />
          <span>{NAME.connectTo(free.name)}</span>
        </label>
      )}
      {error === undefined ? null : <Banner tone="warning">{error}</Banner>}
      {switched ? (
        <p className="al-text-body-sm" role="status">
          {PASSKEY_WHY.switched(sensor)}
        </p>
      ) : null}
      {switching && switchTo !== undefined ? (
        <form className="ag-code-form" autoComplete="off" onSubmit={submitSwitch}>
          <p className="al-text-body-sm al-muted">{PASSKEY_WHY.switchIntro(sensor)}</p>
          <p className="al-text-body-sm al-muted">{NAME.codeWhat}</p>
          {codeField}
          <div className="ag-actions">
            <Button type="submit" variant="primary" icon="key-round" disabled={working}>
              {UPGRADE.bannerAction(platform)}
            </Button>
            <Button
              variant="ghost"
              disabled={working}
              onClick={() => {
                setSwitching(false);
                setNote(undefined);
                setCode('');
              }}
            >
              {PASSKEY_WHY.switchCancel}
            </Button>
          </div>
          {note === undefined ? null : (
            <p className="al-text-body-sm" role="alert">
              {note}
            </p>
          )}
        </form>
      ) : useCode || !canPasskey || (switchTo === undefined && noneHere) ? (
        <form className="ag-code-form" autoComplete="on" onSubmit={(e) => void withCode(e)}>
          {why === undefined ? null : (
            <p className="al-text-body-sm al-muted" role="status">
              {why}
            </p>
          )}
          <p className="al-text-body-sm al-muted">{NAME.codeWhat}</p>
          {codeField}
          <div className="ag-actions">
            <Button type="submit" variant="primary" disabled={working || code.length === 0}>
              {NAME.confirmCode}
            </Button>
            {switchTo === undefined ? null : switchButton('secondary')}
            {back}
          </div>
        </form>
      ) : switchTo !== undefined ? (
        <>
          <p className="al-text-body-sm al-muted">{UPGRADE.bannerBody}</p>
          <div className="ag-actions">
            {switchButton('primary')}
            <Button variant="ghost" size="sm" disabled={working} onClick={() => setUseCode(true)}>
              {NAME.backupInstead}
            </Button>
            {back}
          </div>
        </>
      ) : (
        <div className="ag-actions">
          <Button
            variant="primary"
            icon="key-round"
            disabled={working}
            onClick={() => void withPasskey()}
          >
            {goLabel ?? useLabel}
          </Button>
          <Button variant="ghost" size="sm" disabled={working} onClick={() => setUseCode(true)}>
            {NAME.backupInstead}
          </Button>
          {back}
        </div>
      )}
    </div>
  );
}
