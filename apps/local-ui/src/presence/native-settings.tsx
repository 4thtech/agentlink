// DESK-D12c (Fable review M1): the Settings switch "Use Touch ID for approvals" (macOS) / "Use
// Windows Hello for approvals" (Windows), only in the desktop app where the helper is available.
// Turning it on, off, or on again after a fingerprint or sign-in change is each its own owner
// operation, confirmed with the backup code (never with Touch ID itself, so a captured Touch ID
// secret can neither keep itself on nor turn itself back on). Nothing is shown in a browser.
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
import { NATIVE_STRINGS as N } from './strings.js';

type Op = 'on' | 'off' | 'again';

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
  const [note, setNote] = useState<string | undefined>(undefined);
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

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (asking === undefined || working || code.trim() === '') return;
    const op = asking;
    const typed = code;
    setCode('');
    setWorking(true);
    setNote(undefined);
    void ops[op](typed).then(async (outcome) => {
      if (!mounted.current) return;
      setWorking(false);
      if (outcome.kind === 'registered' || outcome.kind === 'off') {
        setAsking(undefined);
        setNote(outcome.kind === 'off' ? N.turnedOff(platform) : N.turnedOn(platform));
        await refresh();
      } else if (outcome.kind === 'native') setNote(N.state[outcome.state]);
      else if (outcome.kind === 'rejected') setNote(N.wrongCode);
      else setNote(N.state.error);
    });
  };

  return (
    <section className="st-row" aria-label={N.settingsTitle(platform)} data-native-settings="">
      <label className="st-row-text">
        <span className="st-row-title">{N.settingsTitle(platform)}</span>
        <span className="st-row-line">{on ? N.settingsOn(platform) : N.settingsOff}</span>
        <input
          type="checkbox"
          role="switch"
          aria-checked={on}
          checked={on}
          disabled={working || broken}
          onChange={() => {
            setNote(undefined);
            setAsking(on ? 'off' : 'on');
          }}
        />
      </label>
      {broken ? (
        <>
          <p className="al-text-body-sm" role="status">
            {N.state.reregister}
          </p>
          <Button variant="primary" onClick={() => setAsking('again')} disabled={working}>
            {N.turnOnAgain}
          </Button>
        </>
      ) : null}
      {asking === undefined ? null : (
        <form onSubmit={submit} autoComplete="off">
          <BackupCodeField
            label={N.codeLabel}
            name="owner-code"
            value={code}
            disabled={working}
            onValue={setCode}
          />
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
        </form>
      )}
      {note === undefined ? null : (
        <p className="al-text-body-sm" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
