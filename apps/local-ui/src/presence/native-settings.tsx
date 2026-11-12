// DESK-D12c (Fable review M1): the Settings switch "Use Touch ID for approvals" (macOS) / "Use
// Windows Hello for approvals" (Windows), only in the desktop app where the helper is available.
// Turning it on, off, or on again after a fingerprint or sign-in change is each its own owner
// operation, confirmed with the master code (never with Touch ID itself, so a captured Touch ID
// secret can neither keep itself on nor turn itself back on). Nothing is shown in a browser.
//
// DESK-NATIVE-DEBUG (stopgap until the Settings redesign, WP-S2): one settings card under the list,
// the switch aligned on the right of its row (the shared `al-switch` look), the master code prompt
// inline beneath it, and every outcome a fixed message: while the OS prompt is up the card says it
// is waiting (never a silent, emptied form), errors are announced (role="alert"), and the status is
// read again after every answer so the switch shows what is really stored.
import { Button } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { BackupCodeField } from '../pages/first-run/backup-code.js';
import { desktopPlatform } from './desktop.js';
import {
  readNativeStatus,
  registerNative,
  replaceNative,
  turnOffNative,
  type NativeRegistration,
  type NativeStatus,
} from './native-api.js';
import { NativeWaitNotice } from './native-wait.js';
import { NATIVE_STRINGS as N, nativeOutcomeText } from './strings.js';
import './native-settings.css';

type Op = 'on' | 'off' | 'again';

interface Note {
  readonly text: string;
  readonly tone: 'ok' | 'error';
}

export function NativeSettings({
  userAgent,
  nativeStatus = readNativeStatus,
  ops = { on: registerNative, off: turnOffNative, again: replaceNative },
}: {
  /** Seams (tests): the user agent, the status read and the three operations. */
  readonly userAgent?: string;
  readonly nativeStatus?: () => Promise<NativeStatus>;
  readonly ops?: Readonly<Record<Op, (code: string) => Promise<NativeRegistration>>>;
}): ReactElement | null {
  const platform = desktopPlatform(userAgent);
  const [status, setStatus] = useState<NativeStatus | undefined>(undefined);
  const [asking, setAsking] = useState<Op | undefined>(undefined);
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  // DESK-TOUCHID-FIX: turning it off never runs the helper (no Touch ID wording then).
  const [workingOp, setWorkingOp] = useState<Op | undefined>(undefined);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const mounted = useRef(true);

  const refresh = async (): Promise<void> => {
    const next = await nativeStatus().catch((): NativeStatus => ({
      available: false,
      registered: false,
    }));
    if (mounted.current) setStatus(next);
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
  const broken = status.reason === 'reregister' || status.reason === 'damaged';
  const on = status.registered && !broken;
  const title = N.settingsTitle(platform);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (asking === undefined || working || code.trim() === '') return;
    const op = asking;
    const typed = code;
    setCode('');
    setWorking(true);
    setWorkingOp(op);
    setNote(undefined);
    void ops[op](typed)
      .catch((): NativeRegistration => ({ kind: 'failed' }))
      .then(async (outcome) => {
        if (!mounted.current) return;
        setWorking(false);
        const done = outcome.kind === 'registered' || outcome.kind === 'off';
        // A wrong master code keeps the prompt open to try again; every other answer closes it.
        if (outcome.kind !== 'rejected') setAsking(undefined);
        setNote({ text: nativeOutcomeText(outcome, platform), tone: done ? 'ok' : 'error' });
        await refresh();
      });
  };

  const ask = (op: Op): void => {
    if (working) return;
    setNote(undefined);
    setCode('');
    setAsking(op);
  };

  return (
    <section className="st-native" aria-label={title} data-native-settings="">
      <div className="st-native-row">
        <span className="st-row-text">
          <span className="st-row-title" id="st-native-title">
            {title}
          </span>
          <span className="st-row-line">{on ? N.settingsOn(platform) : N.settingsOff}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="st-native-title"
          className={`al-switch${on ? ' is-on' : ''}`}
          disabled={working || broken}
          onClick={() => ask(on ? 'off' : 'on')}
        >
          <span className="al-switch-knob" aria-hidden="true" />
          <span className="al-switch-state al-text-caption" aria-hidden="true">
            {on ? 'On' : 'Off'}
          </span>
        </button>
      </div>
      {broken ? (
        <div className="st-native-body">
          <p className="al-text-body-sm" role="status">
            {N.state.reregister}
          </p>
          <div className="st-native-actions">
            <Button variant="primary" onClick={() => ask('again')} disabled={working}>
              {N.turnOnAgain}
            </Button>
          </div>
        </div>
      ) : null}
      {asking === undefined ? null : (
        <form className="st-native-body" onSubmit={submit} autoComplete="off">
          <BackupCodeField
            label={N.codeLabel}
            name="owner-code"
            value={code}
            disabled={working}
            onValue={setCode}
          />
          <div className="st-native-actions">
            <Button type="submit" variant="primary" disabled={working}>
              {N.confirmCode}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setAsking(undefined);
                setCode('');
              }}
              disabled={working}
            >
              {N.cancel}
            </Button>
          </div>
        </form>
      )}
      {working && workingOp !== 'off' ? (
        <div className="st-native-note">
          <NativeWaitNotice inline {...(userAgent === undefined ? {} : { userAgent })} />
        </div>
      ) : null}
      {working && workingOp === 'off' ? (
        <p className="al-text-body-sm st-native-note" role="status">
          {N.working}
        </p>
      ) : null}
      {note === undefined || working ? null : (
        <p
          className={`al-text-body-sm st-native-note${note.tone === 'error' ? ' is-error' : ''}`}
          role={note.tone === 'error' ? 'alert' : 'status'}
        >
          {note.text}
        </p>
      )}
    </section>
  );
}
