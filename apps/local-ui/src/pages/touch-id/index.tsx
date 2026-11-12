// UX1113 WP-S2: Settings › Touch ID & master code (design-1112 §3.3; 04 §2.5 "Touch ID & master code
// page"; 08 §1). How the owner confirms that it is them, in one place.
//
// - The page never signs and never sees a seed. Each action is one POST to its owner-code route
//   (`/api/ui/owner-code/*`, `/api/ui/owner-presence/test`) through the server's central presence gate,
//   which shares the wrong-code backoff of every presence route.
// - Test Touch ID: one gesture (the desktop app's own Touch ID when it is on there, else the
//   browser passkey; DESK051-C2); signs nothing. Check my master code: the typed code; the answer
//   is only right or doesn't match. Replace master code: Touch ID or the current code, then the new
//   code shown once; the owner types it back to finish (the current code works until then).
// - A typed or shown code lives only in this component's state: cleared after each request, at
//   Finish and at Cancel, never logged, stored or put in a URL.
// - The desktop app's native Touch ID switch mounts in the `native-touch-id-switch` slot of card 1
//   (`nativeSwitch` prop, or native-slot.ts).
import { Button, Icon, PageNotice, Surface } from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  createApiClient,
  type ApiClient,
  type OwnerApiResult,
  type OwnerPresence,
} from '../../api/client.js';
import { UnderTheHood } from '../../lazy/hood.js';
import { notify } from '../../notices/index.js';
import { gateMessage } from '../agents/owner-gate.js';
import {
  passkeyProof as browserPasskeyProof,
  readPasskeyStatus,
  type PasskeyInfo,
  type PasskeyStatus,
  type PresenceProof,
} from '../contacts/owner.js';
import { switchToPasskey, type SwitchToPasskey } from '../contacts/passkey-switch.js';
import { PASSKEY_WHY } from '../contacts/strings.js';
import { BackupCodeField, UseCodeInstead } from '../first-run/backup-code.js';
import { detectPlatform } from '../first-run/passkey.js';
import { otherBrowser } from '../first-run/passkey-nudge.js';
import { FIRST_RUN, SENSOR, UPGRADE_MESSAGES, type Platform } from '../first-run/strings.js';
import { SettingsIcon } from '../settings/icons.js';
import { nativeTouchIdSwitch } from './native-slot.js';
import { desktopPlatform } from '../../presence/desktop.js';
import type { NativeRegistration, NativeStatus } from '../../presence/native-api.js';
import { NativeSettings } from '../../presence/native-settings.js';
import { nativeStoredOf, type NativeOp } from '../../presence/native-switch.js';
import { TOUCH_ID_STRINGS as S } from './strings.js';
import './touch-id.css';

export const OWNER_CODE_CHECK_PATH = '/api/ui/owner-code/check';
export const OWNER_PRESENCE_TEST_PATH = '/api/ui/owner-presence/test';
export const OWNER_CODE_REPLACE_PATH = '/api/ui/owner-code/replace';
export const OWNER_CODE_FINISH_PATH = '/api/ui/owner-code/replace/finish';
export const OWNER_CODE_CANCEL_PATH = '/api/ui/owner-code/replace/cancel';

/**
 * IR WP-S2 L-1: a best-effort Cancel when the page goes away with a staged change (tab closed,
 * navigated). `keepalive` lets the request outlive the page; it carries the page's CSRF token like
 * every API call (sendBeacon cannot send that header) and no code. Any failure is ignored: the
 * server's expiry removes the staged item anyway.
 */
function cancelOnLeave(): void {
  try {
    if (typeof fetch !== 'function' || typeof document === 'undefined') return;
    const token =
      document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
    void fetch(OWNER_CODE_CANCEL_PATH, {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'X-AgentLink-CSRF': token,
        'Content-Type': 'application/octet-stream',
        'X-AgentLink-Input': 'e30', // base64url of `{}`
      },
    }).catch(() => undefined);
  } catch {
    // Best effort only.
  }
}

/** A new code as the server spells it: six groups of four. Anything else is never shown. */
const NEW_CODE = /^[A-Z2-7]{4}(?: [A-Z2-7]{4}){5}$/;

export interface TouchIdPageProps {
  readonly api?: ApiClient;
  readonly platform?: Platform;
  /** Seams (tests): the passkey state, the gesture and the one-time switch. */
  readonly passkeyStatus?: () => Promise<PasskeyStatus>;
  readonly passkeyProof?: (info: PasskeyInfo) => Promise<PresenceProof | undefined>;
  readonly switchPasskey?: SwitchToPasskey;
  /** The desktop app's native Touch ID switch, mounted in the `native-touch-id-switch` slot. */
  readonly nativeSwitch?: ReactNode;
  /**
   * DESK051-C2 seams (tests): the user agent (the desktop app's marker), and the native switch's
   * status read and operations (NativeSettings).
   */
  readonly userAgent?: string;
  readonly nativeStatus?: () => Promise<NativeStatus>;
  readonly nativeOps?: Readonly<Record<NativeOp, (code: string) => Promise<NativeRegistration>>>;
}

/** DESK051-C2: the desktop app's own Touch ID, as a presence proof (no bytes; the server's helper). */
const NATIVE_PROOF: PresenceProof = Object.freeze({ kind: 'native' });

type Panel = 'none' | 'check' | 'replace' | 'lost' | 'turn-on';
type Note = { readonly tone: 'good' | 'bad' | 'plain'; readonly text: string } | undefined;

const presenceOf = (proof: PresenceProof): OwnerPresence =>
  proof.kind === 'code'
    ? proof.code
    : proof.kind === 'native'
      ? { native: true }
      : { passkey: proof.body };

/** The gate's own outcomes in plain words (the shared presence messages). */
function gateWords(result: OwnerApiResult): string | undefined {
  switch (result.kind) {
    case 'presence_rejected':
      return gateMessage({ kind: 'rejected' });
    case 'presence_required':
      return gateMessage({ kind: 'required' });
    case 'wait':
      return gateMessage({ kind: 'wait' });
    case 'busy':
      return gateMessage({ kind: 'busy' });
    case 'session_expired':
      return gateMessage({ kind: 'session' });
    case 'offline':
      return gateMessage({ kind: 'offline' });
    default:
      return undefined;
  }
}

const statusWord = (result: OwnerApiResult): unknown =>
  result.kind === 'ok' || result.kind === 'answer'
    ? (result.data as { status?: unknown } | null)?.status
    : undefined;

function NoteLine({ note }: { readonly note: Note }): ReactElement | null {
  if (note === undefined) return null;
  return (
    <p
      className={`al-text-body-sm ti-note${note.tone === 'good' ? ' is-good' : note.tone === 'bad' ? ' is-bad' : ''}`}
      role={note.tone === 'bad' ? 'alert' : 'status'}
    >
      {note.text}
    </p>
  );
}

export function TouchIdPage({
  api: givenApi,
  platform: givenPlatform,
  passkeyStatus = readPasskeyStatus,
  passkeyProof = browserPasskeyProof,
  switchPasskey = switchToPasskey,
  nativeSwitch,
  userAgent,
  nativeStatus,
  nativeOps,
}: TouchIdPageProps): ReactElement {
  const [api] = useState<ApiClient>(() => givenApi ?? createApiClient());
  const [platform] = useState<Platform>(() => givenPlatform ?? detectPlatform());
  const sensor = SENSOR[platform];
  const [status, setStatus] = useState<PasskeyStatus | undefined>(undefined);
  const [panel, setPanel] = useState<Panel>('none');
  const [sensorNote, setSensorNote] = useState<Note>(undefined);
  const [codeNote, setCodeNote] = useState<Note>(undefined);
  const [working, setWorking] = useState(false);
  // Desktop integration: in the desktop app (and nowhere else) the native switch fills the slot.
  const desktop = desktopPlatform(userAgent) !== undefined;
  const registeredSwitch = nativeTouchIdSwitch();
  const Native = registeredSwitch ?? (desktop ? NativeSettings : undefined);
  // DESK051-C2: what the desktop app's own Touch ID has stored (reported by its switch below).
  const [native, setNative] = useState<NativeStatus | undefined>(undefined);
  const nativeAvailable = desktop && native?.available === true;
  const nativeOn = nativeAvailable && native !== undefined && nativeStoredOf(native) === 'on';

  const readStatus = useCallback((): void => {
    void passkeyStatus().then(
      (s) => setStatus(s),
      () => setStatus({ kind: 'unavailable', reason: 'unknown' }),
    );
  }, [passkeyStatus]);
  useEffect(readStatus, [readStatus]);

  const ready = status?.kind === 'ready' ? status.info : undefined;
  // The browser's one-time switch is never offered in the desktop app: its own switch is the way.
  const canSwitch =
    !nativeAvailable &&
    status?.kind === 'unavailable' &&
    status.reason === 'not_set_up_here' &&
    status.switchTo !== undefined;
  // DESK051-C2: Touch ID is on when the desktop app's own Touch ID is on, or this browser's passkey.
  const sensorOn = nativeOn || ready !== undefined;
  /** The gesture Test and Replace use: the desktop app's own Touch ID first, else the passkey. */
  const sensorProof: (() => Promise<PresenceProof | undefined>) | undefined = nativeOn
    ? () => Promise.resolve(NATIVE_PROOF)
    : ready !== undefined
      ? () => passkeyProof(ready)
      : undefined;

  const open = (next: Panel): void => {
    setPanel((p) => (p === next ? 'none' : next));
    setCodeNote(undefined);
  };

  // --- Test Touch ID: one gesture, signs nothing ------------------------------------------------
  const test = async (): Promise<void> => {
    if (sensorProof === undefined || working) return;
    setWorking(true);
    setSensorNote(undefined);
    try {
      const proof = await sensorProof();
      if (proof === undefined || proof.kind === 'code') {
        setSensorNote({ tone: 'plain', text: S.testCancelled(sensor) });
        return;
      }
      const result = await api.owner(OWNER_PRESENCE_TEST_PATH, {}, presenceOf(proof));
      if (result.kind === 'ok' && statusWord(result) === 'done') {
        notify({ text: S.works(sensor), tone: 'success' });
        return;
      }
      const gate = result.kind === 'wait' ? gateWords(result) : undefined;
      setSensorNote({ tone: 'bad', text: gate ?? S.testFailed(sensor) });
    } catch {
      setSensorNote({ tone: 'bad', text: S.testFailed(sensor) });
    } finally {
      setWorking(false);
    }
  };

  const whyText = (): string => {
    if (status?.kind !== 'unavailable') return '';
    if (status.reason === 'browser') return PASSKEY_WHY.browser(sensor, otherBrowser(platform));
    return PASSKEY_WHY[status.reason](sensor);
  };

  return (
    <div className="ti-page">
      <header className="ti-head">
        <h1 className="al-text-title-1">{S.title(sensor)}</h1>
        <p className="al-text-body al-muted ti-lead">{S.lead}</p>
      </header>

      {/* Card 1: the sensor. */}
      <Surface as="section" level={1} className="ti-card" aria-labelledby="ti-sensor">
        <div className="ti-hero">
          <span className={`ti-hero-ic${sensorOn ? ' is-on' : ''}`} aria-hidden="true">
            <SettingsIcon name="fingerprint" />
          </span>
          <div className="ti-hero-text">
            {sensorOn ? (
              <>
                <h2 id="ti-sensor" className="al-text-h3">
                  {S.on(sensor)}
                </h2>
                <p className="al-text-body-sm al-muted">{S.onLine}</p>
              </>
            ) : nativeAvailable ? (
              <>
                <h2 id="ti-sensor" className="al-text-h3">
                  {S.off(sensor)}
                </h2>
                <p className="al-text-body-sm al-muted">{S.offNativeLine}</p>
              </>
            ) : status === undefined ? (
              <h2 id="ti-sensor" className="al-text-h3 al-muted">
                {S.title(sensor)}
              </h2>
            ) : ready !== undefined ? (
              <>
                <h2 id="ti-sensor" className="al-text-h3">
                  {S.on(sensor)}
                </h2>
                <p className="al-text-body-sm al-muted">{S.onLine}</p>
              </>
            ) : canSwitch ? (
              <>
                <h2 id="ti-sensor" className="al-text-h3">
                  {S.off(sensor)}
                </h2>
                <p className="al-text-body-sm al-muted">{S.offLine}</p>
              </>
            ) : (
              <>
                <h2 id="ti-sensor" className="al-text-h3">
                  {S.cantTitle(sensor)}
                </h2>
                <p className="al-text-body-sm al-muted">{whyText()}</p>
              </>
            )}
          </div>
          {sensorOn ? (
            <Button variant="secondary" onClick={() => void test()} disabled={working}>
              {working ? S.testing : S.test(sensor)}
            </Button>
          ) : canSwitch && panel !== 'turn-on' ? (
            <Button variant="primary" icon="key-round" onClick={() => open('turn-on')}>
              {S.turnOn(sensor)}
            </Button>
          ) : null}
        </div>
        {panel === 'turn-on' && canSwitch && status?.kind === 'unavailable' && status.switchTo ? (
          <TurnOn
            sensor={sensor}
            platform={platform}
            switchPasskey={switchPasskey}
            values={status.switchTo}
            onDone={() => {
              setPanel('none');
              notify({ text: S.turnedOn(sensor), tone: 'success' });
              readStatus();
            }}
            onCancel={() => setPanel('none')}
          />
        ) : null}
        <NoteLine note={sensorNote} />
        {/* The desktop app's native Touch ID switch (NativeSettings) mounts here. */}
        {nativeSwitch !== undefined || Native !== undefined ? (
          <div className="ti-native" data-slot="native-touch-id-switch">
            {nativeSwitch ??
              (Native === NativeSettings ? (
                <NativeSettings
                  onStatus={setNative}
                  {...(userAgent === undefined ? {} : { userAgent })}
                  {...(nativeStatus === undefined ? {} : { nativeStatus })}
                  {...(nativeOps === undefined ? {} : { ops: nativeOps })}
                />
              ) : Native === undefined ? null : (
                <Native />
              ))}
          </div>
        ) : null}
      </Surface>

      {/* Card 2: the master code. */}
      <Surface as="section" level={1} className="ti-card ti-code" aria-labelledby="ti-code">
        <div className="ti-code-head">
          <span className="ti-code-ic" aria-hidden="true">
            <Icon name="key-round" size={20} />
          </span>
          <div className="ti-hero-text">
            <h2 id="ti-code" className="al-text-h3">
              {S.codeTitle}
            </h2>
            <p className="al-text-body-sm al-muted">{S.codeLine(sensor)}</p>
          </div>
          <span className="ti-state is-good">{S.codeSet}</span>
        </div>
        <div className="ti-code-actions">
          <Button
            variant="secondary"
            aria-expanded={panel === 'check'}
            onClick={() => open('check')}
            disabled={panel === 'replace'}
          >
            {S.check}
          </Button>
          <Button
            variant="secondary"
            aria-expanded={panel === 'replace'}
            onClick={() => open('replace')}
            disabled={panel === 'replace'}
          >
            {S.replace}
          </Button>
          <Button
            variant="ghost"
            className="ti-lost-link"
            aria-expanded={panel === 'lost'}
            onClick={() => open('lost')}
            disabled={panel === 'replace'}
          >
            {S.lost}
          </Button>
        </div>
        {panel === 'check' ? (
          <CheckCode
            api={api}
            onNote={setCodeNote}
            onCancel={() => {
              setPanel('none');
              setCodeNote(undefined);
            }}
          />
        ) : null}
        {panel === 'replace' ? (
          <ReplaceCode
            api={api}
            sensor={sensor}
            sensorProof={sensorProof}
            onEnd={(note) => {
              setPanel('none');
              setCodeNote(note);
            }}
          />
        ) : null}
        {panel === 'lost' ? (
          <div className="ti-panel" role="region" aria-label={S.lost}>
            <p className="al-text-body">{S.lostBody(sensor)}</p>
            <div className="ti-row">
              {sensorOn ? (
                <Button variant="secondary" onClick={() => open('replace')}>
                  {S.lostReplace}
                </Button>
              ) : null}
              <a className="al-btn al-btn-ghost al-btn-md" href="/settings/backup">
                {S.lostRestore}
              </a>
            </div>
          </div>
        ) : null}
        <NoteLine note={codeNote} />
      </Surface>

      {/* Card 3: what asks. */}
      <Surface as="section" level={1} className="ti-card" aria-labelledby="ti-asks">
        <h2 id="ti-asks" className="al-text-body ti-strong">
          {S.asksTitle(sensor)}
        </h2>
        <ul className="ti-ticks">
          {S.asks.map((line) => (
            <li key={line} className="al-text-body">
              <Icon name="check" size={16} className="ti-tick" />
              {line}
            </li>
          ))}
        </ul>
        <p className="al-text-body-sm al-muted">{S.neverAsks}</p>
      </Surface>

      <PageNotice tone="neutral" title={S.keepTitle}>
        <p className="ti-keep">
          <strong>{S.keepSensor(sensor)}</strong>: {S.keepSensorWhat} <strong>{S.keepCode}</strong>:{' '}
          {S.keepCodeWhat(sensor)} <strong>{S.keepKit}</strong>: {S.keepKitWhat}
        </p>
      </PageNotice>

      <UnderTheHood
        fields={[
          {
            kind: 'text',
            label: S.hoodSensor,
            value: sensorOn ? S.hoodSensorOn : S.hoodSensorOff,
          },
          { kind: 'text', label: S.hoodWhere, value: S.hoodKeychain },
        ]}
      />
    </div>
  );
}

// --- Turn on Touch ID (the existing one-time switch, contacts/passkey-switch.ts) ---------------

function TurnOn({
  sensor,
  platform,
  switchPasskey,
  values,
  onDone,
  onCancel,
}: {
  readonly sensor: string;
  readonly platform: Platform;
  readonly switchPasskey: SwitchToPasskey;
  readonly values: NonNullable<Extract<PasskeyStatus, { kind: 'unavailable' }>['switchTo']>;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(undefined);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    if (code.trim() === '') {
      setNote({ tone: 'bad', text: UPGRADE_MESSAGES.empty });
      return;
    }
    const typed = code;
    setCode('');
    setBusy(true);
    void switchPasskey(values, typed)
      .then((outcome) => {
        if (outcome.kind === 'switched') return onDone();
        if (outcome.kind === 'cancelled') {
          return setNote({ tone: 'plain', text: PASSKEY_WHY.switchCancelled });
        }
        if (outcome.kind === 'unsupported') {
          return setNote({
            tone: 'bad',
            text: PASSKEY_WHY.switchUnsupported(sensor, otherBrowser(platform)),
          });
        }
        const problem: string = outcome.problem;
        const text =
          problem in UPGRADE_MESSAGES
            ? (UPGRADE_MESSAGES as Record<string, unknown>)[problem]
            : UPGRADE_MESSAGES.failed;
        return setNote({
          tone: 'bad',
          text: typeof text === 'string' ? text : UPGRADE_MESSAGES.failed,
        });
      })
      .catch(() => setNote({ tone: 'bad', text: UPGRADE_MESSAGES.failed }))
      .finally(() => setBusy(false));
  };
  return (
    <form className="ti-panel" onSubmit={submit} autoComplete="off">
      <p className="al-text-body-sm al-muted">{S.turnOnIntro(sensor)}</p>
      <BackupCodeField
        label={S.checkLabel}
        name="owner-code"
        value={code}
        disabled={busy}
        onValue={setCode}
      />
      <div className="ti-row">
        <Button type="submit" variant="primary" icon="key-round" disabled={busy}>
          {S.turnOn(sensor)}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {S.notNow}
        </Button>
      </div>
      <NoteLine note={note} />
    </form>
  );
}

// --- Check my master code: right or doesn't match; signs nothing -------------------------------

function CheckCode({
  api,
  onNote,
  onCancel,
}: {
  readonly api: ApiClient;
  readonly onNote: (note: Note) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    if (code.trim() === '') {
      onNote({ tone: 'bad', text: UPGRADE_MESSAGES.empty });
      return;
    }
    const typed = code;
    setCode('');
    setBusy(true);
    onNote(undefined);
    void api
      .owner(OWNER_CODE_CHECK_PATH, {}, typed)
      .then((result) => {
        if (result.kind === 'ok' && statusWord(result) === 'done') {
          return onNote({ tone: 'good', text: S.right });
        }
        if (result.kind === 'presence_rejected') return onNote({ tone: 'bad', text: S.wrong });
        return onNote({ tone: 'bad', text: gateWords(result) ?? S.failed });
      })
      .catch(() => onNote({ tone: 'bad', text: S.failed }))
      .finally(() => setBusy(false));
  };
  return (
    <form className="ti-panel" onSubmit={submit} autoComplete="off">
      <BackupCodeField
        label={S.checkLabel}
        name="owner-code"
        value={code}
        disabled={busy}
        onValue={setCode}
      />
      <div className="ti-row">
        <Button type="submit" variant="primary" disabled={busy}>
          {S.checkSubmit}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {S.cancel}
        </Button>
      </div>
    </form>
  );
}

// --- Replace master code: presence, the new code once, typed back to finish --------------------

function ReplaceCode({
  api,
  sensor,
  sensorProof,
  onEnd,
}: {
  readonly api: ApiClient;
  readonly sensor: string;
  /** The sensor's gesture (the desktop app's own Touch ID, or the passkey); none: the code only. */
  readonly sensorProof: (() => Promise<PresenceProof | undefined>) | undefined;
  readonly onEnd: (note: Note) => void;
}): ReactElement {
  const [useCode, setUseCode] = useState(sensorProof === undefined);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(undefined);
  const [newCode, setNewCode] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  // IR WP-S2 M-1: the keychain may have taken the new code without confirming it. The new code stays
  // on screen (never cleared on this path) and no Finish or Cancel is offered.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const codeId = useId();
  // IR WP-S2 L-1: a staged change this page began is cancelled (best effort) when the page goes away.
  const stagedRef = useRef(false);
  stagedRef.current = newCode !== undefined && !unconfirmed;
  useEffect(() => {
    const leave = (): void => {
      if (stagedRef.current) cancelOnLeave();
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, []);

  const begin = (proof: PresenceProof): void => {
    setBusy(true);
    setNote(undefined);
    void api
      .owner(OWNER_CODE_REPLACE_PATH, {}, presenceOf(proof))
      .then((result) => {
        const word = statusWord(result);
        const code = (result.kind === 'ok' ? (result.data as { code?: unknown }) : null)?.code;
        if (result.kind === 'ok' && word === 'staged' && typeof code === 'string') {
          if (NEW_CODE.test(code)) return setNewCode(code);
          return setNote({ tone: 'bad', text: S.replaceFailed });
        }
        if (word === 'unfinished') return setNote({ tone: 'bad', text: S.unfinished });
        return setNote({ tone: 'bad', text: gateWords(result) ?? S.replaceFailed });
      })
      .catch(() => setNote({ tone: 'bad', text: S.replaceFailed }))
      .finally(() => setBusy(false));
  };

  const submitPresence = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    if (typed.trim() === '') return setNote({ tone: 'bad', text: UPGRADE_MESSAGES.empty });
    const code = typed;
    setTyped('');
    begin({ kind: 'code', code });
  };

  const usePasskey = (): void => {
    if (sensorProof === undefined || busy) return;
    void sensorProof().then(
      (proof) =>
        proof === undefined
          ? setNote({ tone: 'plain', text: S.testCancelled(sensor) })
          : begin(proof),
      () => setNote({ tone: 'plain', text: S.testCancelled(sensor) }),
    );
  };

  const submitFinish = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || unconfirmed) return;
    if (typed.trim() === '') return setNote({ tone: 'bad', text: UPGRADE_MESSAGES.empty });
    const back = typed;
    setTyped('');
    setBusy(true);
    setNote(undefined);
    void api
      .owner(OWNER_CODE_FINISH_PATH, {}, back)
      .then((result) => {
        const word = statusWord(result);
        if (result.kind === 'ok' && word === 'done') {
          setNewCode(undefined);
          return onEnd({ tone: 'good', text: S.replaced });
        }
        if (result.kind === 'ok' && word === 'unconfirmed') {
          setUnconfirmed(true);
          return setNote({ tone: 'bad', text: S.unconfirmed });
        }
        if (result.kind === 'presence_rejected') {
          return setNote({ tone: 'bad', text: S.typeBackWrong });
        }
        if (word === 'not_pending') {
          setNewCode(undefined);
          return onEnd({ tone: 'plain', text: S.ended });
        }
        return setNote({ tone: 'bad', text: gateWords(result) ?? S.replaceFailed });
      })
      .catch(() => setNote({ tone: 'bad', text: S.replaceFailed }))
      .finally(() => setBusy(false));
  };

  const cancel = (): void => {
    if (unconfirmed) return;
    const staged = newCode !== undefined;
    setTyped('');
    if (!staged) return onEnd(undefined);
    setBusy(true);
    void api
      .owner(OWNER_CODE_CANCEL_PATH, {}, '')
      .then((result) => {
        const word = statusWord(result);
        // Dropped now, or already gone (expiry, three wrong entries): the current code works.
        if (word === 'cancelled' || word === 'not_pending') {
          setNewCode(undefined);
          return onEnd({ tone: 'plain', text: S.cancelled });
        }
        return setNote({ tone: 'bad', text: gateWords(result) ?? S.cancelFailed });
      })
      .catch(() => setNote({ tone: 'bad', text: S.cancelFailed }))
      .finally(() => setBusy(false));
  };

  const copy = (code: string): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) return;
    void clipboard.writeText(code).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  if (newCode !== undefined) {
    return (
      <form className="ti-panel" onSubmit={submitFinish} autoComplete="off">
        <section className="al-secret" aria-label={S.newTitle}>
          <div className="al-secret-head">
            <span className="al-text-label">{S.newTitle}</span>
            <span className="al-text-caption al-muted">{S.shownOnce}</span>
          </div>
          <div id={codeId} className="al-secret-val al-text-code-lg ti-new-code" data-new-code="">
            {newCode}
          </div>
        </section>
        <div className="ti-row">
          <Button variant="secondary" icon="copy" onClick={() => copy(newCode)}>
            {copied ? S.copied : S.copy}
          </Button>
        </div>
        {/* IR WP-S2 L-2: the same clipboard warning as the first-run code (08 §1). */}
        <p className="al-text-caption al-muted">{FIRST_RUN.clipboardWarning}</p>
        <p className="al-text-body-sm">{S.newSave}</p>
        {unconfirmed ? null : (
          <>
            <p className="al-text-body-sm al-muted">{S.stillWorks}</p>
            <BackupCodeField
              label={S.typeBack}
              name="new-owner-code"
              value={typed}
              disabled={busy}
              onValue={setTyped}
            />
            <div className="ti-row">
              <Button type="submit" variant="primary" disabled={busy}>
                {S.finish}
              </Button>
              <Button variant="ghost" onClick={cancel} disabled={busy}>
                {S.cancel}
              </Button>
            </div>
          </>
        )}
        <NoteLine note={note} />
      </form>
    );
  }

  return (
    <div className="ti-panel" role="region" aria-label={S.replaceSummary}>
      <p className="al-text-body">
        <strong>{S.replaceSummary}</strong>
      </p>
      <p className="al-text-body-sm al-muted">{S.replaceIntro(sensor)}</p>
      {useCode ? (
        <form className="ti-panel-form" onSubmit={submitPresence} autoComplete="off">
          <BackupCodeField
            label={S.checkLabel}
            name="owner-code"
            value={typed}
            disabled={busy}
            onValue={setTyped}
          />
          <div className="ti-row">
            <Button type="submit" variant="primary" disabled={busy}>
              {S.confirmWithCode}
            </Button>
            <Button variant="ghost" onClick={cancel} disabled={busy}>
              {S.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <div className="ti-row">
          <Button variant="primary" icon="approval" onClick={usePasskey} disabled={busy}>
            {S.confirmWith(sensor)}
          </Button>
          <UseCodeInstead onClick={() => setUseCode(true)} disabled={busy} />
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            {S.cancel}
          </Button>
        </div>
      )}
      <NoteLine note={note} />
    </div>
  );
}
