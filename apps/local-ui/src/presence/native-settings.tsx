// DESK-D12c (Fable review M1): the Settings switch "Use Touch ID for approvals" (macOS) / "Use
// Windows Hello for approvals" (Windows), only in the desktop app where the helper is available.
// Turning it on, off, or on again after a fingerprint or sign-in change is each its own owner
// operation, confirmed with the master code (never with Touch ID itself, so a captured Touch ID
// secret can neither keep itself on nor turn itself back on). Nothing is shown in a browser.
//
// DESK051-C2 (owner feedback after testing on a real Mac): the switch guides, one step at a time
// (native-switch.ts). A click puts it in an in-between state with its own look; the master code
// field appears with the reason, said once; the sensor button works only once a code is typed; while
// the OS prompt is up the card says so (with Cancel); after success the switch is fully on (the
// accent colour). Errors and Cancel go back cleanly to where it was, with a plain message that is
// announced. The status is read again after every answer so the switch shows what is really stored.
import { Button } from '@4thtech-io/ui';
import { useEffect, useReducer, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { BackupCodeField } from '../pages/first-run/backup-code.js';
import { desktopPlatform, nativeConfirmLabel } from './desktop.js';
import {
  readNativeStatus,
  registerNative,
  replaceNative,
  turnOffNative,
  type NativeRegistration,
  type NativeStatus,
} from './native-api.js';
import {
  NATIVE_SWITCH_START,
  nativeSwitchCanSend,
  nativeSwitchLook,
  nativeSwitchStep,
  type NativeOp,
} from './native-switch.js';
import { NativeWaitNotice } from './native-wait.js';
import { NATIVE_STRINGS as N, nativeOutcomeText } from './strings.js';
import './native-settings.css';

const SWITCH_WORD = { off: 'Off', pending: '', on: 'On' } as const;

export function NativeSettings({
  userAgent,
  nativeStatus = readNativeStatus,
  ops = { on: registerNative, off: turnOffNative, again: replaceNative },
  onStatus,
}: {
  /** Seams (tests): the user agent, the status read and the three operations. */
  readonly userAgent?: string;
  readonly nativeStatus?: () => Promise<NativeStatus>;
  readonly ops?: Readonly<Record<NativeOp, (code: string) => Promise<NativeRegistration>>>;
  /** DESK051-C2: tells the page around it what is stored (the Touch ID card's own state). */
  readonly onStatus?: (status: NativeStatus) => void;
}): ReactElement | null {
  const platform = desktopPlatform(userAgent);
  const [status, setStatus] = useState<NativeStatus | undefined>(undefined);
  const [sw, dispatch] = useReducer(nativeSwitchStep, NATIVE_SWITCH_START);
  const [code, setCode] = useState('');
  const mounted = useRef(true);
  const reported = useRef(onStatus);
  reported.current = onStatus;

  const refresh = async (): Promise<void> => {
    const next = await nativeStatus().catch((): NativeStatus => ({
      available: false,
      registered: false,
    }));
    if (!mounted.current) return;
    setStatus(next);
    dispatch({ type: 'status', status: next });
    reported.current?.(next);
  };

  useEffect(() => {
    mounted.current = true;
    if (platform !== undefined) void refresh();
    return () => {
      mounted.current = false;
    };
    // Read once per visit.
  }, []);

  if (platform === undefined || status === undefined || !status.available) return null;
  const title = N.settingsTitle(platform);
  const look = nativeSwitchLook(sw);
  const broken = sw.stored === 'broken';
  const working = sw.step === 'sensor';
  const turningOff = sw.op === 'off';
  const canSend = nativeSwitchCanSend(sw, code);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (sw.op === undefined || !canSend) return;
    const op = sw.op;
    const typed = code;
    setCode('');
    dispatch({ type: 'send' });
    void ops[op](typed)
      .catch((): NativeRegistration => ({ kind: 'failed' }))
      .then(async (outcome) => {
        if (!mounted.current) return;
        dispatch({ type: 'answer', outcome, text: nativeOutcomeText(outcome, platform) });
        await refresh();
      });
  };

  const back = (): void => {
    setCode('');
    dispatch({ type: 'cancel' });
  };

  return (
    <section className="st-native" aria-label={title} data-native-settings="" data-look={look}>
      <div className="st-native-row">
        <span className="st-row-text">
          <span className="st-row-title" id="st-native-title">
            {title}
          </span>
          <span className="st-row-line">
            {sw.stored === 'on' ? N.settingsOn(platform) : N.settingsOff}
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={look === 'on'}
          aria-labelledby="st-native-title"
          aria-describedby={sw.step === 'code' ? 'st-native-why' : undefined}
          aria-busy={look === 'pending' ? true : undefined}
          data-look={look}
          className={`al-switch${look === 'on' ? ' is-on' : ''}${look === 'pending' ? ' is-pending' : ''}`}
          disabled={working || broken}
          onClick={() => {
            setCode('');
            dispatch({ type: 'toggle' });
          }}
        >
          <span className="al-switch-knob" aria-hidden="true" />
          <span className="al-switch-state al-text-caption" aria-hidden="true">
            {SWITCH_WORD[look]}
          </span>
        </button>
      </div>
      {broken && sw.step === 'idle' ? (
        <div className="st-native-body">
          <p className="al-text-body-sm" role="status">
            {N.state.reregister}
          </p>
          <div className="st-native-actions">
            <Button variant="primary" onClick={() => dispatch({ type: 'again' })}>
              {N.turnOnAgain}
            </Button>
          </div>
        </div>
      ) : null}
      {sw.step === 'code' ? (
        <form className="st-native-body" onSubmit={submit} autoComplete="off">
          <p className="al-text-body-sm" id="st-native-why">
            {turningOff ? N.whyOff(platform) : N.whyOn(platform)}
          </p>
          <BackupCodeField
            label={N.codeLabel}
            name="owner-code"
            value={code}
            disabled={working}
            onValue={setCode}
          />
          <div className="st-native-actions">
            <Button type="submit" variant="primary" disabled={!canSend}>
              {turningOff ? N.turnOff : nativeConfirmLabel(platform)}
            </Button>
            <Button variant="ghost" onClick={back}>
              {N.cancel}
            </Button>
          </div>
        </form>
      ) : null}
      {working && !turningOff ? (
        <div className="st-native-note">
          <NativeWaitNotice inline {...(userAgent === undefined ? {} : { userAgent })} />
        </div>
      ) : null}
      {working && turningOff ? (
        <p className="al-text-body-sm st-native-note" role="status">
          {N.working}
        </p>
      ) : null}
      {sw.note === undefined || working ? null : (
        <p
          className={`al-text-body-sm st-native-note${sw.note.tone === 'error' ? ' is-error' : ''}`}
          role={sw.note.tone === 'error' ? 'alert' : 'status'}
        >
          {sw.note.text}
        </p>
      )}
    </section>
  );
}
