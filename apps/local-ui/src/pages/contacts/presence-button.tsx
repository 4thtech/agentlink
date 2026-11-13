// UX1113-N1 (run1113b B §2 option A): one owner step, one gesture. The step's own primary button
// *is* the sensor ("Save with Touch ID", the platform's word), with "Use your master code instead"
// as a small link, the pattern of the join card's Accept (join/index.tsx) and b11 §28.3. It replaces
// "press the step, then a second box asks for Touch ID".
//
// Nothing about the gate changes: the button only hands a presence proof to the caller, which sends
// it once to its existing `presence: true` route (owner.ts); the page never signs.
// - Desktop app with Touch ID / Windows Hello turned on: the proof is `native` (the server runs the
//   gesture for a ceremony it issued for exactly that request).
// - A passkey here: the gesture starts inside the click (Safari's user-gesture rule), so the caller
//   must do any reading (a name check) before the click, never between the click and the gesture.
// - Neither: the one button opens the master code (PresencePrompt, code first), as does the link.
// The statement the gesture confirms is the button's accessible description, and the line above
// the master code field. A double click asks once (REL051-UF3).
import { Button } from '@4thtech-io/ui';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { UseCodeInstead } from '../first-run/backup-code.js';
import { detectPlatform } from '../first-run/passkey.js';
import { SENSOR, type Platform } from '../first-run/strings.js';
import { desktopPlatform } from '../../presence/desktop.js';
import { readNativeStatus, type NativeStatus } from '../../presence/native-api.js';
import { FingerprintIcon } from '../invite/icons.js';
import { passkeyProof, type OwnerClient, type PasskeyInfo, type PresenceProof } from './owner.js';
import { usePresenceFlight } from './presence-flight.js';
import { PresencePrompt } from './presence-prompt.js';

export type Gesture = (info: PasskeyInfo) => Promise<PresenceProof | undefined>;

export interface PresenceButtonProps {
  /** The button's words with the sensor's name: "Save with Touch ID". */
  readonly withSensor: (sensor: string) => string;
  /** The button's words when only the master code works here. */
  readonly withCode: string;
  /** What the owner confirms (the signed operation, in plain words). */
  readonly statement: string;
  /** The caller is sending the request. */
  readonly busy: boolean;
  /** The caller's answer to a refused request (shown under the button, or the code field). */
  readonly error?: string | undefined;
  /** UX1113-N2: a danger button for Remove and Block. */
  readonly variant?: 'primary' | 'danger';
  /** The caller's own reason to hold the button (an invalid name). */
  readonly disabled?: boolean;
  /** Said when the sensor was cancelled; nothing was sent. */
  readonly notUsed: string;
  /** The proof, once, for one request. */
  readonly onProof: (proof: PresenceProof) => void;
  /** Reads the passkey this browser can use. */
  readonly owner: OwnerClient;
  /** Seams (tests): the passkey gesture, the platform, the native status and the user agent. */
  readonly gesture?: Gesture;
  readonly platform?: Platform;
  readonly nativeStatus?: () => Promise<NativeStatus>;
  readonly userAgent?: string;
}

/** Seams for tests of the pages that mount this button deep inside (People, Home, IDs). */
export interface PresenceSeams {
  readonly gesture?: Gesture;
  readonly platform?: Platform;
  readonly nativeStatus?: () => Promise<NativeStatus>;
  readonly userAgent?: string;
}
export const PresenceSeamsContext = createContext<PresenceSeams>({});

/** What this computer offers for one owner step (read once per mount, or when `watch` changes). */
export type PresenceMode =
  | { readonly kind: 'reading' }
  | { readonly kind: 'native'; readonly sensor: string }
  | { readonly kind: 'passkey'; readonly info: PasskeyInfo }
  | { readonly kind: 'code' };

/**
 * N3 / OWNERSTEP-LEFT: the one reading every one-step owner button shares (PresenceButton, the
 * approval card, the Inbox Save): the desktop app's Touch ID / Windows Hello when it is turned on
 * there, else the passkey this browser can use, else the master code. `sensor` is the word the
 * button names ("Touch ID", "Windows Hello", "your passkey").
 */
export function usePresenceMode({
  readPasskey,
  watch,
  platform: givenPlatform,
  nativeStatus: givenNativeStatus,
  userAgent: givenUserAgent,
}: {
  readonly readPasskey: () => Promise<PasskeyInfo | undefined>;
  /** Read again when this changes (the page learnt of a passkey after the button mounted). */
  readonly watch?: string | undefined;
} & Omit<PresenceSeams, 'gesture'>): { readonly mode: PresenceMode; readonly sensor: string } {
  const seams = useContext(PresenceSeamsContext);
  const nativeStatus = givenNativeStatus ?? seams.nativeStatus ?? readNativeStatus;
  const userAgent = givenUserAgent ?? seams.userAgent;
  const [platform] = useState<Platform>(() => givenPlatform ?? seams.platform ?? detectPlatform());
  const [mode, setMode] = useState<PresenceMode>({ kind: 'reading' });
  useEffect(() => {
    let live = true;
    const desktop = desktopPlatform(userAgent);
    void (async () => {
      if (desktop !== undefined) {
        const status = await nativeStatus().catch((): NativeStatus => ({
          available: false,
          registered: false,
        }));
        if (status.available && status.registered && status.reason === undefined) {
          if (live) {
            setMode({ kind: 'native', sensor: desktop === 'mac' ? 'Touch ID' : 'Windows Hello' });
          }
          return;
        }
      }
      const info = await readPasskey().catch(() => undefined);
      if (!live) return;
      setMode(info === undefined ? { kind: 'code' } : { kind: 'passkey', info });
    })();
    return () => {
      live = false;
    };
    // Read once (and again when `watch` changes): what this computer offers decides the button.
  }, [watch]);
  return { mode, sensor: mode.kind === 'native' ? mode.sensor : SENSOR[platform] };
}

export function PresenceButton({
  withSensor,
  withCode,
  statement,
  busy,
  error,
  disabled = false,
  variant = 'primary',
  notUsed,
  onProof,
  owner,
  gesture: ownGesture,
  platform: ownPlatform,
  nativeStatus: ownNativeStatus,
  userAgent: ownUserAgent,
}: PresenceButtonProps): ReactElement {
  const seams = useContext(PresenceSeamsContext);
  const gesture = ownGesture ?? seams.gesture ?? passkeyProof;
  const { mode, sensor } = usePresenceMode({
    readPasskey: () => owner.passkey(),
    ...(ownPlatform === undefined ? {} : { platform: ownPlatform }),
    ...(ownNativeStatus === undefined ? {} : { nativeStatus: ownNativeStatus }),
    ...(ownUserAgent === undefined ? {} : { userAgent: ownUserAgent }),
  });
  const userAgent = ownUserAgent ?? seams.userAgent;
  const [askCode, setAskCode] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const flight = usePresenceFlight(busy);
  const mounted = useRef(true);
  const describedBy = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const held = busy || flight.asking || disabled || mode.kind === 'reading';

  const press = (): void => {
    if (held) return;
    setCancelled(false);
    if (mode.kind === 'code') {
      setAskCode(true);
      return;
    }
    if (!flight.start()) return;
    if (mode.kind === 'native') {
      flight.done();
      onProof({ kind: 'native' });
      return;
    }
    if (mode.kind !== 'passkey') return;
    // Inside the click: no request before the gesture.
    void gesture(mode.info)
      .catch(() => undefined)
      .then((proof) => {
        flight.done();
        if (!mounted.current) return;
        if (proof === undefined) setCancelled(true);
        else onProof(proof);
      });
  };

  if (askCode) {
    return (
      <PresencePrompt
        summary={statement}
        passkey={mode.kind === 'passkey' ? mode.info : undefined}
        codeFirst
        busy={busy}
        error={error}
        onSubmit={onProof}
        onCancel={() => setAskCode(false)}
        userAgent={userAgent ?? ''}
      />
    );
  }

  const message = cancelled ? notUsed : error;
  return (
    <div>
      <span id={describedBy} className="al-sr-only">
        {statement}
      </span>
      <div className="ct-actions">
        <Button
          variant={variant}
          className="al-press"
          onClick={press}
          disabled={held}
          aria-describedby={describedBy}
          {...(mode.kind === 'native' ? { 'data-native-confirm': '' } : {})}
        >
          <span className="inv-btn-in">
            {mode.kind === 'code' ? null : <FingerprintIcon />}
            {mode.kind === 'code' ? withCode : withSensor(sensor)}
          </span>
        </Button>
        {mode.kind === 'code' || mode.kind === 'reading' ? null : (
          <UseCodeInstead
            disabled={busy || flight.asking || disabled}
            onClick={() => {
              setCancelled(false);
              setAskCode(true);
            }}
          />
        )}
      </div>
      {message === undefined ? null : (
        <p className="al-text-body-sm ct-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
