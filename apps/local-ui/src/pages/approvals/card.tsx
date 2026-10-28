// M1-11b-2: one approval card and its owner step, ported from the former server-rendered approval
// page's script (`cardBody`, `card`, `confirmStep`, `codeForm`; removed in M1-11b-2c) into the
// app (D-118). The same words, classes and rules:
//
// - The card leads with the plain headline, then the facts, the terms, and what the AI chose in its
//   own marked region. Every value is React text, never markup (I-5).
// - A request's own Approve or Deny opens the owner step: the passkey (asked only after this click,
//   11 §6.2.1), or the owner code below it. A request that costs credits (`paid`) approves only
//   through the confirmation sheet (04 §2.5.3 rule 7); its Deny is the plain owner step.
// - The owner code field keeps any length, is never autocompleted, is hidden until shown, and is
//   cleared on submit. Neither the code nor any server value is logged.
//
// UI-REFRESH-o (visual only; B-11 §16, §6 rows 4 and 7, §7): the card sits on level 1 and rises to
// level 2 while it is being decided; a ring meter shows the time left, from `expiresAt` only; an
// applied approval draws the check (SuccessMoment), an applied denial fades the decided card; Under
// the hood shows the kind and the exact expiry. Nothing the agent wrote reaches the ring, the moment
// or the panel, and every fact stays on the card before, during and after the decision (WYSIWYS).
//
// UI-REFRESH-o-b (state handling only; B-11 §16, §6 row 4, §7): Under the hood also shows the
// approval ID, through the shared panel's `id` kind. After an applied approval the card holds
// "Approved." and every fact while the check draws, then collapses out with the shared row leave
// (reduced motion: removed at once); the page keeps the result as a line of text. An open
// confirmation sheet, a refused attempt and a denial keep the card. Presence, signing and the
// decide calls are untouched.
import {
  Button,
  RingMeter,
  SuccessMoment,
  Surface,
  useRowPresence,
  useVisibilityPause,
} from '@4thtech-io/ui';
import { UnderTheHood } from '../../lazy/hood.js';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { PayConfirm, type PayConfirmClient } from '../../pay-confirm/index.js';
import type { PayPlatform } from '@4thtech-io/ui';
import type {
  ApprovalItem,
  ApprovalsClient,
  DecideAnswer,
  Decision,
  DecisionPasskey,
} from './client.js';
import { APPROVAL_ID } from './client.js';
import { EARLIER_OWNER_CODE_HINT } from '../../strings.js';
import { APPROVAL_STRINGS as S, fmt } from './strings.js';

/** The owner as the page knows it: set up or not, and the decision passkey when registered. */
export interface OwnerState {
  readonly ready: boolean;
  readonly passkey?: DecisionPasskey;
}

/** What the paid-action sheet needs from the page (test seams included). */
export interface SheetOptions {
  readonly payConfirm?: PayConfirmClient;
  readonly platform?: PayPlatform;
  readonly reducedMotion?: boolean;
}

const RESULT: Readonly<Record<string, string>> = {
  applied_approve: S.approved,
  applied_deny: S.denied,
  presence_required: S.presenceRequired,
  presence_rejected: S.presenceRejected,
  not_pending: S.notPending,
  changed: S.changed,
  busy: S.busy,
  refused: S.refused,
  needs_setup: S.needsSetup,
  confirm_required: S.confirmRequired,
};

/** The statuses after which the owner may try again (the buttons come back). */
const RETRY = new Set(['presence_rejected', 'presence_required', 'busy', 'wait']);

export function waitText(retryAfter: number | undefined): string {
  const seconds = typeof retryAfter === 'number' && retryAfter > 0 ? Math.ceil(retryAfter) : 1;
  return fmt(S.wait, { seconds });
}

/** One decision's answer in the page's words. */
export function decisionText(answer: DecideAnswer): string {
  if (answer.kind === 'offline') return S.notRunning;
  if (answer.kind === 'dismissed') return S.notUsed;
  if (answer.status === 'wait') return waitText(answer.retryAfter);
  const key = answer.status === 'applied' ? `applied_${answer.decision ?? ''}` : answer.status;
  return RESULT[key] ?? S.refused;
}

/**
 * The server's approval lifetime in seconds (packages/types APPROVAL_TTL_SECONDS; a test keeps them
 * in step): the full ring. A request never has more time than this.
 */
export const APPROVAL_TTL = 86_400;

/** The time left in plain words; the server's expiry stays the one that counts. */
export function timeLeftText(seconds: number): string {
  if (seconds <= 0) return S.expired;
  if (seconds < 60) return S.underMinute;
  if (seconds < 3600) return fmt(S.minutesLeft, { minutes: Math.ceil(seconds / 60) });
  return fmt(S.hoursLeft, { hours: Math.round(seconds / 3600) });
}

/** Seconds now, read again once a minute while the tab is visible. */
function useNowSeconds(): number {
  const hidden = useVisibilityPause();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (hidden) return undefined;
    setNow(Math.floor(Date.now() / 1000));
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(timer);
  }, [hidden]);
  return now;
}

/** A ring meter for the time left (B-11 §16): the expiry number only, never the agent's words. */
export function TimeLeft({ expiresAt }: { expiresAt: number }): ReactElement {
  const now = useNowSeconds();
  const left = Math.max(0, Math.min(APPROVAL_TTL, Math.floor(expiresAt - now)));
  return (
    <RingMeter
      label={S.timeLeft}
      value={left}
      max={APPROVAL_TTL}
      text={timeLeftText(left)}
      countdown
      size="sm"
    />
  );
}

/**
 * Under the hood for one request: its approval ID, kind and exact expiry (B-11 §16). The ID goes
 * through the shared panel's `id` kind, so the panel's allowlist has the last word; only a
 * well-formed `apr_` ID is offered.
 */
export function approvalHoodFields(item: ApprovalItem): readonly unknown[] {
  const fields: unknown[] = [];
  if (APPROVAL_ID.test(item.approvalId)) {
    fields.push({ kind: 'id', label: S.hoodId, value: item.approvalId });
  }
  fields.push({
    kind: 'text',
    label: S.hoodKind,
    value: item.commitment ? S.kindTerms : item.paid ? S.kindPaid : S.kindRequest,
  });
  const at = new Date(item.expiresAt * 1000);
  if (Number.isFinite(at.getTime())) {
    fields.push({ kind: 'time', label: S.hoodExpiry, value: at.toISOString() });
  }
  return fields;
}

/**
 * How long an approved card stays, with "Approved." and every fact, before it collapses out: the
 * check has drawn and the line can be read (B-11 §6 rows 4 and 7).
 */
export const APPROVED_HOLD_MS = 1600;

/**
 * The approved moment, with the shared component's own word ("Approved"). The status line ("Approved.")
 * stays the one announced and the one the browser tests find, so the moment is not read out.
 */
export function ApprovedMoment(): ReactElement {
  return (
    <span className="ap-moment" aria-hidden="true">
      <SuccessMoment kind="approved" />
    </span>
  );
}

/** Status lines, each its own polite live region (as the page's `say`). */
export function Statuses({ lines }: { lines: readonly string[] }): ReactElement | null {
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line, i) => (
        <p key={i} className="al-status" role="status">
          {line}
        </p>
      ))}
    </>
  );
}

/** The card's content: headline, facts, terms, then what the AI chose (marked as theirs). */
export function ApprovalFacts({ item }: { item: ApprovalItem }): ReactElement {
  const d = item.details;
  return (
    <>
      <div className="al-approval-top">
        <p className="al-approval-type">{S.cardTitle}</p>
        <TimeLeft expiresAt={item.expiresAt} />
      </div>
      {d === undefined ? (
        <h2>{item.summary}</h2>
      ) : (
        <>
          <h2>{d.headline ?? d.what}</h2>
          <dl className="al-approval-rows">
            {(
              [
                [S.who, d.who],
                [S.what, d.what],
                [S.cost, d.cost],
                [S.expires, d.expires],
                [S.why, d.rule],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="al-arow">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {d.terms !== undefined && d.terms.length > 0 ? (
            <div className="al-terms">
              {d.terms.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          ) : null}
          {d.fromAi.length > 0 ? (
            <figure className="al-untrusted" role="group" aria-label={S.fromAi}>
              <figcaption className="al-untrusted-label">{S.fromAi}</figcaption>
              <dl className="al-untrusted-body">
                {d.fromAi.map((f, i) => (
                  <div key={i}>
                    <dt>{f.name}</dt>
                    <dd>
                      <pre>{f.value}</pre>
                    </dd>
                  </div>
                ))}
              </dl>
            </figure>
          ) : null}
        </>
      )}
    </>
  );
}

/** The footer every approval carries (11 §6.2.1 security copy). */
export function ApprovalFoot(): ReactElement {
  return <p className="al-approval-foot">{S.cannotApprove}</p>;
}

/**
 * The owner code field (D1 TextField, mono): full width, any length (no maxlength), paste and
 * password managers welcome, never autocompleted or corrected, hidden until the owner shows it.
 * The value lives only in the input and is cleared on submit.
 */
export function CodeForm({
  label,
  submit,
  onCode,
}: {
  label: string;
  submit: string;
  onCode: (code: string) => Promise<unknown>;
}): ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;
  const input = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const field = input.current;
    if (field === null || busy) return;
    const code = field.value;
    field.value = '';
    setShown(false);
    setBusy(true);
    void onCode(code).finally(() => setBusy(false));
  };
  return (
    <form className="al-field al-code" onSubmit={onSubmit}>
      <label className="al-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="al-input-wrap">
        <input
          ref={input}
          id={id}
          className="al-input al-mono"
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-describedby={`${hintId} ${hintId}-earlier`}
        />
        <button
          type="button"
          className="al-btn al-btn-ghost al-btn-sm al-toggle"
          aria-pressed={shown}
          aria-controls={id}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? S.hide : S.show}
        </button>
      </div>
      <p id={hintId} className="al-field-hint">
        {S.codeHint}
      </p>
      <p id={`${hintId}-earlier`} className="al-field-hint">
        {EARLIER_OWNER_CODE_HINT}
      </p>
      <Button type="submit" variant="primary" size="lg" block disabled={busy}>
        {submit}
      </Button>
    </form>
  );
}

/**
 * The presence step: the passkey first when there is one, the owner code below it. `send` runs once
 * per attempt; it resolves when the answer is shown.
 */
export function OwnerStep({
  passkey,
  passkeyLabel,
  codeSubmit,
  label,
  onPasskey,
  onCode,
  children,
}: {
  passkey: boolean;
  passkeyLabel: string;
  codeSubmit: string;
  label: string;
  onPasskey: () => Promise<unknown>;
  onCode: (code: string) => Promise<unknown>;
  children?: ReactElement | null;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    // The clicked button is gone: focus moves to the step itself, never to a default button.
    box.current?.focus();
  }, []);
  return (
    <div ref={box} className="al-step" role="group" aria-label={label} tabIndex={-1}>
      {children}
      {passkey ? (
        <>
          <Button
            variant="primary"
            size="lg"
            block
            disabled={waiting}
            onClick={() => {
              setWaiting(true);
              void onPasskey().finally(() => setWaiting(false));
            }}
          >
            {passkeyLabel}
          </Button>
          <p className="al-or">{S.orCode}</p>
        </>
      ) : null}
      <CodeForm label={S.codeLabel} submit={codeSubmit} onCode={onCode} />
    </div>
  );
}

/** One request with its own Approve and Deny (a commitment, a paid request, or `/approve/<id>`). */
export function SingleApproval({
  item,
  owner,
  client,
  sheet,
  onDecided,
  onLeft,
}: {
  item: ApprovalItem;
  owner: OwnerState;
  client: ApprovalsClient;
  sheet: SheetOptions;
  /** An applied decision (approve or deny); never called for a refused or failed attempt. */
  onDecided?: () => void;
  /** The approved card has collapsed out; the page keeps this line in its place. */
  onLeft?: (line: string) => void;
}): ReactElement | null {
  const [step, setStep] = useState<Decision | undefined>(undefined);
  const [actions, setActions] = useState(true);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [paying, setPaying] = useState(false);
  const [outcome, setOutcome] = useState<'approved' | 'denied' | undefined>(undefined);
  const say = (text: string): void => setLines((l) => [...l, text]);

  // UI-REFRESH-o-b: an approved card leaves once the sheet (if any) is closed and the hold is over.
  const [present, setPresent] = useState(true);
  const leaving = outcome === 'approved' && !paying;
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = setTimeout(() => setPresent(false), APPROVED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  const row = useRowPresence<HTMLDivElement>(present, {
    onGone: () => onLeft?.(fmt(S.approvedLine, { summary: item.summary })),
  });

  const answer = (a: DecideAnswer): void => {
    if (a.kind === 'dismissed') {
      say(S.notUsed);
      return;
    }
    setStep(undefined);
    if (a.kind === 'status' && a.status === 'applied') {
      if (a.decision === 'approve') setOutcome('approved');
      else if (a.decision === 'deny') setOutcome('denied');
      onDecided?.();
    }
    say(decisionText(a));
    if (a.kind === 'status' && RETRY.has(a.status)) setActions(true);
  };

  const open = (decision: Decision): void => {
    // M1-PAY-CONFIRM-b: approving a request that costs credits is the confirmation sheet's.
    if (item.paid && decision === 'approve') {
      setPaying(true);
      return;
    }
    setActions(false);
    setStep(decision);
  };

  if (!row.mounted) return null;
  return (
    <div ref={row.ref} className="ap-leave">
      <Surface
        as="section"
        level={step !== undefined || paying ? 2 : 1}
        className="al-approval"
        {...(APPROVAL_ID.test(item.approvalId) ? { 'data-approval': item.approvalId } : {})}
        {...(outcome === undefined ? {} : { 'data-outcome': outcome })}
      >
        <ApprovalFacts item={item} />
        {item.commitment ? <p className="al-note">{S.termsAlone}</p> : null}
        {item.paid ? <p className="al-note">{S.paidAlone}</p> : null}
        <div className="al-slot">
          {owner.ready && actions ? (
            // Deny first, Approve as the wider primary (D1); neither is a default button (11 §8).
            <div className="al-approval-actions">
              <Button size="lg" onClick={() => open('deny')}>
                {S.deny}
              </Button>
              <Button variant="primary" size="lg" onClick={() => open('approve')}>
                {S.approve}
              </Button>
            </div>
          ) : null}
          {outcome === 'approved' ? <ApprovedMoment /> : null}
          <Statuses lines={lines} />
          {step === undefined ? null : (
            <OwnerStep
              passkey={owner.passkey !== undefined}
              passkeyLabel={step === 'approve' ? S.approveWithPasskey : S.denyWithPasskey}
              codeSubmit={step === 'approve' ? S.confirmApproval : S.confirmDenial}
              label={step === 'approve' ? S.confirmApproval : S.confirmDenial}
              onPasskey={async () => {
                if (owner.passkey === undefined) return;
                answer(
                  await client.decide(item, step, { kind: 'passkey', passkey: owner.passkey }),
                );
              }}
              onCode={async (code) =>
                answer(await client.decide(item, step, { kind: 'code', code }))
              }
            />
          )}
        </div>
        <ApprovalFoot />
        <UnderTheHood fields={approvalHoodFields(item)} />
        {paying ? (
          <PayConfirm
            {...(sheet.payConfirm === undefined ? {} : { client: sheet.payConfirm })}
            {...(sheet.platform === undefined ? {} : { platform: sheet.platform })}
            {...(sheet.reducedMotion === undefined ? {} : { reducedMotion: sheet.reducedMotion })}
            input={{ flow: 'proof', approvalId: item.approvalId }}
            onDone={() => {
              setActions(false);
              setOutcome('approved');
              say(S.approved);
              onDecided?.();
            }}
            onClose={() => setPaying(false)}
          />
        ) : null}
      </Surface>
    </div>
  );
}
