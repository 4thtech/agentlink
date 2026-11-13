// W4-AGENTS: the small parts the simple list, the fleet table and an agent's own page share: an AI
// app's dot and word, the Pause sheet (one click, no Touch ID), the paused banner with Resume (Touch
// ID, signs `agent.resume`), and the "Contacts still see {name}" note (D-141). Labels and former names
// are text only, each in its own bidi-isolated run (I-5).
import { Button, Icon, PageNotice, Pulse, Sheet } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import type { OwnerClient, PresenceProof } from '../contacts/owner.js';
import type { AgentsApi } from './api.js';
import { appDot, appWord, type AgentRow, type AppLive } from './data.js';
import { gateMessage, OwnerButton } from './owner-gate.js';
import { renameProblem } from './sheets.js';
import { AGENTS_STRINGS as S } from './strings.js';

/** An AI app's dot: pulsing while Working (still under reduced motion), else the shell's shapes. */
export function AppDot({ app }: { app: AppLive }): ReactElement {
  return app.state === 'working' ? (
    <Pulse tone="success" className="ag-adot" />
  ) : (
    <span className={`al-ldot ag-adot is-${appDot(app)}`} aria-hidden="true" />
  );
}

/** WP-I1 (I-3): a machine name such as `macbook-agent-1`, or the folder name that says "agent". */
const MACHINE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*-\d+$/;
export function machineNamed(row: Pick<AgentRow, 'label' | 'name'>): boolean {
  return MACHINE_NAME.test(row.label) || (row.label === row.name && /agent/i.test(row.label));
}

/** WP-I1: the name nudge on a card. The label is text in its own bidi run (I-5). */
export function NameNudge({
  row,
  onRename,
  duplicate = false,
}: {
  row: AgentRow;
  onRename: () => void;
  /** UX1113-QA2: another ID has the same name (a restore keeps names; folders differ). */
  duplicate?: boolean;
}): ReactElement {
  return (
    <div className="ag-nudge" role="note" data-nudge>
      <Icon name="info" size={18} />
      <p className="al-text-body-sm">
        {duplicate ? S.duplicateBefore : S.nudgeBefore}
        <strong>
          <bdi>{row.label}</bdi>
        </strong>
        {duplicate ? S.duplicateAfter : S.nudgeAfter}
      </p>
      <Button variant="secondary" size="sm" onClick={onRename}>
        {S.rename}
      </Button>
    </div>
  );
}

/** WP-I1: the kit state of one ID. Hidden until the kit record exists (WP-R2): `kit` is undefined. */
export type KitState = { readonly at: number } | 'none' | undefined;
export function KitPill({
  kit,
  onOpen,
}: {
  kit: KitState;
  onOpen: () => void;
}): ReactElement | null {
  if (kit === undefined) return null;
  const date =
    kit === 'none'
      ? ''
      : new Date(kit.at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return (
    <button
      type="button"
      className={`ag-kit ${kit === 'none' ? 'is-none' : 'is-ok'} al-text-label`}
      onClick={onOpen}
    >
      {kit === 'none' ? S.kitNone : S.kitBacked(date)}
    </button>
  );
}

/** The tile letters of the mockup: C, D and X; any other app uses the first letter of its name. */
const APP_LETTER: Readonly<Record<string, string>> = {
  'claude-code': 'C',
  'claude-desktop': 'D',
  codex: 'X',
};

/**
 * "Claude Code · Working" for each app that runs the agent (never colour alone). On a My IDs card
 * (`card`): a letter tile, the name, the dot and the word, and a ready app reads "Ready".
 */
export function AppChips({
  apps,
  now,
  card = false,
}: {
  apps: readonly AppLive[];
  now: number;
  card?: boolean;
}): ReactElement {
  return (
    <ul className="ag-chips">
      {apps.map((a) => (
        <li key={a.id} className="ag-chip al-text-body-sm">
          {card ? (
            <span className="ag-chip-tile" aria-hidden="true">
              {APP_LETTER[a.id] ?? [...a.name][0]?.toUpperCase()}
            </span>
          ) : null}
          {card ? null : <AppDot app={a} />}
          <span className="ag-chip-name">{a.name}</span>
          {card ? <AppDot app={a} /> : null}
          <span className="al-muted">
            {card && a.state === 'ready' && a.outdated !== true ? S.readyWord : appWord(a, now)}
          </span>
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

/** Resume with Touch ID (or the master code): signs `agent.resume` for the open agent. */
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
  /** Absent on the paused banner, where the button stands alone. */
  onCancel?: () => void;
  onResumed: () => void;
  onAgentChanged: () => void;
}): ReactElement {
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
    <div className="ag-actions">
      <OwnerButton
        owner={owner}
        statement={S.resumeStatement(row.label)}
        withSensor={S.resumeWith}
        withCode={S.resumeWithCode}
        busy={busy}
        error={error}
        onProof={send}
      />
      {onCancel === undefined ? null : (
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {S.cancel}
        </Button>
      )}
    </div>
  );
}

/** 08 §1: "{label} is paused" with "Resume with Touch ID" (only for the open agent). */
export function PausedBanner({
  row,
  children,
}: {
  row: AgentRow;
  /** UX1113-N2: the Resume button itself (one gesture): ResumeGate. */
  children?: ReactElement | null;
}): ReactElement {
  return (
    <div className="al-reveal" data-paused-banner>
      <PageNotice
        tone="warning"
        icon="pause"
        title={
          <>
            <bdi>{row.label}</bdi>
            {S.isPaused}
          </>
        }
        actions={children}
      />
    </div>
  );
}

/**
 * D-141 (Decision 46): "Contacts still see {cardName}" with "Update contacts" (one gesture). WP-1
 * (R-1): also with no contacts yet ("New invites still show {cardName}" with "Update name"), and
 * shown on the Simple card, Under the hood, the ID's own page and Home. The gesture is the rename
 * with the current label, which rotates the card to it (owner-rename.ts).
 */
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
  const noContacts = row.contacts === 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const send = (proof: PresenceProof): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void api.rename({ name: row.name, label: row.label }, proof).then((out) => {
      setBusy(false);
      if (out.kind === 'done') return onUpdated(out.contacts !== undefined && out.contacts > 0);
      setError(renameProblem(out, row.label));
    });
  };
  return (
    <div data-card-name-note>
      <PageNotice
        tone="info"
        icon="users"
        title={
          <>
            {noContacts ? S.newInvitesStillShow : S.contactsStillSee}
            <bdi>{cardName}</bdi>
          </>
        }
        actions={
          <OwnerButton
            owner={owner}
            statement={S.renameStatement(cardName, row.label)}
            withSensor={noContacts ? S.updateNameWith : S.updateContactsWith}
            withCode={noContacts ? S.updateNameWithCode : S.updateContactsWithCode}
            busy={busy}
            error={error}
            onProof={send}
          />
        }
      >
        <p>
          {S.noteHint}
          <bdi>{row.label}</bdi>.
        </p>
      </PageNotice>
    </div>
  );
}
