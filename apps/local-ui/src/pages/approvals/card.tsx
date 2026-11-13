// M1-11b-2: one approval card and its owner step, ported from the former server-rendered approval
// page's script (`cardBody`, `card`, `confirmStep`, `codeForm`; removed in M1-11b-2c) into the
// app (D-118). The same words, classes and rules:
//
// - The card leads with the plain headline, then the facts, the terms, and what the AI chose in its
//   own marked region. Every value is React text, never markup (I-5).
// - A request's own Approve or Deny opens the owner step: the passkey (asked only after this click,
//   11 §6.2.1), or the master code below it. A request that costs credits (`paid`) approves only
//   through the confirmation sheet (04 §2.5.3 rule 7); its Deny is the plain owner step.
// - The master code field keeps any length, is never autocompleted, is hidden until shown, and is
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
// confirmation sheet and a refused attempt keep the card. Presence, signing and the decide calls are
// untouched.
//
// UI-REFRESH-o-c (state handling only; B-11 §16, §6 row 4): an applied denial leaves the same way.
// The card holds "Denied." and every fact (faded, as before), then collapses out (reduced motion:
// removed at once) and the page keeps "Denied: <summary>". A refused, expired or failed attempt and
// an open sheet keep the card. The line is built from the core's summary only, as React text (I-5).
import {
  Button,
  RingMeter,
  SuccessMoment,
  Surface,
  useHood,
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
  Presence,
} from './client.js';
import { usePresenceMode, type PresenceMode } from '../contacts/presence-button.js';
import { APPROVAL_ID } from './client.js';
import { EARLIER_OWNER_CODE_HINT } from '../../strings.js';
import { normaliseBackupCode, UseCodeInstead } from '../first-run/backup-code.js';
import { APPROVAL_STRINGS as S, fmt } from './strings.js';
import { isPlumbing, TermsDetails, TermsSummary } from './terms-view.js';

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
 * How long a decided card stays, with "Approved." or "Denied." and every fact, before it collapses
 * out: the check has drawn (or the denial has faded) and the line can be read (B-11 §6 rows 4, 7).
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

/** The cost the server shows for an approval that costs nothing. */
const FREE = 'Free';

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
  const hood = useHood();
  const fromAi =
    d === undefined
      ? []
      : hood
        ? d.fromAi
        : d.terms === undefined
          ? d.fromAi
          : d.fromAi.filter((f) => !isPlumbing(f));
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
            <TermsDetails lines={d.terms} showAdvanced={hood} />
          ) : null}
          {/* Ids, hashes and flags are plumbing: Under the hood only (11 §5). */}
          {fromAi.length > 0 ? (
            <figure className="al-untrusted" role="group" aria-label={S.fromAi}>
              <figcaption className="al-untrusted-label">{S.fromAi}</figcaption>
              <dl className="al-untrusted-body">
                {fromAi.map((f, i) => (
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

/**
 * W4-INBOX: the compact card's head (d2 `negotiation-thread--waiting-for-approval`): the kind and
 * the time left, the headline, and one line with who, what and the cost. The server's display
 * strings only, as plain text; the AI's arguments stay in Details, in the untrusted container.
 */
export function CompactHead({ item }: { item: ApprovalItem }): ReactElement {
  const d = item.details;
  return (
    <>
      <div className="al-approval-top">
        <p className="al-approval-type">{S.cardTitle}</p>
        <TimeLeft expiresAt={item.expiresAt} />
      </div>
      {/* N3: one line, never a heading or a link: the core's fixed-template line and the cost. */}
      <p className="al-approval-line al-approval-what">
        {d === undefined ? item.summary : (d.headline ?? d.what)}
        {/* IR-N3-1 #4: a headline names who; without one, the core's who (or "a contact"). */}
        {d === undefined || d.headline !== undefined
          ? null
          : ` · ${d.who.trim() === '' ? S.aContact : d.who}`}
        {d === undefined ? null : <span className="al-muted">{` · ${d.cost}`}</span>}
      </p>
      {d?.terms !== undefined && d.terms.length > 0 ? <TermsSummary lines={d.terms} /> : null}
    </>
  );
}

/** The footer every approval carries (11 §6.2.1 security copy). */
export function ApprovalFoot(): ReactElement {
  return <p className="al-approval-foot">{S.cannotApprove}</p>;
}

/**
 * The master code field (D1 TextField, mono): full width, any length (no maxlength), paste and
 * password managers welcome, never autocompleted or corrected, hidden until the owner shows it.
 * The value lives only in the input and is cleared on submit.
 */
export function CodeForm({
  label,
  submit,
  onCode,
  primary = true,
}: {
  label: string;
  submit: string;
  onCode: (code: string) => Promise<unknown>;
  /** F30/F31: one orange button per screen; false when the passkey button above is the primary. */
  primary?: boolean;
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
    // F49: pasted invisible separators removed (a code's shape only; a passphrase is sent as typed).
    const code = normaliseBackupCode(field.value);
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
      <Button
        type="submit"
        {...(primary ? { variant: 'primary' as const } : {})}
        size="lg"
        block
        disabled={busy}
      >
        {submit}
      </Button>
    </form>
  );
}

/**
 * OWNERSTEP-LEFT: the master code step. The one-step buttons (Approve with Touch ID, the bulk
 * approve, Save with Touch ID) send their proof at once; only the master code needs this field,
 * opened by the action itself when no sensor works here, or by "Use your master code instead".
 * `children` says what the code confirms. `onCode` runs once per attempt.
 */
export function CodeStep({
  codeSubmit,
  label,
  onCode,
  onCancel,
  children,
}: {
  codeSubmit: string;
  label: string;
  onCode: (code: string) => Promise<unknown>;
  onCancel?: () => void;
  children?: ReactElement | null;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The clicked button is gone: focus moves to the step itself, never to a default button.
    box.current?.focus();
  }, []);
  return (
    <div ref={box} className="al-step" role="group" aria-label={label} tabIndex={-1}>
      {children}
      <CodeForm label={S.codeLabel} submit={codeSubmit} onCode={onCode} />
      {onCancel === undefined ? null : (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {S.cancel}
        </Button>
      )}
    </div>
  );
}

/** The decision presence a one-step button sends, or undefined when only the code works. */
export function sensorPresence(mode: PresenceMode): Presence | undefined {
  if (mode.kind === 'native') return { kind: 'native' };
  if (mode.kind === 'passkey') return { kind: 'passkey', passkey: mode.info };
  return undefined;
}

/** The reading of what confirms here, for a page that already knows the decision passkey. */
export function useApprovalPresence(
  owner: OwnerState,
  readPasskey?: () => Promise<DecisionPasskey | undefined>,
): {
  readonly mode: PresenceMode;
  readonly sensor: string;
} {
  const known = owner.passkey;
  return usePresenceMode({
    readPasskey: readPasskey ?? (() => Promise.resolve(known)),
    watch: known?.credentialId ?? '',
  });
}

/**
 * The words for a sensor proof the server did not take: refused (IR-UX1113-N2-1 #2: it was used, not
 * "wasn't used"), or not available here (IR-N3-1 #5: no Touch ID here now), else undefined.
 */
export function sensorAnswer(status: string): string | undefined {
  if (status === 'presence_rejected') return S.sensorRefused;
  if (status === 'presence_required') return S.sensorUnavailable;
  return undefined;
}

/**
 * OWNERSTEP-LEFT: one owner action as one step: the button is the sensor ("Approve 2 with Touch
 * ID", "Confirm with Touch ID"), with "Use your master code instead" as a link; without a sensor here
 * the button opens the master code. `statement` (what the gesture confirms) is the button's
 * description. `send` runs once per press; a second press while one is in flight is ignored.
 */
export function PresenceAction({
  owner,
  readPasskey,
  withSensor,
  withCode,
  codeSubmit,
  statement,
  send,
  disabled = false,
  size = 'lg',
  icon,
  codeInline = false,
}: {
  owner: OwnerState;
  /** Reads the passkey when the page does not know it yet (the Inbox Save). */
  readPasskey?: () => Promise<DecisionPasskey | undefined>;
  withSensor: (sensor: string) => string;
  withCode: string;
  codeSubmit: string;
  statement: string;
  /** Sends one request with this presence; resolves when its answer is shown. */
  send: (presence: Presence) => Promise<unknown>;
  disabled?: boolean;
  size?: 'sm' | 'lg';
  icon?: 'inbox';
  /** Inside a step that already says what is confirmed: with only the code here, show its field. */
  codeInline?: boolean;
}): ReactElement {
  const { mode, sensor } = useApprovalPresence(owner, readPasskey);
  const [asking, setAsking] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const flight = useRef(false);
  const describedBy = useId();
  const proof = sensorPresence(mode);
  const held = disabled || asking || mode.kind === 'reading';
  const run = (presence: Presence): void => {
    if (flight.current) return;
    flight.current = true;
    setAsking(true);
    void send(presence).finally(() => {
      flight.current = false;
      setAsking(false);
    });
  };
  if (codeInline && mode.kind === 'code') {
    return (
      <CodeStep
        codeSubmit={codeSubmit}
        label={statement}
        onCode={(code) => send({ kind: 'code', code })}
      />
    );
  }
  if (codeOpen) {
    return (
      <CodeStep
        codeSubmit={codeSubmit}
        label={statement}
        onCode={async (code) => {
          await send({ kind: 'code', code });
          setCodeOpen(false);
        }}
        onCancel={() => setCodeOpen(false)}
      >
        <p className="al-text-body-sm">{statement}</p>
      </CodeStep>
    );
  }
  return (
    <div className="al-presence-action">
      <span id={describedBy} className="al-sr-only">
        {statement}
      </span>
      <Button
        variant="primary"
        size={size}
        {...(icon === undefined ? {} : { icon })}
        disabled={held}
        aria-describedby={describedBy}
        {...(mode.kind === 'native' ? { 'data-native-confirm': '' } : {})}
        onClick={() => {
          if (held) return;
          if (proof === undefined) setCodeOpen(true);
          else run(proof);
        }}
      >
        {proof === undefined ? withCode : withSensor(sensor)}
      </Button>
      {proof === undefined ? null : (
        <UseCodeInstead disabled={held} onClick={() => setCodeOpen(true)} />
      )}
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
  compact = false,
}: {
  item: ApprovalItem;
  owner: OwnerState;
  client: ApprovalsClient;
  sheet: SheetOptions;
  /** An applied decision (approve or deny); never called for a refused or failed attempt. */
  onDecided?: () => void;
  /** The decided card has collapsed out; the page keeps this line in its place. */
  onLeft?: (line: string) => void;
  /**
   * N3 (run1113 D3, the compact card on Home): one line with what the AI wants, the time left,
   * "Approve with Touch ID", "Deny with Touch ID" and "Review", which opens the full approval in
   * place (the facts, the quoted terms, the AI's words in their untrusted container, the footer and
   * Under the hood). Collapsed, nothing the AI wrote is drawn.
   */
  compact?: boolean;
}): ReactElement | null {
  const [step, setStep] = useState<Decision | undefined>(undefined);
  const [actions, setActions] = useState(true);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [paying, setPaying] = useState(false);
  const [outcome, setOutcome] = useState<'approved' | 'denied' | undefined>(undefined);
  const [reviewing, setReviewing] = useState(false);
  const reviewId = useId();
  const say = (text: string): void => setLines((l) => [...l, text]);

  // UI-REFRESH-o-b / o-c: a decided card (approved or denied) leaves once the sheet (if any) is
  // closed and the hold is over. Only an applied answer sets `outcome`.
  const [present, setPresent] = useState(true);
  const leaving = outcome !== undefined && !paying;
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = setTimeout(() => setPresent(false), APPROVED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  const row = useRowPresence<HTMLDivElement>(present, {
    onGone: () =>
      onLeft?.(
        fmt(outcome === 'denied' ? S.deniedLine : S.approvedLine, { summary: item.summary }),
      ),
  });

  const answer = (a: DecideAnswer, by: Presence['kind']): void => {
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
    // IR-UX1113-N2-1 #2: a sensor proof the server refused was used, not "wasn't used".
    say(
      (a.kind === 'status' && by !== 'code' ? sensorAnswer(a.status) : undefined) ??
        decisionText(a),
    );
    // F32: after approving something marked Free, say in plain words what that means.
    if (
      a.kind === 'status' &&
      a.status === 'applied' &&
      a.decision === 'approve' &&
      item.details?.cost === FREE
    ) {
      say(S.freeExplained);
    }
    if (a.kind === 'status' && RETRY.has(a.status)) setActions(true);
  };

  // UX1113-N2 (R2-UI-13) + N3: with Touch ID in the Mac app, or a passkey here, the Approve / Deny
  // button is the gesture ("Approve with Touch ID"): one press, one gesture, one request. The master
  // code is the link under the buttons; with it (or with no sensor here) the buttons open the code.
  const { mode, sensor } = useApprovalPresence(owner);
  const [codeMode, setCodeMode] = useState(false);
  const proof = codeMode ? undefined : sensorPresence(mode);
  // IR-UX1113-N2-1 #1: one decision in flight, whatever the buttons do meanwhile.
  const flight = useRef(false);
  const decideNow = async (decision: Decision, presence: Presence): Promise<void> => {
    if (flight.current) return;
    flight.current = true;
    setActions(false);
    try {
      const a = await client.decide(item, decision, presence);
      answer(a, presence.kind);
      if (a.kind === 'dismissed') setActions(true);
    } finally {
      flight.current = false;
    }
  };
  // IR-N3-1 #1: terms commit the owner, so on the compact card Approve is offered only once Review
  // shows every line of them; Deny needs no Review.
  const termsHidden = compact && item.commitment && !reviewing;
  const open = (decision: Decision): void => {
    if (flight.current) return;
    if (decision === 'approve' && termsHidden) return;
    // M1-PAY-CONFIRM-b: approving a request that costs credits is the confirmation sheet's.
    if (item.paid && decision === 'approve') {
      setPaying(true);
      return;
    }
    if (proof !== undefined) {
      void decideNow(decision, proof);
      return;
    }
    setActions(false);
    setStep(decision);
  };

  const full = (
    <>
      <ApprovalFacts item={item} />
      {item.commitment ? <p className="al-note">{S.termsAlone}</p> : null}
      {item.paid ? <p className="al-note">{S.paidAlone}</p> : null}
    </>
  );
  const reading = mode.kind === 'reading';

  if (!row.mounted) return null;
  return (
    <div ref={row.ref} className="ap-leave">
      <Surface
        as="section"
        level={step !== undefined || paying ? 2 : 1}
        className={compact ? 'al-approval al-approval-compact' : 'al-approval'}
        {...(APPROVAL_ID.test(item.approvalId) ? { 'data-approval': item.approvalId } : {})}
        {...(outcome === undefined ? {} : { 'data-outcome': outcome })}
      >
        {compact ? <CompactHead item={item} /> : full}
        <div className="al-slot">
          {owner.ready && actions ? (
            // Deny first, Approve as the wider primary (D1); neither is a default button (11 §8).
            <div className="al-approval-actions">
              <Button size="lg" disabled={reading} onClick={() => open('deny')}>
                {proof === undefined ? S.deny : fmt(S.denyWith, { sensor })}
              </Button>
              {/* F30/F31: while the code step is open, its button is the one orange button. */}
              {termsHidden ? null : (
                <Button
                  {...(step === undefined ? { variant: 'primary' as const } : {})}
                  size="lg"
                  disabled={reading}
                  {...(proof?.kind === 'native' && !item.paid ? { 'data-native-confirm': '' } : {})}
                  onClick={() => open('approve')}
                >
                  {proof !== undefined && !item.paid ? fmt(S.approveWith, { sensor }) : S.approve}
                </Button>
              )}
              {compact ? (
                <Button
                  variant="ghost"
                  size="lg"
                  aria-expanded={reviewing}
                  aria-controls={reviewId}
                  onClick={() => setReviewing((r) => !r)}
                >
                  {reviewing ? S.hideReview : S.review}
                </Button>
              ) : null}
              {proof !== undefined ? <UseCodeInstead onClick={() => setCodeMode(true)} /> : null}
            </div>
          ) : null}
          {outcome === 'approved' ? <ApprovedMoment /> : null}
          <Statuses lines={lines} />
          {step === undefined ? null : (
            <CodeStep
              codeSubmit={step === 'approve' ? S.confirmApproval : S.confirmDenial}
              label={step === 'approve' ? S.confirmApproval : S.confirmDenial}
              onCode={async (code) =>
                answer(await client.decide(item, step, { kind: 'code', code }), 'code')
              }
              onCancel={() => {
                setStep(undefined);
                setActions(true);
              }}
            />
          )}
        </div>
        {compact ? (
          reviewing ? (
            <div id={reviewId} className="al-approval-review al-expand">
              {full}
              <ApprovalFoot />
              <UnderTheHood fields={approvalHoodFields(item)} />
            </div>
          ) : (
            <div id={reviewId} hidden />
          )
        ) : (
          <>
            <ApprovalFoot />
            <UnderTheHood fields={approvalHoodFields(item)} />
          </>
        )}
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
