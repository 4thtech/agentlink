// RET-4 (D-148; 04 §4.2 "Presence and undo"; 08 §1 "The delete sheet"; 11 §5): the delete sheet.
//
// 1. It asks the server what the delete would remove (begin): counts and sizes only. The server keeps
//    the exact list; the page never names it again.
// 2. The fixed lines are always shown ("Only on this computer…", "Proofs stay valid…"), with what is
//    always kept (pairing, agreed terms, approvals, receipts) and how many were kept this time.
// 3. One danger button is the sensor ("Delete with Touch ID"; the master code as a link). The press
//    sends only the nonce to finish; the server verifies presence and schedules exactly its list.
// 4. A 10-second "Undo" toast; Undo cancels and nothing is deleted. When the window ends, the page
//    reads the outcome and says it ("Moved 2 files to the Trash.", or the Windows note).
// Another party's name is text only (I-5). Nothing here logs.
import { Button, InlineError } from '@4thtech-io/ui';
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { notify } from '../../notices/index.js';
import { createOwnerClient, type OwnerResult, type PresenceProof } from '../contacts/owner.js';
import { PresenceButton } from '../contacts/presence-button.js';
import { CONTACTS_STRINGS as C, waitSeconds } from '../contacts/strings.js';
import {
  createHistoryApi,
  type DeleteResult,
  type DeleteTarget,
  type HistoryApi,
  type Include,
  type Planned,
} from './api.js';
import { HISTORY_STRINGS as S } from './strings.js';
import './history.css';

export interface DeleteSheetProps {
  /** The person's name as the name rule shows it (text only); absent for Free up space. */
  readonly name?: string | undefined;
  readonly target: DeleteTarget;
  /** The person view: choose what to delete and an age. */
  readonly choose?: boolean;
  /** Free up space: plan exactly this (no switch). */
  readonly include?: Include;
  readonly fetch?: typeof fetch;
  readonly token?: string;
  readonly onClose: () => void;
  /** The delete is scheduled (the Undo window started). */
  readonly onScheduled?: () => void;
  /** The delete was applied (the window ended): read the page again. */
  readonly onApplied?: () => void;
  /** Tests: how long after the window the outcome is read, and between reads. */
  readonly waitMs?: number;
}

type Plan =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly plan: Planned };

const MESSAGE: Readonly<Partial<Record<OwnerResult['kind'], string>>> = {
  rejected: C.presenceRejected,
  required: C.presenceRequired,
  busy: C.busy,
  session: C.sessionExpired,
  failed: C.failed,
};

const AGES: readonly (readonly [number | undefined, string])[] = [
  [undefined, S.anyAge],
  [30, S.days30],
  [90, S.days90],
  [365, S.days365],
];

/** Says what happened once the Undo window ended (the sheet may be gone by then). */
function followUp(
  api: HistoryApi,
  nonce: string,
  firstMs: number,
  everyMs: number,
  undone: () => boolean,
  onApplied: (() => void) | undefined,
): void {
  let tries = 0;
  const read = (): void => {
    if (undone()) return;
    tries += 1;
    void api.status(nonce).then((answer) => {
      if (undone()) return;
      if (answer.status === 'done') {
        for (const line of outcomeLines(answer.result)) notify({ text: line, tone: 'success' });
        onApplied?.();
        return;
      }
      if (answer.status === 'changed') {
        notify({ text: S.changed, tone: 'warning' });
        return;
      }
      if (answer.status === 'cancelled') return;
      const waiting =
        answer.status === 'scheduled' ||
        answer.status === 'applying' ||
        answer.status === 'offline';
      if (waiting && tries < 8) {
        setTimeout(read, everyMs);
        return;
      }
      notify({ text: S.notDone, tone: 'warning' });
    });
  };
  setTimeout(read, firstMs);
}

/** The lines after a delete: files moved, the Windows note, files left alone. */
export function outcomeLines(result: DeleteResult): string[] {
  const lines: string[] = [];
  const f = result.files;
  if (f.trashed > 0) lines.push(S.moved(f.trashed));
  if (f.noTrash > 0) lines.push(S.noTrash(f.noTrash));
  const left = f.changed + f.missing + f.refused + f.failed;
  if (left > 0) lines.push(S.leftAlone(left));
  if (result.messages.notarized > 0) lines.push(S.notarizedNote);
  return lines;
}

export function DeleteSheet({
  name,
  target,
  choose = false,
  include: fixedInclude,
  fetch: givenFetch,
  token,
  onClose,
  onScheduled,
  onApplied,
  waitMs,
}: DeleteSheetProps): ReactElement {
  const api = useMemo(
    () =>
      createHistoryApi({
        ...(givenFetch === undefined ? {} : { fetch: givenFetch }),
        ...(token === undefined ? {} : { token }),
      }),
    [givenFetch, token],
  );
  const owner = useMemo(
    () =>
      createOwnerClient({
        ...(givenFetch === undefined ? {} : { fetch: givenFetch }),
        ...(token === undefined ? {} : { token }),
      }),
    [givenFetch, token],
  );
  const titleId = useId();
  const whatId = useId();
  const ageId = useId();
  const switchId = useId();
  const [include, setInclude] = useState<Include>(fixedInclude ?? 'both');
  const [age, setAge] = useState<number | undefined>(target.olderThanDays);
  const [plan, setPlan] = useState<Plan>({ kind: 'loading' });
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const selected = target.envelopeIds;
  const planTarget: DeleteTarget =
    selected !== undefined
      ? { envelopeIds: selected }
      : {
          ...(target.contact === undefined ? {} : { contact: target.contact }),
          ...(age === undefined ? {} : { olderThanDays: age }),
        };
  const key = JSON.stringify([planTarget, include, version]);

  useEffect(() => {
    let current = true;
    setPlan({ kind: 'loading' });
    void api.begin(planTarget, include).then((answer) => {
      if (!current) return;
      setPlan(typeof answer === 'string' ? { kind: 'failed' } : { kind: 'ready', plan: answer });
    });
    return () => {
      current = false;
    };
    // `key` covers the target, what to remove and a fresh read.
  }, [api, key]);

  const press = (proof: PresenceProof): void => {
    if (plan.kind !== 'ready') return;
    const planned = plan.plan;
    setBusy(true);
    setError(undefined);
    void api.finish(owner, planned.nonce, proof).then((result) => {
      if (!live.current) return;
      setBusy(false);
      if (result.kind === 'done') {
        let undone = false;
        const messages = include === 'files' ? 0 : planned.messages.count;
        notify({
          text: S.deleted(messages, include === 'messages' ? 0 : planned.files.count),
          action: S.undo,
          onAction: () => {
            undone = true;
            void api.undo(planned.nonce).then((answer) => {
              if (answer === 'cancelled') notify({ text: S.nothingDeleted, tone: 'success' });
              else if (answer === 'too_late') notify({ text: S.tooLate });
              else notify({ text: C.failed, tone: 'warning' });
            });
          },
        });
        const first = waitMs ?? planned.undoSeconds * 1000 + 800;
        followUp(api, planned.nonce, first, waitMs ?? 1000, () => undone, onApplied);
        onScheduled?.();
        onClose();
        return;
      }
      if (result.kind === 'wait') {
        setError(waitSeconds(result.seconds));
        return;
      }
      if (result.kind === 'rejected' || result.kind === 'required') {
        setError(proof.kind === 'code' ? MESSAGE[result.kind] : C.passkeyNotUsed);
        return;
      }
      if (result.kind === 'not_applied' || result.kind === 'refused') {
        // The list changed since it was shown (or expired): say so and read it again.
        setError(S.changed);
        setVersion((v) => v + 1);
        return;
      }
      setError(MESSAGE[result.kind] ?? C.failed);
    });
  };

  const title =
    selected !== undefined
      ? S.titleSelected(selected.length)
      : name !== undefined
        ? S.titlePerson(name)
        : S.titleFree;
  const ready = plan.kind === 'ready' ? plan.plan : undefined;
  const empty =
    ready !== undefined &&
    (include === 'files' ? 0 : ready.messages.count) === 0 &&
    (include === 'messages' ? 0 : ready.files.count) === 0;

  return (
    <div role="alertdialog" aria-labelledby={titleId} className="hs-sheet al-reveal">
      <h3 id={titleId} className="al-text-h3">
        {title}
      </h3>
      {choose && selected === undefined ? (
        <div className="hs-choices">
          <label htmlFor={whatId} className="hs-field al-text-body-sm">
            <span>{S.what}</span>
            <select
              id={whatId}
              className="al-input"
              value={include}
              onChange={(e) => setInclude(e.target.value as Include)}
            >
              <option value="both">{S.whatBoth}</option>
              <option value="messages">{S.whatMessages}</option>
              <option value="files">{S.whatFiles}</option>
            </select>
          </label>
          <label htmlFor={ageId} className="hs-field al-text-body-sm">
            <span>{S.olderThan}</span>
            <select
              id={ageId}
              className="al-input"
              value={age === undefined ? '' : String(age)}
              onChange={(e) => setAge(e.target.value === '' ? undefined : Number(e.target.value))}
            >
              {AGES.map(([days, words]) => (
                <option key={words} value={days === undefined ? '' : String(days)}>
                  {words}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {plan.kind === 'loading' ? (
        <p className="al-text-body-sm al-muted" aria-busy="true">
          {S.planning}
        </p>
      ) : plan.kind === 'failed' ? (
        <InlineError
          action={
            <Button variant="ghost" size="sm" onClick={() => setVersion((v) => v + 1)}>
              {S.retry}
            </Button>
          }
        >
          {S.planFailed}
        </InlineError>
      ) : (
        <p className="al-text-body hs-counts">
          {empty
            ? S.nothing
            : fixedInclude !== undefined
              ? S.removes(
                  include === 'files' ? 0 : plan.plan.messages.count,
                  include === 'messages' ? 0 : plan.plan.files.count,
                  (include === 'files' ? 0 : plan.plan.messages.bytes) +
                    (include === 'messages' ? 0 : plan.plan.files.bytes),
                )
              : S.counts(
                  include === 'files' ? undefined : plan.plan.messages.count,
                  include === 'messages' ? undefined : plan.plan.files.count,
                  (include === 'files' ? 0 : plan.plan.messages.bytes) +
                    (include === 'messages' ? 0 : plan.plan.files.bytes),
                )}
        </p>
      )}
      <p className="al-text-body-sm">{S.onlyHere(name)}</p>
      <p className="al-text-body-sm al-muted">{S.proofsStay}</p>
      {ready !== undefined && ready.kept > 0 ? (
        <p className="al-text-body-sm">{S.kept(ready.kept)}</p>
      ) : null}
      <p className="al-text-body-sm al-muted">{S.keptWhat}</p>
      {ready?.truncated === true ? <p className="al-text-body-sm">{S.more}</p> : null}
      {!choose && fixedInclude === undefined ? (
        <label htmlFor={switchId} className="hs-switch al-text-body-sm">
          <input
            id={switchId}
            type="checkbox"
            checked={include === 'both'}
            onChange={(e) => setInclude(e.target.checked ? 'both' : 'messages')}
          />
          <span>
            <span>{S.alsoFiles}</span>
            <span className="al-muted hs-help">{S.alsoFilesHelp}</span>
          </span>
        </label>
      ) : null}
      <div className="hs-actions">
        {ready !== undefined && !empty ? (
          <PresenceButton
            withSensor={S.deleteWith}
            withCode={S.deleteWithCode}
            statement={S.statement}
            busy={busy}
            error={error}
            notUsed={C.passkeyNotUsed}
            variant="danger"
            onProof={press}
            owner={owner}
          />
        ) : error === undefined ? null : (
          <InlineError>{error}</InlineError>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          {S.cancel}
        </Button>
      </div>
    </div>
  );
}
