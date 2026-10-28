// The owner-presence prompt of Contacts (04 §2.5; 11 §6.2.1): the passkey, or the backup code. It
// hands the proof to the caller, which sends it once to a presence route; the page never signs.
// Shared by the contact detail (check, rename, remove) and the Add contact sheet (accept, UX2-d2).
import { Button, TextField } from '@4thtech-io/ui';
import { useState, type FormEvent, type ReactElement } from 'react';
import { EARLIER_OWNER_CODE_HINT } from '../../strings.js';
import { passkeyProof, type PasskeyInfo, type PresenceProof } from './owner.js';
import { CONTACTS_STRINGS as S } from './strings.js';

export function PresencePrompt({
  summary,
  passkey,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  summary: string;
  passkey: PasskeyInfo | undefined;
  busy: boolean;
  error: string | undefined;
  onSubmit: (proof: PresenceProof) => void;
  onCancel: () => void;
}): ReactElement {
  const [code, setCode] = useState('');
  const [useCode, setUseCode] = useState(passkey === undefined);
  const [notUsed, setNotUsed] = useState(false);

  const submitCode = (event: FormEvent): void => {
    event.preventDefault();
    if (code === '' || busy) return;
    const proof: PresenceProof = { kind: 'code', code };
    setCode('');
    onSubmit(proof);
  };
  const usePasskey = (): void => {
    if (passkey === undefined || busy) return;
    setNotUsed(false);
    void passkeyProof(passkey).then((proof) => {
      if (proof === undefined) setNotUsed(true);
      else onSubmit(proof);
    });
  };

  return (
    <section className="ct-presence" aria-label={S.presenceIntro}>
      <p className="al-text-body">
        <strong>{summary}</strong>
      </p>
      <p className="al-text-body-sm al-muted">{S.presenceIntro}</p>
      {useCode ? (
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
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              {S.cancel}
            </Button>
          </div>
        </form>
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
