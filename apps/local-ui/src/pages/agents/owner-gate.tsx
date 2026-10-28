// U3-h: the owner-presence step shared by Rename, Add and Remove (04 §2.5). The page never signs: it
// hands the proof (the passkey, or the owner code) to one request, and the server's gate checks it.
// The statement names the agent and the change, so a prompt never approves something for another
// agent (b11 §29.1). Reuses the Contacts presence prompt.
import { useEffect, useState, type ReactElement } from 'react';
import { PresencePrompt } from '../contacts/presence-prompt.js';
import { waitSeconds, CONTACTS_STRINGS as C } from '../contacts/strings.js';
import type { OwnerClient, PasskeyInfo, PresenceProof } from '../contacts/owner.js';
import type { OwnerKind, OwnerOutcome } from './api.js';

/** The words for the gate's own outcomes; `undefined` for an outcome the caller words itself. */
export function gateMessage(outcome: OwnerOutcome): string | undefined {
  switch (outcome.kind) {
    case 'rejected':
      return C.presenceRejected;
    case 'required':
      return C.presenceRequired;
    case 'busy':
      return C.busy;
    case 'wait':
      return waitSeconds(30);
    case 'session':
      return C.sessionExpired;
    case 'offline':
      return "Can't reach AgentLink on this computer. Try again in a minute.";
    default:
      return undefined;
  }
}

/** Outcomes after which the person can type the code again without starting over. */
export const RETRY_IN_PLACE: ReadonlySet<OwnerKind> = new Set([
  'rejected',
  'required',
  'wait',
  'busy',
]);

export function usePasskey(owner: OwnerClient): PasskeyInfo | undefined {
  const [info, setInfo] = useState<PasskeyInfo | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void owner.passkey().then(
      (p) => {
        if (live) setInfo(p);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [owner]);
  return info;
}

export function OwnerGate({
  summary,
  passkey,
  busy,
  error,
  onProof,
  onCancel,
}: {
  summary: string;
  passkey: PasskeyInfo | undefined;
  busy: boolean;
  error: string | undefined;
  onProof: (proof: PresenceProof) => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <PresencePrompt
      summary={summary}
      passkey={passkey}
      busy={busy}
      error={error}
      onSubmit={onProof}
      onCancel={onCancel}
    />
  );
}
