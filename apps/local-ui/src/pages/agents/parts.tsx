// W4-AGENTS: the small parts the simple list, the fleet table and an agent's own page share: an AI
// app's dot and word, the Pause sheet (one click, no Touch ID), the paused banner with Resume (Touch
// ID, signs `agent.resume`), and the "Contacts still see {name}" note (D-141). Labels and former names
// are text only, each in its own bidi-isolated run (I-5).
import { Button, Pulse, Sheet } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import type { OwnerClient, PresenceProof } from '../contacts/owner.js';
import type { AgentsApi } from './api.js';
import { appDot, appWord, type AgentRow, type AppLive } from './data.js';
import { gateMessage, OwnerGate, usePasskey } from './owner-gate.js';
import { AGENTS_STRINGS as S } from './strings.js';

/** An AI app's dot: pulsing while Working (still under reduced motion), else the shell's shapes. */
export function AppDot({ app }: { app: AppLive }): ReactElement {
  return app.state === 'working' ? (
    <Pulse tone="success" className="ag-adot" />
  ) : (
    <span className={`al-ldot ag-adot is-${appDot(app)}`} aria-hidden="true" />
  );
}

/** "Claude Code · Working" for each app that runs the agent (never colour alone). */
export function AppChips({ apps, now }: { apps: readonly AppLive[]; now: number }): ReactElement {
  return (
    <ul className="ag-chips">
      {apps.map((a) => (
        <li key={a.id} className="ag-chip al-text-body-sm">
          <AppDot app={a} />
          <span className="ag-chip-name">{a.name}</span>
          <span className="al-muted">{appWord(a, now)}</span>
        </li>
      ))}
    </ul>
  );
}

/** 08 §1: "Pause {label}?" with Pause and Cancel; one click, no Touch ID. */
export function PauseSheet({
  row,
  generation,
  api,
  onClose,
  onPaused,
  onAgentChanged,
}: {
  row: AgentRow;
  generation: number;
  api: AgentsApi;
  onClose: () => void;
  onPaused: () => void;
  onAgentChanged: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const pause = (): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void api.pause(generation).then((out) => {
      setBusy(false);
      if (out.kind === 'done') return onPaused();
      if (out.kind === 'agent_changed') return onAgentChanged();
      setError(
        gateMessage({ kind: out.kind === 'not_available' ? 'failed' : out.kind }) ?? S.pauseFailed,
      );
    });
  };
  return (
    <Sheet open title={S.pauseTitle(row.label)} onClose={onClose} closeLabel={S.close}>
      <div className="ag-sheet-body">
        <p className="al-text-body">{S.pauseBody(row.label)}</p>
        {error === undefined ? null : (
          <p className="al-text-body-sm ag-error" role="alert">
            {error}
          </p>
        )}
        <div className="ag-actions">
          <Button variant="primary" icon="pause" onClick={pause} disabled={busy}>
            {S.pause}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {S.cancel}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/** Resume with Touch ID (or the owner code): signs `agent.resume` for the open agent. */
export function ResumeGate({
  row,
  api,
  owner,
  onCancel,
  onResumed,
  onAgentChanged,
}: {
  row: AgentRow;
  api: AgentsApi;
  owner: OwnerClient;
  onCancel: () => void;
  onResumed: () => void;
  onAgentChanged: () => void;
}): ReactElement {
  const passkey = usePasskey(owner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const send = (proof: PresenceProof): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void api.resume(proof).then((out) => {
      setBusy(false);
      // `not_paused`: it was resumed already (another tab); the list shows it.
      if (out.kind === 'done' || out.kind === 'not_paused') return onResumed();
      if (out.kind === 'agent_changed') return onAgentChanged();
      setError(gateMessage(out) ?? S.resumeFailed);
    });
  };
  return (
    <OwnerGate
      summary={S.resumeStatement(row.label)}
      passkey={passkey}
      busy={busy}
      error={error}
      onProof={send}
      onCancel={onCancel}
    />
  );
}

/** 08 §1: "{label} is paused" with "Resume with Touch ID" (only for the open agent). */
export function PausedBanner({
  row,
  resuming,
  onResume,
  children,
}: {
  row: AgentRow;
  resuming: boolean;
  onResume: () => void;
  /** The Resume gate, while open. */
  children?: ReactElement | null;
}): ReactElement {
  return (
    <div className="ag-banner al-reveal" data-paused-banner role="status">
      <p className="al-text-body">
        <bdi>{row.label}</bdi>
        {S.isPaused}
      </p>
      {resuming ? (
        children
      ) : (
        <Button variant="primary" icon="play" onClick={onResume}>
          {S.resumeTouchId}
        </Button>
      )}
    </div>
  );
}

/** D-141 (Decision 46): "Contacts still see {cardName}" with "Update contacts" (one gesture). */
export function CardNameNote({
  row,
  cardName,
  api,
  owner,
  onUpdated,
}: {
  row: AgentRow;
  cardName: string;
  api: AgentsApi;
  owner: OwnerClient;
  onUpdated: (told: boolean) => void;
}): ReactElement {
  const passkey = usePasskey(owner);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const send = (proof: PresenceProof): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void api.rename({ name: row.name, label: row.label }, proof).then((out) => {
      setBusy(false);
      if (out.kind === 'done') return onUpdated(out.contacts !== undefined && out.contacts > 0);
      setError(gateMessage(out) ?? S.renameFailed);
    });
  };
  return (
    <div className="ag-note">
      <p className="al-text-body-sm">
        {S.contactsStillSee}
        <bdi>{cardName}</bdi>
      </p>
      {asking ? (
        <OwnerGate
          summary={S.renameStatement(cardName, row.label)}
          passkey={passkey}
          busy={busy}
          error={error}
          onProof={send}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>
          {S.updateContacts}
        </Button>
      )}
    </div>
  );
}
