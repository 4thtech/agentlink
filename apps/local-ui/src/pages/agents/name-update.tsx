// WP-1 Rename truth (S2; D-141, Decision 46; 08 §1; 11 §5.8): before an invite goes out while the
// open ID's card still carries an older name than its label, the invite panel asks for the update
// first: "Your invites still show {cardName}" with "Update name" (the rename gesture with the
// current label, which puts it in the card; owner-rename.ts) and "Invite as {cardName}" (the invite
// is made anyway, under the card's name). The page never signs: it hands the proof to the same
// owner route as Rename. Names are text only, each in its own bidi run (I-5).
import { Button } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import type { OwnerClient, PresenceProof } from '../contacts/owner.js';
import type { AgentsApi } from './api.js';
import { OwnerGate, usePasskey } from './owner-gate.js';
import { renameProblem } from './sheets.js';
import { AGENTS_STRINGS as S } from './strings.js';

export interface InviteNameGateProps {
  /** The name in the open ID's card (what the invite would carry). */
  readonly cardName: string;
  /** The open ID's verified label (what the owner sees in the app). */
  readonly label: string;
  readonly agents: AgentsApi;
  readonly owner: OwnerClient;
  /** The card now carries the label: make the invite. */
  readonly onUpdated: () => void;
  /** Make the invite under the card's name. */
  readonly onOldName: () => void;
}

export function InviteNameGate({
  cardName,
  label,
  agents,
  owner,
  onUpdated,
  onOldName,
}: InviteNameGateProps): ReactElement {
  const passkey = usePasskey(owner);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const send = (proof: PresenceProof): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void (async () => {
      // The rename names the open ID by its folder; the list says which one is open.
      const read = await agents.list();
      const open = read.kind === 'ok' ? read.list.agents.find((r) => r.current) : undefined;
      if (open === undefined) {
        setBusy(false);
        return setError(S.agentChanged);
      }
      const out = await agents.rename({ name: open.name, label }, proof);
      setBusy(false);
      if (out.kind === 'done') return onUpdated();
      setError(renameProblem(out, label));
    })();
  };

  return (
    <div className="ag-note" role="status" data-invite-name-gate>
      <p className="al-text-body-sm">
        <strong>
          {S.invitesStillShow}
          <bdi>{cardName}</bdi>
        </strong>
      </p>
      <p className="al-text-body-sm al-muted">
        {S.noteHint}
        <bdi>{label}</bdi>.
      </p>
      {asking ? (
        <OwnerGate
          summary={S.renameStatement(cardName, label)}
          passkey={passkey}
          busy={busy}
          error={error}
          onProof={send}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <div className="ag-actions">
          <Button variant="primary" size="sm" onClick={() => setAsking(true)}>
            {S.updateName}
          </Button>
          <Button variant="secondary" size="sm" onClick={onOldName}>
            {S.inviteAs}
            <bdi>{cardName}</bdi>
          </Button>
        </div>
      )}
    </div>
  );
}
