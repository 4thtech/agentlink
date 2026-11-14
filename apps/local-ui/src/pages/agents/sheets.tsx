// U3-h: Rename (inline on the row) and Remove an agent (b11 §29.4, §29.5). W4-WIRE-2: Add an agent
// (§29.3) is Get started's add mode now (`/start/app?add=agent`, Decision 52 (2)). Each is an
// owner operation behind the presence gate: the page sends one request with the proof and the
// server signs. The routes of U3-d and U3-e may still be stubs (501): that reads as a plain
// "not done" sentence and nothing is claimed. Labels are rendered as text only (I-5).
import { Button, InlineError, Sheet, TextField } from '@4thtech-io/ui';
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { FAILURE_COPY } from '../../api/failure-reasons.js';
import { ExportKit } from '../backup/export-kit.js';
import type { OwnerClient, PresenceProof } from '../contacts/owner.js';
import { AppMark } from './app-mark.js';
import type { AgentsApi, OwnerOutcome } from './api.js';
import type { AgentRow } from './data.js';
import { gateMessage, OwnerButton } from './owner-gate.js';
import { AGENTS_STRINGS as S } from './strings.js';

/** The label rule the person sees: 1 to 32 characters, no control characters (06 §6). */
export const LABEL_MAX = 32;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** How long a removal in flight keeps its sheet against Esc, the backdrop and the close button. */
const BUSY_GRACE_MS = 10_000;
export function labelProblem(text: string): boolean {
  const t = text.trim();
  return t === '' || [...t].length > LABEL_MAX || CONTROL.test(t);
}

interface Shared {
  readonly api: AgentsApi;
  readonly owner: OwnerClient;
}

// ------------------------------------------------------------------------------------------ Rename

/** The time a rename is allowed again: today's time, or the date and time when further off. */
export function retryTime(retryAt: number, now: number = Date.now()): string {
  const at = new Date(retryAt * 1000);
  const soon = retryAt * 1000 - now < 20 * 3600 * 1000;
  return soon
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}

export function RenameEditor({
  row,
  api,
  owner,
  onDone,
  onCancel,
  onChanged,
  onRenamed,
  cardName,
}: Shared & {
  row: AgentRow;
  /**
   * WP-1 (R-5): the open ID's card name when it differs from its label: then the same label is a
   * change too (it puts the label in the card, D-141), so Save is not refused for it.
   */
  cardName?: string;
  onDone: () => void;
  onCancel: () => void;
  onChanged: () => void;
  /** W4-AGENTS (D-141): the new label, and whether contacts will be told. */
  onRenamed?: (label: string, told: boolean) => void;
}): ReactElement {
  const [text, setText] = useState(row.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // UX1113-N2: the label is checked while typing (`labelCheck`, debounced), never between the click
  // and the gesture, so "Rename with Touch ID" goes straight to the sensor.
  const [refusedLabel, setRefusedLabel] = useState<string | undefined>(undefined);
  const label = text.trim();
  const unchanged = label === row.label && (cardName === undefined || cardName === label);
  const problem = labelProblem(text);
  useEffect(() => {
    if (problem || unchanged) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      void api.labelCheck(label).then(
        (checked) => {
          if (live) setRefusedLabel(checked === 'refused' ? label : undefined);
        },
        () => undefined,
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, label, problem, unchanged]);

  const send = (proof: PresenceProof): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void api.rename({ name: row.name, label }, proof).then((outcome) => {
      setBusy(false);
      if (outcome.kind === 'done') {
        onRenamed?.(label, outcome.contacts !== undefined && outcome.contacts > 0);
        onChanged();
        onDone();
        return;
      }
      if (outcome.kind === 'agent_changed') onChanged();
      setError(renameProblem(outcome, row.label));
    });
  };

  return (
    <form className="ag-rename" onSubmit={(event) => event.preventDefault()}>
      <p className="al-text-body-sm al-muted">{S.renameHint}</p>
      <TextField
        label={S.renameField}
        name="agent-label"
        type="text"
        maxLength={LABEL_MAX}
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          setError(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="ag-actions">
        <OwnerButton
          owner={owner}
          statement={S.renameStatement(row.label, label)}
          withSensor={S.renameWith}
          withCode={S.renameWithCode}
          busy={busy}
          error={error}
          disabled={problem || unchanged || refusedLabel === label}
          onProof={send}
        />
        <Button variant="ghost" onClick={onCancel}>
          {S.cancel}
        </Button>
      </div>
      {refusedLabel === label && error === undefined ? (
        <InlineError>{S.labelInvalid}</InlineError>
      ) : null}
    </form>
  );
}

// ------------------------------------------------------------------------------------------ Remove

/** The AI apps that run the agent now (a live session); the row's apps when the read names none. */
function runningApps(row: AgentRow): QuitApps {
  const liveStates = (row.appStates ?? []).filter(
    (a) => a.state === 'working' || a.state === 'ready' || a.state === 'idle',
  );
  const live = liveStates.map((a) => a.name);
  return live.length > 0
    ? { apps: live, ids: liveStates.map((a) => a.id), named: true }
    : { apps: row.apps, ids: [], named: false };
}

interface QuitApps {
  readonly apps: readonly string[];
  /** App ids of the live apps (never shown); empty when the read named none. */
  readonly ids: readonly string[];
  readonly named: boolean;
}

/** F22: what is still running, in words: Terminal sessions (CLI) or a background desktop app. */
function quitSentence(quit: QuitApps, label: string): string {
  if (quit.named && quit.apps.length === 1) {
    const app = quit.apps[0] as string;
    if (quit.ids[0] === 'claude-code') return S.quitTerminal(app);
    if (quit.ids[0] === 'opencode') return S.quitBackground(app);
    return S.quitApp(app);
  }
  return S.quitAny(label);
}

type RemovePhase =
  | { readonly kind: 'form' }
  | { readonly kind: 'in_use' }
  | { readonly kind: 'anyway' }
  | { readonly kind: 'failed' };

export function RemoveSheet({
  row,
  api,
  owner,
  onClose,
  onChanged,
  onRemoved,
  onAgentChanged,
  onSwitch,
}: Shared & {
  row: AgentRow;
  onClose: () => void;
  onChanged: () => void;
  onRemoved: (label: string) => void;
  onAgentChanged: () => void;
  /** Opens another ID, since a recovery kit is saved for the open ID (WP-11). */
  onSwitch?: (row: AgentRow) => void;
}): ReactElement {
  const [exporting, setExporting] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [phase, setPhase] = useState<RemovePhase>({ kind: 'form' });
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const nameId = useId();
  // W8-S4 (04 §2.5 "Finishing a removal"): an ID whose removal stopped part-way is already retired
  // for good, so finishing asks for presence only, never the typed name again.
  const finishing = row.removing;
  // WIN-BROKEN-ID: an ID whose key is missing is set aside (moved, never retired): the typed name
  // and presence are asked as for every removal; there is nothing to export and nothing is sent.
  const broken = row.broken === true && !finishing;
  const matches = finishing || typed === row.label;
  const contacts = row.contacts ?? 0;
  // W5-SHEET-CLOSE: a removal in flight keeps the sheet for a moment, never for good: after 10 s
  // without an answer the owner can close it again.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!busy) {
      setStuck(false);
      return undefined;
    }
    const timer = setTimeout(() => setStuck(true), BUSY_GRACE_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  // W6-FLOW-FIXES: the AI apps the person must quit first (fresh read, else the row's apps).
  // `named`: the read names the running apps; the server's `in_use` alone does not.
  const [quit, setQuit] = useState<QuitApps>({
    apps: row.apps,
    ids: [],
    named: false,
  });
  const [checking, setChecking] = useState(false);
  // W6-FLOW-FIXES: an AI app that runs the agent holds its folder, so the removal would stop at
  // `in_use` after the Touch ID. The page reads the agents first and says "Quit {app} first" before
  // any gesture. This is a hint only: the server's folder lock still decides, and presence is
  // always asked before anything is signed (a failed read goes on to the Touch ID step).
  // UX1113-N2: the read happens before the one button can be pressed (once the name is typed, and
  // on "Check again"), so "Remove with Touch ID" goes straight to the sensor.
  // IR-UX1113-N2-1 #5: one read at a time, and none answered into a closed sheet.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reading = useRef(false);
  const checkNow = useCallback((): void => {
    if (reading.current) return;
    reading.current = true;
    setChecking(true);
    setError(undefined);
    void api
      .list()
      .catch(() => ({ kind: 'error' }) as const)
      .then((read) => {
        reading.current = false;
        if (!alive.current) return;
        setChecking(false);
        const fresh =
          read.kind === 'ok' ? read.list.agents.find((r) => r.name === row.name) : undefined;
        if (fresh?.running === true) {
          setQuit(runningApps(fresh));
          setPhase({ kind: 'in_use' });
          return;
        }
        setPhase({ kind: 'form' });
        setReady(true);
      });
  }, [api, row.name]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // The name matches: look once for an AI app that still runs it.
    if (!matches || ready || phase.kind !== 'form') return;
    checkNow();
  }, [matches, ready, phase.kind, checkNow]);
  useEffect(() => {
    if (!matches) setReady(false);
  }, [matches]);
  const checkThenAsk = (): void => {
    setReady(false);
    checkNow();
  };

  const send =
    (anyway: boolean) =>
    (proof: PresenceProof): void => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      void api
        .remove(
          {
            name: row.name,
            ...(finishing ? {} : { typedLabel: typed }),
            ...(anyway ? { anyway: true } : {}),
          },
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
          if (outcome.kind === 'in_use') {
            setQuit({ apps: row.apps, ids: [], named: false });
            return setPhase({ kind: 'in_use' });
          }
          if (outcome.kind === 'contacts_unreachable') return setPhase({ kind: 'anyway' });
          if (outcome.kind === 'agent_removing') {
            // The agent is retired and shows as "Removal not finished" with Try again.
            onChanged();
            onClose();
            return;
          }
          // Part-way or not available yet: the agent may now be marked "Removal not finished".
          onChanged();
          setPhase({ kind: 'failed' });
        });
    };

  const inProgress = busy && phase.kind === 'form';
  const title = inProgress
    ? S.removingTitle(row.label)
    : finishing
      ? S.finishTitle(row.label)
      : broken
        ? S.brokenRemoveTitle(row.label)
        : S.removeTitle(row.label);
  return (
    <Sheet
      open
      title={title}
      onClose={() => {
        if (!busy || stuck) onClose();
      }}
      closeLabel={S.close}
      className="ag-sheet"
    >
      <div className="ag-sheet-body">
        {phase.kind === 'form' && broken ? (
          <>
            <p className="al-text-body">{S.brokenRemoveIntro}</p>
            <p className="al-text-body">{S.brokenRemoveRestore}</p>
            <p className="al-text-caption al-muted">{S.agentFolder(row.name)}</p>
          </>
        ) : null}
        {phase.kind === 'form' && !broken ? (
          <>
            {finishing ? <p className="al-text-body">{S.removalReason}</p> : null}
            <p className="al-text-body">{S.removeIntro}</p>
            <ul className="ag-goes">
              <li>{S.keysAndSettings(row.label)}</li>
              <li>{S.history(row.contacts)}</li>
              {row.apps.map((app) => (
                <li key={app}>{S.itsEntry(app)}</li>
              ))}
            </ul>
            {contacts > 0 && !finishing ? (
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
            <div className="ag-actions" hidden={broken}>
              {exporting && row.current ? (
                <ExportKit label={row.label} />
              ) : (
                <>
                  <Button
                    variant="secondary"
                    icon="download"
                    onClick={() => {
                      if (row.current) setExporting(true);
                      else setAskOpen(true);
                    }}
                  >
                    {S.exportFirst}
                  </Button>
                  {askOpen && !row.current ? (
                    <div role="group" aria-label={S.openForKit(row.label)}>
                      <p className="al-text-body-sm">{S.openForKit(row.label)}</p>
                      <div className="ag-actions">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => {
                            setAskOpen(false);
                            setExporting(true);
                            onSwitch?.(row);
                          }}
                        >
                          {S.open}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setAskOpen(false)}>
                          {S.cancel}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
            {finishing ? null : (
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
            )}
            <div className="ag-actions">
              <OwnerButton
                owner={owner}
                statement={
                  finishing
                    ? S.finishStatement(row.label)
                    : broken
                      ? S.brokenRemoveStatement(row.label)
                      : S.removeStatement(row.label)
                }
                withSensor={finishing ? S.finishWith : S.removeWith}
                withCode={finishing ? S.finishWithCode : S.removeWithCode}
                busy={busy}
                error={error}
                variant="danger"
                disabled={!matches || checking || !ready}
                onProof={send(false)}
              />
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

        {phase.kind === 'in_use' ? (
          <>
            <p className="al-text-body" role="alert">
              <strong>{quitSentence(quit, row.label)}</strong>
            </p>
            {quit.apps.length > 0 && !(quit.named && quit.apps.length === 1) ? (
              <ul className="ag-goes">
                {quit.apps.map((app) => (
                  <li key={app}>
                    <AppMark name={app} />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="ag-actions">
              <Button variant="primary" disabled={checking} onClick={checkThenAsk}>
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
              <OwnerButton
                owner={owner}
                statement={S.removeStatement(row.label)}
                withSensor={S.removeAnywayWith}
                withCode={S.removeAnywayWithCode}
                busy={busy}
                error={error}
                variant="danger"
                onProof={send(true)}
              />
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

/** F23: a failed rename says why when the server sent a fixed reason; else the generic line. */
function renameFailedCopy(outcome: OwnerOutcome): string {
  const reason = outcome.kind === 'failed' ? outcome.reason : undefined;
  return reason === undefined ? S.renameFailed : FAILURE_COPY[reason];
}

/**
 * WP-1: what a rename that did not finish says, for the Rename editor and for "Update contacts"
 * alike. Each answer has its own words (the owner's 0.4.13 run got one generic sentence for all).
 */
export function renameProblem(outcome: OwnerOutcome, label: string): string {
  const said = gateMessage(outcome);
  if (said !== undefined) return said;
  switch (outcome.kind) {
    case 'agent_changed':
      return S.agentChanged;
    // D-141 (11 §5.8): three renames a day; the time of the next one.
    case 'rename_limited':
      return outcome.retryAt === undefined
        ? S.renameFailed
        : S.renameLimited(label, retryTime(outcome.retryAt));
    case 'rotation_pending':
      return S.renamePending;
    case 'label_invalid':
    case 'invalid':
      return S.labelInvalid;
    case 'not_available':
      return S.renameRestart;
    case 'not_applied':
      return S.notRenamed;
    default:
      return renameFailedCopy(outcome);
  }
}
