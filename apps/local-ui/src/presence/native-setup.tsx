// DESK-D12c: the first-time setup offer "Turn on Touch ID for approvals" (macOS) / "Turn on Windows
// Hello for approvals" (Windows), shown only in the desktop app and only where the helper is
// available and not yet on. One click sends the backup code the setup just showed (once, to this
// same-origin server) and the OS asks for one gesture. Nothing is offered in a browser.
import { Button } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { desktopPlatform, nativeSetupLabel } from './desktop.js';
import {
  readNativeStatus,
  registerNative,
  type NativeRegistration,
  type NativeStatus,
} from './native-api.js';
import { NATIVE_STRINGS } from './strings.js';

export function NativeSetupOffer({
  backupCode,
  userAgent,
  nativeStatus = readNativeStatus,
  register = registerNative,
  onDone,
}: {
  /** The backup code the setup just showed; sent once when the owner clicks. */
  readonly backupCode: string;
  /** Seam (tests): the user agent; default navigator.userAgent. */
  readonly userAgent?: string;
  readonly nativeStatus?: () => Promise<NativeStatus>;
  readonly register?: (code: string) => Promise<NativeRegistration>;
  readonly onDone?: () => void;
}): ReactElement | null {
  const platform = desktopPlatform(userAgent);
  const [offer, setOffer] = useState(false);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (platform !== undefined) {
      void nativeStatus()
        .catch(() => ({ available: false, registered: false }))
        .then((status) => {
          if (mounted.current) setOffer(status.available && !status.registered);
        });
    }
    return () => {
      mounted.current = false;
    };
    // Read once per screen.
  }, []);

  if (platform === undefined) return null;
  if (done) {
    return (
      <p className="al-text-body-sm" role="status">
        {NATIVE_STRINGS.turnedOn(platform)}
      </p>
    );
  }
  if (!offer) return null;

  const turnOn = (): void => {
    if (working) return;
    setWorking(true);
    setNote(undefined);
    void register(backupCode).then((outcome) => {
      if (!mounted.current) return;
      setWorking(false);
      if (outcome.kind === 'registered') {
        setDone(true);
        onDone?.();
      } else if (outcome.kind === 'native') {
        setNote(NATIVE_STRINGS.state[outcome.state]);
      } else {
        setNote(NATIVE_STRINGS.state.error);
      }
    });
  };

  return (
    <section className="ct-presence" aria-label={nativeSetupLabel(platform)}>
      <p className="al-text-body-sm al-muted">{NATIVE_STRINGS.setupIntro(platform)}</p>
      <div className="ct-actions">
        <Button
          variant="primary"
          icon="key-round"
          onClick={turnOn}
          disabled={working}
          data-native-setup=""
        >
          {nativeSetupLabel(platform)}
        </Button>
      </div>
      {note === undefined ? null : (
        <p className="al-text-body-sm ct-error" role="alert">
          {note}
        </p>
      )}
    </section>
  );
}
