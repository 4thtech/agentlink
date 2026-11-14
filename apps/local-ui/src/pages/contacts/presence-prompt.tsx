// The owner-presence prompt of Contacts (04 §2.5; 11 §6.2.1): the passkey, or the master code. It
// hands the proof to the caller, which sends it once to a presence route; the page never signs.
// Shared by the contact detail (check, rename, remove) and the Add contact sheet (accept, UX2-d2).
//
// HOTFIX-045-TOUCHID: when the passkey can't be used, the prompt says why in plain words instead of
// falling back to the master code silently, and an owner without a passkey on this computer can
// switch once inside the sheet (passkey-switch.ts): the master code and one touch register the
// passkey; then the operation itself is confirmed with its own touch (one entry, one operation).
import { Button, InlineError } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { EARLIER_OWNER_CODE_HINT } from '../../strings.js';
import { ForgotCodeLink } from '../start-over/forgot-link.js';
import { detectPlatform } from '../first-run/passkey.js';
import { BackupCodeField, UseCodeInstead } from '../first-run/backup-code.js';
import {
  forgetSwitchUnsupported,
  otherBrowser,
  rememberSwitchUnsupported,
  switchUnsupportedHere,
} from '../first-run/passkey-nudge.js';
import { SENSOR, UPGRADE, UPGRADE_MESSAGES } from '../first-run/strings.js';
import {
  passkeyProof,
  readPasskeyStatus,
  type PasskeyInfo,
  type PasskeyStatus,
  type PresenceProof,
} from './owner.js';
import { switchToPasskey, type SwitchToPasskey } from './passkey-switch.js';
import { desktopPlatform, nativeConfirmLabel } from '../../presence/desktop.js';
import { readNativeStatus, type NativeStatus } from '../../presence/native-api.js';
import { usePresenceFlight } from './presence-flight.js';
import { CONTACTS_STRINGS as S, PASSKEY_WHY } from './strings.js';

type Unavailable = Extract<PasskeyStatus, { kind: 'unavailable' }>;

export function PresencePrompt({
  summary,
  passkey,
  busy,
  error,
  onSubmit,
  onCancel,
  passkeyStatus = readPasskeyStatus,
  switchPasskey = switchToPasskey,
  codeFirst = false,
  nativeStatus = readNativeStatus,
  userAgent,
}: {
  summary: string;
  passkey: PasskeyInfo | undefined;
  busy: boolean;
  error: string | undefined;
  onSubmit: (proof: PresenceProof) => void;
  onCancel: () => void;
  /** HOTFIX-045-TOUCHID seams (tests): the passkey state read and the one-time switch. */
  passkeyStatus?: () => Promise<PasskeyStatus>;
  switchPasskey?: SwitchToPasskey;
  /**
   * FB-8: the owner already chose "Use your master code instead" on the caller's screen, so the
   * prompt opens on the code field and does not ask for the passkey again.
   */
  codeFirst?: boolean;
  /** DESK-D12c seams (tests): the native presence status read, and the user agent. */
  nativeStatus?: () => Promise<NativeStatus>;
  userAgent?: string;
}): ReactElement {
  const [code, setCode] = useState('');
  const [useCode, setUseCode] = useState(codeFirst || passkey === undefined);
  const [notUsed, setNotUsed] = useState(false);
  const [found, setFound] = useState<PasskeyInfo | undefined>(undefined);
  const [why, setWhy] = useState<Unavailable | undefined>(undefined);
  const [switching, setSwitching] = useState(false);
  const [working, setWorking] = useState(false);
  const [switchNote, setSwitchNote] = useState<string | undefined>(undefined);
  const [switched, setSwitched] = useState(false);
  // F49: a switch already failed in this browser for lack of PRF, so it is not offered again here.
  const [noSwitch, setNoSwitch] = useState(switchUnsupportedHere);
  const mounted = useRef(true);
  // DESK-D12c: in the desktop app, Touch ID / Windows Hello is the primary confirm once it is on.
  const desktop = desktopPlatform(userAgent);
  const [native, setNative] = useState(false);
  const platform = detectPlatform();
  const sensor = SENSOR[platform];
  const info = passkey ?? found;
  // REL051-UF3 (R1-UI-06): a double click on the sensor button asks once.
  const flight = usePresenceFlight(busy);
  const held = busy || flight.asking;

  const readStatus = async (): Promise<PasskeyStatus> => {
    try {
      return await passkeyStatus();
    } catch {
      return { kind: 'unavailable', reason: 'unknown' };
    }
  };

  useEffect(() => {
    mounted.current = true;
    if (desktop !== undefined && !codeFirst) {
      void nativeStatus()
        .catch((): NativeStatus => ({ available: false, registered: false }))
        .then((status) => {
          if (
            !mounted.current ||
            !status.available ||
            !status.registered ||
            status.reason !== undefined
          )
            return;
          setNative(true);
          setUseCode(false);
        });
    }
    if (passkey === undefined) {
      void readStatus().then((status) => {
        if (!mounted.current) return;
        if (status.kind === 'ready') {
          setFound(status.info);
          if (!codeFirst) setUseCode(false);
        } else {
          setWhy(status);
        }
      });
    }
    return () => {
      mounted.current = false;
    };
    // Read once per prompt: the caller's passkey answer, or this read, decides what is offered.
  }, []);

  const submitCode = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    if (code.trim() === '') {
      setSwitchNote(UPGRADE_MESSAGES.empty);
      return;
    }
    setSwitchNote(undefined);
    const proof: PresenceProof = { kind: 'code', code };
    setCode('');
    onSubmit(proof);
  };
  const usePasskey = (): void => {
    if (info === undefined || busy || !flight.start()) return;
    setNotUsed(false);
    void passkeyProof(info)
      .catch(() => undefined)
      .then((proof) => {
        flight.done();
        if (!mounted.current) return;
        if (proof === undefined) setNotUsed(true);
        else onSubmit(proof);
      });
  };

  const submitSwitch = (event: FormEvent): void => {
    event.preventDefault();
    const values = why?.switchTo;
    if (values === undefined || working || busy) return;
    if (code === '') {
      setSwitchNote(UPGRADE_MESSAGES.empty);
      return;
    }
    const typed = code;
    setWorking(true);
    setSwitchNote(undefined);
    void (async () => {
      const outcome = await switchPasskey(values, typed);
      if (!mounted.current) return;
      setCode('');
      if (
        outcome.kind === 'switched' ||
        (outcome.kind === 'error' && outcome.problem === 'passkey_exists')
      ) {
        const status = await readStatus();
        if (!mounted.current) return;
        setWorking(false);
        if (status.kind === 'ready') {
          forgetSwitchUnsupported();
          setFound(status.info);
          setWhy(undefined);
          setSwitching(false);
          setUseCode(false);
          setSwitched(true);
        } else {
          setSwitchNote(UPGRADE_MESSAGES.failed);
        }
        return;
      }
      setWorking(false);
      if (outcome.kind === 'cancelled') return setSwitchNote(PASSKEY_WHY.switchCancelled);
      if (
        outcome.kind === 'unsupported' ||
        (outcome.kind === 'error' && outcome.problem === 'passkey_unsupported')
      ) {
        // F49: this computer's passkey gives no PRF. Back to the master code, which confirms this
        // operation now; the switch is not pushed again in this browser (a UI nudge only).
        rememberSwitchUnsupported();
        setNoSwitch(true);
        setSwitching(false);
        return setSwitchNote(PASSKEY_WHY.switchUnsupported(sensor, otherBrowser(platform)));
      }
      const problem = outcome.problem;
      if (problem === 'wait') return setSwitchNote(UPGRADE_MESSAGES.wait(outcome.retryAfter ?? 1));
      if (
        problem === 'presence_rejected' ||
        problem === 'presence_required' ||
        problem === 'busy' ||
        problem === 'forbidden' ||
        problem === 'offline' ||
        problem === 'session_expired'
      ) {
        return setSwitchNote(UPGRADE_MESSAGES[problem]);
      }
      return setSwitchNote(UPGRADE_MESSAGES.failed);
    })();
  };

  const whyText =
    why === undefined
      ? undefined
      : why.reason === 'browser'
        ? PASSKEY_WHY.browser(sensor, otherBrowser(platform))
        : noSwitch && why.reason === 'not_set_up_here'
          ? PASSKEY_WHY.noSwitchHere(sensor)
          : PASSKEY_WHY[why.reason](sensor);
  const canSwitch = why?.switchTo !== undefined && !noSwitch;

  return (
    <section className="ct-presence" aria-label={S.presenceIntro}>
      <p className="al-text-body">
        <strong>{summary}</strong>
      </p>
      <p className="al-text-body-sm al-muted">{S.presenceIntro}</p>
      {switched ? (
        <p className="al-text-body-sm" role="status">
          {PASSKEY_WHY.switched(sensor)}
        </p>
      ) : null}
      {switching ? (
        <form className="ct-presence-form" onSubmit={submitSwitch} autoComplete="off">
          <p className="al-text-body-sm al-muted">{PASSKEY_WHY.switchIntro(sensor)}</p>
          {/* As the approval card's code field (11 §5): no autofill invitation. */}
          <BackupCodeField
            label={S.ownerCode}
            hint={EARLIER_OWNER_CODE_HINT}
            name="owner-code"
            value={code}
            disabled={working}
            onValue={setCode}
          />
          <div className="ct-actions">
            <Button type="submit" variant="primary" icon="key-round" disabled={working || busy}>
              {UPGRADE.bannerAction(platform)}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setSwitching(false);
                setSwitchNote(undefined);
                setCode('');
              }}
              disabled={working}
            >
              {PASSKEY_WHY.switchCancel}
            </Button>
          </div>
          {switchNote === undefined ? null : <InlineError>{switchNote}</InlineError>}
        </form>
      ) : native && !useCode && desktop !== undefined ? (
        <div className="ct-actions">
          <Button
            variant="primary"
            icon="approval"
            onClick={() => {
              if (!busy) onSubmit({ kind: 'native' });
            }}
            disabled={busy}
            data-native-confirm=""
          >
            {nativeConfirmLabel(desktop)}
          </Button>
          <UseCodeInstead onClick={() => setUseCode(true)} disabled={busy} />
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {S.cancel}
          </Button>
        </div>
      ) : useCode ? (
        <>
          {whyText === undefined ? null : (
            <p className="al-text-body-sm al-muted" role="status">
              {whyText}
            </p>
          )}
          <form className="ct-presence-form" onSubmit={submitCode}>
            <BackupCodeField
              label={S.ownerCode}
              hint={EARLIER_OWNER_CODE_HINT}
              name="owner-code"
              value={code}
              onValue={setCode}
            />
            {/* OWNER-START-OVER (D-153): the way out when the master code is lost. */}
            <ForgotCodeLink />
            {/* F49: one primary action, the master code confirms. The switch is a quiet link. */}
            <div className="ct-actions">
              <Button type="submit" variant="primary" disabled={busy} data-confirm-code="">
                {S.confirmWithCode}
              </Button>
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                {S.cancel}
              </Button>
            </div>
            {switchNote === undefined ? null : <InlineError>{switchNote}</InlineError>}
            {canSwitch ? (
              <Button
                variant="ghost"
                size="sm"
                icon="key-round"
                className="ct-switch-link"
                data-switch-passkey=""
                onClick={() => {
                  setSwitching(true);
                  setSwitchNote(undefined);
                  setCode('');
                }}
                disabled={busy}
              >
                {UPGRADE.bannerAction(platform)}
              </Button>
            ) : null}
          </form>
        </>
      ) : (
        <div className="ct-actions">
          <Button variant="primary" icon="approval" onClick={usePasskey} disabled={held}>
            {S.usePasskeyOn(sensor)}
          </Button>
          <UseCodeInstead onClick={() => setUseCode(true)} disabled={held} />
          <Button variant="ghost" onClick={onCancel} disabled={held}>
            {S.cancel}
          </Button>
        </div>
      )}
      {notUsed ? (
        <p className="al-text-body-sm al-muted" role="status">
          {S.passkeyNotUsed}
        </p>
      ) : null}
      {error === undefined ? null : <InlineError>{error}</InlineError>}
    </section>
  );
}
