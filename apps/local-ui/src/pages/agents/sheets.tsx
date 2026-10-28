// U3-h: Rename (inline on the row), Add an agent and Remove an agent (b11 §29.3 to §29.5). Each is an
// owner operation behind the presence gate: the page sends one request with the proof and the
// server signs. The routes of U3-d and U3-e may still be stubs (501): that reads as a plain
// "not done" sentence and nothing is claimed. Labels are rendered as text only (I-5).
import { Button, Sheet, TextField } from '@4thtech-io/ui';
import { useId, useState, type FormEvent, type ReactElement } from 'react';
import { navigate } from '../../router.js';
import type { OwnerClient, PresenceProof } from '../contacts/owner.js';
import { AppMark } from './app-mark.js';
import type { AgentsApi, OwnerOutcome } from './api.js';
import { AGENTS_APPS_PATH, type AgentRow } from './data.js';
import { gateMessage, OwnerGate, RETRY_IN_PLACE, usePasskey } from './owner-gate.js';
import { AGENTS_STRINGS as S } from './strings.js';

/** The label rule the person sees: 1 to 40 characters, no control characters (06 §6). */
export const LABEL_MAX = 40;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export function labelProblem(text: string): boolean {
  const t = text.trim();
  return t === '' || [...t].length > LABEL_MAX || CONTROL.test(t);
}

interface Shared {
  readonly api: AgentsApi;
  readonly owner: OwnerClient;
  readonly generation: number;
}

// ------------------------------------------------------------------------------------------ Rename

export function RenameEditor({
  row,
  api,
  owner,
  generation,
  onDone,
  onCancel,
  onChanged,
}: Shared & {
  row: AgentRow;
  onDone: () => void;
  onCancel: () => void;
  onChanged: () => void;
}): ReactElement {
  const passkey = usePasskey(owner);
  const [text, setText] = useState(row.label);
  const [step, setStep] = useState<'edit' | 'presence'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const label = text.trim();
  const unchanged = label === row.label;

  const send = (proof: PresenceProof): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void api.rename({ name: row.name, label, generation }, proof).then((outcome) => {
      setBusy(false);
      if (outcome.kind === 'done') {
        onChanged();
        onDone();
        return;
      }
      const said = gateMessage(outcome);
      if (said !== undefined) return setError(said);
      if (outcome.kind === 'agent_changed') {
        onChanged();
        return setError(S.agentChanged);
      }
      setError(
        outcome.kind === 'failed' || outcome.kind === 'label_invalid' || outcome.kind === 'refused'
          ? S.renameFailed
          : S.notRenamed,
      );
      if (!RETRY_IN_PLACE.has(outcome.kind)) setStep('edit');
    });
  };

  if (step === 'presence') {
    return (
      <OwnerGate
        summary={S.renameStatement(row.label, label)}
        passkey={passkey}
        busy={busy}
        error={error}
        onProof={send}
        onCancel={() => setStep('edit')}
      />
    );
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (labelProblem(text) || unchanged) return;
    setError(undefined);
    setStep('presence');
  };
  return (
    <form className="ag-rename" onSubmit={submit}>
      <TextField
        label={S.renameField}
        name="agent-label"
        type="text"
        maxLength={LABEL_MAX}
        autoComplete="off"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="ag-actions">
        <Button
          type="submit"
          variant="primary"
          icon="approval"
          disabled={labelProblem(text) || unchanged}
        >
          {S.saveTouchId}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {S.cancel}
        </Button>
      </div>
      {error === undefined ? null : (
        <p className="al-text-body-sm ag-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// -------------------------------------------------------------------------------------------- Add

export function AddSheet({
  api,
  owner,
  generation,
  existing,
  onClose,
  onChanged,
  onAdded,
}: Shared & {
  existing: readonly AgentRow[];
  onClose: () => void;
  onChanged: () => void;
  /** After a successful add: the label, and whether to switch to it. */
  onAdded: (label: string, switchToIt: boolean) => void;
}): ReactElement {
  const passkey = usePasskey(owner);
  const [text, setText] = useState<string>(S.addDefaultName);
  const [switchToIt, setSwitchToIt] = useState(false);
  const [step, setStep] = useState<'name' | 'presence' | 'added'>('name');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const switchId = useId();
  const label = text.trim();
  const taken = existing.some((r) => r.label === label);

  const send = (proof: PresenceProof): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void api.add({ label, generation }, proof).then((outcome: OwnerOutcome) => {
      setBusy(false);
      if (outcome.kind === 'done') {
        onChanged();
        onAdded(label, switchToIt);
        setStep('added');
        return;
      }
      const said = gateMessage(outcome);
      if (said !== undefined) return setError(said);
      if (outcome.kind === 'agent_changed') {
        onChanged();
        return setError(S.agentChanged);
      }
      setError(outcome.kind === 'label_invalid' ? S.notAdded : S.addFailed);
      if (!RETRY_IN_PLACE.has(outcome.kind)) setStep('name');
    });
  };

  return (
    <Sheet open title={S.addTitle} onClose={onClose} closeLabel={S.close} className="ag-sheet">
      {step === 'added' ? (
        <div className="ag-sheet-body">
          <p className="al-text-body" role="status">
            {label}
          </p>
          <p className="al-text-title-3">{S.addedPrompt}</p>
          <div className="ag-actions">
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                navigate(AGENTS_APPS_PATH);
              }}
            >
              {S.connectApp}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {S.notNow}
            </Button>
          </div>
        </div>
      ) : step === 'presence' ? (
        <OwnerGate
          summary={S.addStatement(label)}
          passkey={passkey}
          busy={busy}
          error={error}
          onProof={send}
          onCancel={() => setStep('name')}
        />
      ) : (
        <form
          className="ag-sheet-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (labelProblem(text)) return;
            setError(undefined);
            setStep('presence');
          }}
        >
          <TextField
            label={S.addField}
            name="new-agent-label"
            type="text"
            maxLength={LABEL_MAX}
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            {...(taken ? { hint: 'You already have an agent with this name.' } : {})}
          />
          <label className="ag-check" htmlFor={switchId}>
            <input
              id={switchId}
              type="checkbox"
              checked={switchToIt}
              onChange={(e) => setSwitchToIt(e.currentTarget.checked)}
            />
            <span>{S.switchToIt}</span>
          </label>
          <div className="ag-actions">
            <Button type="submit" variant="primary" icon="approval" disabled={labelProblem(text)}>
              {S.addTouchId}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {S.cancel}
            </Button>
          </div>
          {error === undefined ? null : (
            <p className="al-text-body-sm ag-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------ Remove

type RemovePhase =
  | { readonly kind: 'form' }
  | { readonly kind: 'presence'; readonly anyway: boolean }
  | { readonly kind: 'in_use' }
  | { readonly kind: 'anyway' }
  | { readonly kind: 'failed' };

export function RemoveSheet({
  row,
  api,
  owner,
  generation,
  onClose,
  onChanged,
  onRemoved,
  onAgentChanged,
}: Shared & {
  row: AgentRow;
  onClose: () => void;
  onChanged: () => void;
  onRemoved: (label: string) => void;
  onAgentChanged: () => void;
}): ReactElement {
  const passkey = usePasskey(owner);
  const [phase, setPhase] = useState<RemovePhase>({ kind: 'form' });
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const nameId = useId();
  const matches = typed === row.label;
  const contacts = row.contacts ?? 0;

  const send =
    (anyway: boolean) =>
    (proof: PresenceProof): void => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      void api
        .remove(
          { name: row.name, typedLabel: typed, generation, ...(anyway ? { anyway: true } : {}) },
          proof,
        )
        .then((outcome) => {
          setBusy(false);
          if (outcome.kind === 'done') {
            onChanged();
            onRemoved(row.label);
            return;
          }
          if (outcome.kind === 'agent_changed') {
            onAgentChanged();
            return;
          }
          const said = gateMessage(outcome);
          if (said !== undefined) return setError(said);
          if (outcome.kind === 'in_use') return setPhase({ kind: 'in_use' });
          if (outcome.kind === 'contacts_unreachable') return setPhase({ kind: 'anyway' });
          // Part-way or not available yet: the agent may now be marked "Removal not finished".
          onChanged();
          setPhase({ kind: 'failed' });
        });
    };

  const inProgress = busy && phase.kind === 'presence';
  const title = inProgress ? S.removingTitle(row.label) : S.removeTitle(row.label);
  return (
    <Sheet
      open
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeLabel={S.close}
      className="ag-sheet"
    >
      <div className="ag-sheet-body">
        {phase.kind === 'form' || phase.kind === 'presence' ? (
          <>
            <p className="al-text-body">{S.removeIntro}</p>
            <ul className="ag-goes">
              <li>{S.keysAndSettings(row.label)}</li>
              <li>{S.history(row.contacts)}</li>
              {row.apps.map((app) => (
                <li key={app}>{S.itsEntry(app)}</li>
              ))}
            </ul>
            {contacts > 0 ? (
              <p className="al-text-body">{S.contactsTold(row.label, contacts)}</p>
            ) : null}
            <p className="al-text-body">
              <strong>{S.cantUndo}</strong>
            </p>
            <p className="al-text-caption al-muted">{S.agentFolder(row.name)}</p>
          </>
        ) : null}

        {phase.kind === 'form' ? (
          <>
            <div className="ag-actions">
              <Button
                variant="secondary"
                icon="download"
                onClick={() => {
                  onClose();
                  navigate('/settings/backup');
                }}
              >
                {S.exportFirst}
              </Button>
            </div>
            <TextField
              id={nameId}
              label={S.typeName}
              aria-label={S.typeNameLabel(row.label)}
              name="confirm-label"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
            />
            <div className="ag-actions">
              <Button
                variant="danger"
                icon="approval"
                disabled={!matches}
                aria-describedby={matches ? undefined : `${nameId}-why`}
                onClick={() => {
                  setError(undefined);
                  setPhase({ kind: 'presence', anyway: false });
                }}
              >
                {S.removeTouchId}
              </Button>
              <Button variant="ghost" onClick={onClose}>
                {S.cancel}
              </Button>
            </div>
            {matches ? null : (
              <p id={`${nameId}-why`} className="al-text-caption al-muted">
                {S.typeNameDisabled}
              </p>
            )}
          </>
        ) : null}

        {phase.kind === 'presence' ? (
          <OwnerGate
            summary={S.removeStatement(row.label)}
            passkey={passkey}
            busy={busy}
            error={error}
            onProof={send(phase.anyway)}
            onCancel={() => setPhase({ kind: 'form' })}
          />
        ) : null}

        {phase.kind === 'in_use' ? (
          <>
            <p className="al-text-body" role="alert">
              <strong>{S.quitAny(row.label)}</strong>
            </p>
            {row.apps.length > 0 ? (
              <ul className="ag-goes">
                {row.apps.map((app) => (
                  <li key={app}>
                    <AppMark name={app} />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="ag-actions">
              <Button
                variant="primary"
                onClick={() => {
                  setError(undefined);
                  setPhase({ kind: 'presence', anyway: false });
                }}
              >
                {S.checkAgain}
              </Button>
              <Button variant="ghost" onClick={onClose}>
                {S.cancel}
              </Button>
            </div>
          </>
        ) : null}

        {phase.kind === 'anyway' ? (
          <>
            <p className="al-text-body" role="alert">
              <strong>{S.removeAnywayQ}</strong>
            </p>
            <div className="ag-actions">
              <Button
                variant="danger"
                onClick={() => {
                  setError(undefined);
                  setPhase({ kind: 'presence', anyway: true });
                }}
              >
                {S.removeAnyway}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  // Not now leaves the agent retired: the list shows "Removal not finished".
                  onChanged();
                  onClose();
                }}
              >
                {S.notNow}
              </Button>
            </div>
          </>
        ) : null}

        {phase.kind === 'failed' ? (
          <>
            <p className="al-text-body" role="alert">
              <strong>{S.removeFailed(row.label)}</strong>
            </p>
            <div className="ag-actions">
              <Button variant="primary" onClick={() => setPhase({ kind: 'form' })}>
                {S.tryAgain}
              </Button>
              <Button variant="ghost" onClick={onClose}>
                {S.close}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
