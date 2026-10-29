// The owner-presence prompt of Contacts (04 §2.5; 11 §6.2.1): the passkey, or the backup code. It
// hands the proof to the caller, which sends it once to a presence route; the page never signs.
// Shared by the contact detail (check, rename, remove) and the Add contact sheet (accept, UX2-d2).
//
// HOTFIX-045-TOUCHID: when the passkey can't be used, the prompt says why in plain words instead of
// falling back to the backup code silently, and an owner without a passkey on this computer can
// switch once inside the sheet (passkey-switch.ts): the backup code and one touch register the
// passkey; then the operation itself is confirmed with its own touch (one entry, one operation).
import { Button, TextField } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { EARLIER_OWNER_CODE_HINT } from '../../strings.js';
import { detectPlatform } from '../first-run/passkey.js';
import { SENSOR, UPGRADE, UPGRADE_MESSAGES, WORKING_BROWSER } from '../first-run/strings.js';
import {
  passkeyProof,
  readPasskeyStatus,
  type PasskeyInfo,
  type PasskeyStatus,
  type PresenceProof,
} from './owner.js';
import { switchToPasskey, type SwitchToPasskey } from './passkey-switch.js';
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
}): ReactElement {
  const [code, setCode] = useState('');
  const [useCode, setUseCode] = useState(passkey === undefined);
  const [notUsed, setNotUsed] = useState(false);
  const [found, setFound] = useState<PasskeyInfo | undefined>(undefined);
  const [why, setWhy] = useState<Unavailable | undefined>(undefined);
  const [switching, setSwitching] = useState(false);
  const [working, setWorking] = useState(false);
  const [switchNote, setSwitchNote] = useState<string | undefined>(undefined);
  const [switched, setSwitched] = useState(false);
  const mounted = useRef(true);
  const platform = detectPlatform();
  const sensor = SENSOR[platform];
  const info = passkey ?? found;

  const readStatus = async (): Promise<PasskeyStatus> => {
    try {
      return await passkeyStatus();
    } catch {
      return { kind: 'unavailable', reason: 'unknown' };
    }
  };

  useEffect(() => {
    mounted.current = true;
    if (passkey === undefined) {
      void readStatus().then((status) => {
        if (!mounted.current) return;
        if (status.kind === 'ready') {
          setFound(status.info);
          setUseCode(false);
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
    if (code === '' || busy) return;
    const proof: PresenceProof = { kind: 'code', code };
    setCode('');
    onSubmit(proof);
  };
  const usePasskey = (): void => {
    if (info === undefined || busy) return;
    setNotUsed(false);
    void passkeyProof(info).then((proof) => {
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
      if (outcome.kind === 'unsupported') {
        return setSwitchNote(PASSKEY_WHY.switchUnsupported(sensor, WORKING_BROWSER[platform]));
      }
      const problem = outcome.problem;
      if (problem === 'wait') return setSwitchNote(UPGRADE_MESSAGES.wait(outcome.retryAfter ?? 1));
      if (problem === 'passkey_unsupported') {
        return setSwitchNote(PASSKEY_WHY.switchUnsupported(sensor, WORKING_BROWSER[platform]));
      }
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
        ? PASSKEY_WHY.browser(sensor, WORKING_BROWSER[platform])
        : PASSKEY_WHY[why.reason](sensor);
  const canSwitch = why?.switchTo !== undefined;

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
          <TextField
            label={S.ownerCode}
            hint={EARLIER_OWNER_CODE_HINT}
            name="owner-code"
            type="password"
            autoComplete="off"
            spellCheck={false}
            mono
            value={code}
            disabled={working}
            onChange={(e) => setCode(e.currentTarget.value)}
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
          {switchNote === undefined ? null : (
            <p className="al-text-body-sm ct-error" role="alert">
              {switchNote}
            </p>
          )}
        </form>
      ) : useCode ? (
        <>
          {whyText === undefined ? null : (
            <p className="al-text-body-sm al-muted" role="status">
              {whyText}
            </p>
          )}
          <form className="ct-presence-form" onSubmit={submitCode}>
            <TextField
              label={S.ownerCode}
              hint={EARLIER_OWNER_CODE_HINT}
              name="owner-code"
              type="password"
              autoComplete="off"
              spellCheck={false}
              mono
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
            />
            <div className="ct-actions">
              <Button type="submit" variant="primary" disabled={busy || code === ''}>
                {S.confirm}
              </Button>
              {canSwitch ? (
                <Button
                  variant="secondary"
                  icon="key-round"
                  onClick={() => {
                    setSwitching(true);
                    setCode('');
                  }}
                  disabled={busy}
                >
                  {UPGRADE.bannerAction(platform)}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                {S.cancel}
              </Button>
            </div>
          </form>
        </>
      ) : (
        <div className="ct-actions">
          <Button variant="primary" icon="approval" onClick={usePasskey} disabled={busy}>
            {S.usePasskey}
          </Button>
          <Button variant="ghost" onClick={() => setUseCode(true)} disabled={busy}>
            {S.useCode}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {S.cancel}
          </Button>
        </div>
      )}
      {notUsed ? (
        <p className="al-text-body-sm al-muted" role="status">
          {S.passkeyNotUsed}
        </p>
      ) : null}
      {error === undefined ? null : (
        <p className="al-text-body-sm ct-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
