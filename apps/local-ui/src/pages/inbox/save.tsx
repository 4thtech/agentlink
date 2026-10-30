// W4-FILES-SAVE: "Save to Inbox" on a received file (08 §1; b11 §34.4; 11 §5.7; 04 §2.5, §4). Shared
// by the Inbox (Needs you and the conversation) and Files, Received.
//
// Click "Save to Inbox", then the presence step: "Confirm with your passkey" when this computer has
// one, the backup code below it (the same step as an approval, approvals/card.tsx OwnerStep). The
// passkey is asked only after the click (11 §6.2.1). Only the item's ID is sent (save-api.ts); the
// saved name shows when the list is read again ("Saved as", untrusted text). Status lines are fixed
// strings: never the sender's file name (I-5).
import { Button } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { DecisionPasskey } from '../approvals/client.js';
import { OwnerStep } from '../approvals/card.js';
import type { SaveAnswer, SaveApi } from './save-api.js';
import { INBOX_STRINGS as S, fmt } from './strings.js';

/** What the presence step needs: the localhost passkey when one is registered. */
export type PasskeyReader = () => Promise<DecisionPasskey | undefined>;

export function saveAnswerText(answer: SaveAnswer): string {
  switch (answer.kind) {
    case 'outcome':
      return S.saveOutcome[answer.outcome];
    case 'wait':
      return fmt(S.wait, { seconds: String(answer.seconds) });
    case 'presence_rejected':
      return S.presenceRejected;
    case 'presence_required':
    case 'dismissed':
      return S.presenceNotUsed;
    case 'busy':
      return S.busy;
    case 'session_expired':
      return S.sessionExpired;
    case 'offline':
      return S.offline;
  }
}

export function SaveFile({
  id,
  api,
  passkey,
  onSaved,
}: {
  readonly id: string;
  readonly api: SaveApi;
  readonly passkey: PasskeyReader;
  /** The file was saved: the caller reads its list again (for "Saved as"). */
  readonly onSaved?: () => void;
}): ReactElement {
  const [step, setStep] = useState<{ passkey: DecisionPasskey | undefined } | undefined>(undefined);
  const [line, setLine] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const open = async (): Promise<void> => {
    setBusy(true);
    setLine(undefined);
    let found: DecisionPasskey | undefined;
    try {
      found = await passkey();
    } catch {
      found = undefined;
    }
    if (!alive.current) return;
    setBusy(false);
    setStep({ passkey: found });
  };

  const answer = (a: SaveAnswer): void => {
    if (!alive.current) return;
    setLine(saveAnswerText(a));
    if (a.kind === 'outcome' && (a.outcome === 'saved' || a.outcome === 'already_saved')) {
      setStep(undefined);
      setDone(true);
      onSaved?.();
      return;
    }
    // A dismissed passkey prompt keeps the step open for the backup code; anything else brings the
    // button back so the owner can try again.
    if (a.kind !== 'dismissed') setStep(undefined);
  };

  return (
    <div className="ib-save" data-save={id}>
      {!done && step === undefined ? (
        <Button size="sm" icon="inbox" disabled={busy} onClick={() => void open()}>
          {S.saveToInbox}
        </Button>
      ) : null}
      {step === undefined ? null : (
        <OwnerStep
          passkey={step.passkey !== undefined}
          passkeyLabel={S.confirmPasskey}
          codeSubmit={S.confirmSave}
          label={S.saveStepLabel}
          onPasskey={async () => {
            if (step.passkey === undefined) return;
            answer(await api.save(id, { kind: 'passkey', passkey: step.passkey }));
          }}
          onCode={async (code) => answer(await api.save(id, { kind: 'code', code }))}
        />
      )}
      <p role="status" className="al-text-body-sm al-muted">
        {line ?? ''}
      </p>
    </div>
  );
}
