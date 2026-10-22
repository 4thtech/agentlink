// Proof, receipts, credits and files (M1-35b; d1/components/ProofBadge, ReceiptTimeline, CostChip,
// CreditsMeter, FileCard; DESIGN-ADJ-1 C-5, C-6, C-7, C-9, X-4, X-6).
import type { ReactElement, ReactNode } from 'react';
import { Icon } from './brand.js';
import { Button } from './forms.js';
import { StatusChip } from './identity.js';
import type { Status } from './types.js';
import { cleanText, cx, sentence } from './util.js';

export type ProofState =
  'recording' | 'recorded' | 'failed' | 'waiting' | 'submitted' | 'needs-credits';

const PROOF: Readonly<Record<ProofState, readonly [icon: string, word: string]>> = {
  recording: ['refresh-cw', 'Recording proof…'],
  recorded: ['proof-seal', 'Proof recorded'],
  failed: ['triangle-alert', "Proof wasn't recorded"],
  waiting: ['approval', 'Proof waiting for approval'],
  submitted: ['arrow-right', 'Proof submitted'],
  'needs-credits': ['circle-alert', 'Proof needs credits'],
};

export interface ProofBadgeProps {
  state?: ProofState;
  /** The exact time it was recorded. */
  time?: string;
}

/** Proof state for a message or file. Uses the proof seal colour, never the success colour. */
export function ProofBadge({ state = 'recorded', time }: ProofBadgeProps): ReactElement {
  const [icon, word] = PROOF[state] ?? PROOF.recorded;
  return (
    <span
      className={cx('al-proof', `is-${state}`)}
      role={state === 'recording' ? 'status' : undefined}
    >
      <Icon name={icon} size={14} />
      <span className="al-text-body-sm">{word}</span>
      {time === undefined ? null : <span className="al-proof-time al-text-code">{time}</span>}
    </span>
  );
}

export type ReceiptKey =
  | 'recorded'
  | 'delivered'
  | 'opened'
  | 'accepted'
  | 'rejected'
  | 'received'
  | 'sent'
  | 'asked'
  | 'not-confirmed'
  | 'waiting-to-post';

const RECEIPT: Readonly<Record<ReceiptKey, readonly [icon: string, word: string]>> = {
  recorded: ['proof-seal', 'Recorded'],
  delivered: ['receipt-delivered', 'Delivered'],
  opened: ['receipt-opened', 'Opened'],
  accepted: ['receipt-accepted', 'Accepted'],
  rejected: ['receipt-rejected', 'Rejected'],
  received: ['inbox', 'Received'],
  sent: ['arrow-right', 'Sent'],
  asked: ['receipt-delivered', 'Delivery requested'],
  'not-confirmed': ['clock', 'Not confirmed'],
  'waiting-to-post': ['clock', 'Waiting to post'],
};

export interface ReceiptStep {
  key: ReceiptKey;
  label?: string;
  /** The exact time, shown when the step is done. */
  time?: string;
  done?: boolean;
  /** A step the recipient gave renders lighter (D-109, D-114); the sender's proof fee covers it. */
  byRecipient?: boolean;
}

export interface ReceiptTimelineProps {
  steps: readonly ReceiptStep[];
}

/** Recorded, Delivered, Opened, Accepted or Rejected with exact times; pending steps hollow. */
export function ReceiptTimeline({ steps }: ReceiptTimelineProps): ReactElement {
  return (
    <ol className="al-rt">
      {steps.map((s, i) => {
        const [icon, word] = RECEIPT[s.key] ?? [undefined, sentence(String(s.key))];
        return (
          <li
            key={i}
            className={cx(
              'al-rt-step',
              s.done === true ? 'is-done' : 'is-pending',
              `is-${s.key}`,
              s.byRecipient === true && 'is-by-recipient',
            )}
          >
            <span className="al-rt-dot">
              <Icon name={icon ?? 'circle'} size={14} />
            </span>
            <span className="al-rt-label al-text-body">{s.label ?? word}</span>
            <span className="al-rt-time al-text-code">{s.done === true ? s.time : 'Waiting'}</span>
          </li>
        );
      })}
    </ol>
  );
}

export interface CostChipProps {
  /** An exact dollar amount, for example `$0.10`. Never an approximation. */
  amount?: string;
  free?: boolean;
  source?: string;
  /** The split, for example "AgentLink $0.10 · App fee $0.00" (tooltip or details). */
  split?: string;
}

/** An exact dollar amount in mono, or "Free". */
export function CostChip({ amount, free, source, split }: CostChipProps): ReactElement {
  return (
    <span className={cx('al-cost', free === true && 'is-free')} title={split}>
      <span className="al-text-code">{free === true ? 'Free' : amount}</span>
      {source === undefined ? null : <span className="al-text-body-sm al-muted">{source}</span>}
    </span>
  );
}

export interface CreditsMeterProps {
  /** For example `$4.20`. */
  balance: string;
  proofsLeft: number;
  /** Dollars spent in the last 24 hours (the proof budget window, 06 §3, G-7). */
  spentLast24h: number;
  /** The daily proof budget in dollars. */
  budget: number;
  state?: 'low' | 'empty' | 'reached';
  /** Free test credits on a testnet. */
  test?: boolean;
  /** When budget frees up, for example "Frees up at 14:20" (the oldest entry leaves the window). */
  frees?: string;
  /**
   * Adding credits needs the pay page, which is off until it ships (D-113, M1-26-e): without
   * `available: true` the button is hidden and the card says so.
   */
  addCredits?: { available: boolean; onAdd?: () => void };
  /** Testnet only: a button for free test credits. */
  onGetTestCredits?: () => void;
}

function dollars(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** Balance, proofs left and the last 24 hours against the budget. */
export function CreditsMeter({
  balance,
  proofsLeft,
  spentLast24h,
  budget,
  state,
  test,
  frees,
  addCredits,
  onGetTestCredits,
}: CreditsMeterProps): ReactElement {
  const ratio = budget > 0 ? Math.min(1, Math.max(0, spentLast24h / budget)) : 0;
  const step = Math.round((ratio * 100) / 5) * 5;
  const low = state === 'low' || state === 'empty';
  const available = addCredits?.available === true;
  const needsMore = state !== undefined;
  return (
    <section
      className={cx('al-credits', state !== undefined && `is-${state}`)}
      aria-label="Credits"
    >
      <div className="al-credits-top">
        <div>
          <div className="al-text-label al-muted">{test === true ? 'Test credits' : 'Credits'}</div>
          <div className="al-credits-bal al-text-title-1">{cleanText(balance, 40)}</div>
        </div>
        <div className="al-text-body-sm al-muted">{`${proofsLeft} proofs left`}</div>
      </div>
      <div
        className="al-credits-bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={Math.min(spentLast24h, budget)}
        aria-label="Spent in the last 24 hours"
      >
        <span className={cx('al-credits-fill', `al-pct-${step}`)} />
      </div>
      <div className="al-credits-foot al-text-body-sm">
        <span className="al-text-code">
          {`$${spentLast24h.toFixed(2)} of ${dollars(budget)} in the last 24 hours`}
        </span>
        {available ? (
          <Button
            size="sm"
            variant={low ? 'primary' : 'secondary'}
            icon="plus"
            onClick={addCredits?.onAdd}
          >
            Add credits
          </Button>
        ) : null}
        {test === true && onGetTestCredits !== undefined ? (
          <Button size="sm" icon="download" onClick={onGetTestCredits}>
            Get free test credits
          </Button>
        ) : null}
      </div>
      {frees === undefined ? null : <p className="al-text-caption al-muted">{frees}</p>}
      {needsMore && !available ? (
        <p className="al-text-caption al-muted">
          Adding credits is not available yet in this version of AgentLink.
        </p>
      ) : null}
      {state === 'low' || state === 'empty' ? (
        <p className="al-text-caption al-muted">Messages and files stay free.</p>
      ) : null}
    </section>
  );
}

export interface FileCardProps {
  /** Counterparty content: sanitized (no control or bidi characters, 80 at most), never a heading. */
  name: string;
  size: string;
  expiry?: string;
  from?: string;
  integrity?: 'ok' | 'failed';
  /** When the file is removed from the drop: after delivery is confirmed, or at expiry. */
  removal?: 'receipt' | 'expiry';
  /** The file has been removed. */
  removed?: boolean;
  proof?: ProofState;
  proofTime?: string;
  status?: Status;
  action?: ReactNode;
}

/** A file with its sanitized name (mono), size, expiry, removal, integrity and receipts. */
export function FileCard({
  name,
  size,
  expiry,
  from,
  integrity,
  removal,
  removed,
  proof,
  proofTime,
  status,
  action,
}: FileCardProps): ReactElement {
  const bad = integrity === 'failed';
  return (
    <div className={cx('al-file', bad && 'is-failed', removed === true && 'is-removed')}>
      <span className="al-file-ic">
        <Icon name={bad ? 'triangle-alert' : 'file'} size={18} />
      </span>
      <div className="al-file-main">
        <code className="al-file-name al-text-code">{cleanText(name, 80)}</code>
        <div className="al-file-meta al-text-body-sm al-muted">
          <span>{cleanText(size, 40)}</span>
          {expiry === undefined ? null : <span>{expiry}</span>}
          {from === undefined ? null : <span>{from}</span>}
        </div>
        {removed === true ? (
          <div className="al-file-removal al-text-body-sm">Removed</div>
        ) : removal === 'receipt' ? (
          <div className="al-file-removal al-text-body-sm al-muted">
            Removed once delivery is confirmed (or when it expires).
          </div>
        ) : removal === 'expiry' ? (
          <div className="al-file-removal al-text-body-sm al-muted">Removed when it expires.</div>
        ) : null}
        {bad ? (
          <div className="al-file-bad al-text-body-sm">Failed its integrity check; not saved.</div>
        ) : null}
      </div>
      <div className="al-file-side">
        {proof === undefined ? null : (
          <ProofBadge state={proof} {...(proofTime === undefined ? {} : { time: proofTime })} />
        )}
        {status === undefined ? null : <StatusChip status={status} />}
        {action ?? null}
      </div>
    </div>
  );
}
