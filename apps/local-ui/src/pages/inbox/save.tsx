// W4-FILES-SAVE: "Save to Inbox" on a received file (08 §1; b11 §34.4; 11 §5.7; 04 §2.5, §4). Shared
// by the Inbox (Needs you and the conversation) and Files, Received.
//
// OWNERSTEP-LEFT: one step. The button is the sensor ("Save with Touch ID": Touch ID in the Mac app
// when it is turned on there, else the passkey here), with "Use your master code instead" as a link;
// with neither, "Save to Inbox" opens the master code (approvals/card.tsx PresenceAction). The
// gesture is asked only after the click (11 §6.2.1). Only the item's ID is sent (save-api.ts); the
// saved name shows when the list is read again ("Saved as", untrusted text). Status lines are fixed
// strings: never the sender's file name (I-5).
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { DecisionPasskey, Presence } from '../approvals/client.js';
import { PresenceAction, type OwnerState } from '../approvals/card.js';
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

/** How long one read of the passkey serves every Save button on the page (one GET, not one per row). */
const PASSKEY_READ_MS = 30_000;
const reads = new WeakMap<
  PasskeyReader,
  { at: number; read: Promise<DecisionPasskey | undefined> }
>();
function sharedRead(reader: PasskeyReader): Promise<DecisionPasskey | undefined> {
  const now = Date.now();
  const hit = reads.get(reader);
  if (hit !== undefined && now - hit.at < PASSKEY_READ_MS) return hit.read;
  const read = reader().catch(() => undefined);
  reads.set(reader, { at: now, read });
  return read;
}

/** Owner state for the Save button: the passkey is read by the button itself. */
const SAVE_OWNER: OwnerState = Object.freeze({ ready: true });

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
  const [line, setLine] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const send = async (presence: Presence): Promise<void> => {
    setLine(undefined);
    const a = await api.save(id, presence);
    if (!alive.current) return;
    // IR-UX1113-N2-1 #2: a sensor proof the server refused was used, not "wasn't used".
    setLine(
      presence.kind !== 'code' && (a.kind === 'presence_rejected' || a.kind === 'presence_required')
        ? S.sensorRefused
        : saveAnswerText(a),
    );
    if (a.kind === 'outcome' && (a.outcome === 'saved' || a.outcome === 'already_saved')) {
      setDone(true);
      onSaved?.();
    }
  };

  return (
    <div className="ib-save" data-save={id}>
      {done ? null : (
        <PresenceAction
          owner={SAVE_OWNER}
          readPasskey={() => sharedRead(passkey)}
          size="sm"
          icon="inbox"
          withSensor={(sensor) => fmt(S.saveWith, { sensor })}
          withCode={S.saveToInbox}
          codeSubmit={S.confirmSave}
          statement={S.saveStepLabel}
          send={send}
        />
      )}
      <p role="status" className="al-text-body-sm al-muted">
        {line ?? ''}
      </p>
    </div>
  );
}
