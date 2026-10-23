// Review together (M1-35b-b; design brief B-2, D-68; 04 §2.5.2, 11 §5.1, §6.2.1). One agent's
// pending approvals as full cards, soonest to expire first, at most 20, each with Approve, Deny and
// Later and nothing preselected; one summary button names exactly what it applies. Visual and
// structural only: this never signs, never decides and never asks for presence. The caller starts the
// browser's own prompt in `onConfirm`, and no prompt is drawn here. Terms are never in the list.
import { useEffect, useRef, type ReactElement } from 'react';
import {
  ApprovalCard,
  type ApprovalCardProps,
  type ReviewDecision,
  type ReviewResult,
} from './approval.js';
import { Icon } from './brand.js';
import { Button } from './forms.js';
import { cleanText } from './util.js';

/** The most cards one review shows. The rest wait for the next review (D-68). */
export const REVIEW_LIMIT = 20;

export interface ReviewItem extends Omit<
  ApprovalCardProps,
  'state' | 'review' | 'onDeny' | 'onAskAgain'
> {
  id: string;
  /** Milliseconds since the epoch; the list shows the soonest first. */
  expiresAt?: number;
  /** `expired` and `decided-elsewhere` show their state and leave the list's count. */
  status?: 'pending' | 'expired' | 'decided-elsewhere';
  /** Accepting or rejecting terms: never in the batch; its card has its own Approve. */
  decideAlone?: boolean;
}

export interface DecisionCounts {
  approve: number;
  deny: number;
}

/** "Approve 3 and deny 1": exactly what the one button applies. Undefined when nothing is included. */
export function decisionSummary({ approve, deny }: DecisionCounts): string | undefined {
  if (approve > 0 && deny > 0) return `Approve ${approve} and deny ${deny}`;
  if (approve > 0) return `Approve ${approve}`;
  if (deny > 0) return `Deny ${deny}`;
  return undefined;
}

/** One counted decision. `onConfirm` receives exactly the entries the summary text counted. */
export interface ReviewBatchEntry {
  id: string;
  decision: 'approve' | 'deny';
}

export interface ReviewTogetherProps {
  /** The agent whose approvals these are. */
  agent: string;
  items: readonly ReviewItem[];
  /** Controlled: nothing is chosen until the owner chooses. */
  decisions: Readonly<Record<string, ReviewDecision | undefined>>;
  onDecide: (id: string, decision: ReviewDecision) => void;
  /** The summary button: the caller then starts the browser's own passkey prompt (or owner code). */
  onConfirm: (batch: readonly ReviewBatchEntry[]) => void;
  /**
   * Called when decisions exist for cards that are no longer in the counted set (pushed past the
   * 20, expired, decided elsewhere, or terms). The caller deletes them, so a card that comes back
   * shows nothing chosen. They are never in the `onConfirm` batch either way.
   */
  onPrune?: (ids: readonly string[]) => void;
  /** Reviewing, waiting for the owner's confirmation, it failed (nothing applied), or done. */
  phase?: 'reviewing' | 'waiting' | 'failed' | 'done';
  /** The presence method: "passkey", "owner code" or "owner passphrase". */
  method?: string;
  /** Per-card results, shown when `phase` is `done`. */
  results?: Readonly<Record<string, ReviewResult | undefined>>;
}

function withoutExpiresAt(item: ReviewItem): Omit<ReviewItem, 'expiresAt'> {
  const copy: ReviewItem = { ...item };
  delete copy.expiresAt;
  return copy;
}

function inList(item: ReviewItem): boolean {
  return item.decideAlone !== true && (item.status ?? 'pending') === 'pending';
}

/** The "Waiting for you" view. */
export function ReviewTogether({
  agent,
  items,
  decisions,
  onDecide,
  onConfirm,
  onPrune,
  phase = 'reviewing',
  method = 'passkey',
  results,
}: ReviewTogetherProps): ReactElement {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (a.item.expiresAt ?? Number.POSITIVE_INFINITY) -
          (b.item.expiresAt ?? Number.POSITIVE_INFINITY) || a.index - b.index,
    )
    .map((e) => e.item);
  const shown = sorted.slice(0, REVIEW_LIMIT);
  const hidden = sorted.length - shown.length;
  const batch: ReviewBatchEntry[] = [];
  for (const item of shown) {
    if (!inList(item)) continue;
    const d = decisions[item.id];
    if (d === 'approve' || d === 'deny') batch.push({ id: item.id, decision: d });
  }
  const counts: DecisionCounts = {
    approve: batch.filter((e) => e.decision === 'approve').length,
    deny: batch.filter((e) => e.decision === 'deny').length,
  };
  const included = batch.length;
  const counted = new Set(shown.filter(inList).map((i) => i.id));
  const stale = Object.keys(decisions)
    .filter((id) => decisions[id] !== undefined && !counted.has(id))
    .join('\u0000');
  useEffect(() => {
    if (stale !== '') onPrune?.(stale.split('\u0000'));
  }, [stale, onPrune]);
  const waitingCount = items.filter((i) => (i.status ?? 'pending') === 'pending').length;
  const summary = decisionSummary(counts);
  const done = phase === 'done';
  const locked = phase === 'waiting';
  return (
    <section className="al-rv" aria-labelledby="al-rv-h">
      <header className="al-rv-head">
        <h1 id="al-rv-h" ref={heading} className="al-text-title-1" tabIndex={-1}>
          {waitingCount === 0 ? 'Waiting for you' : `Waiting for you (${waitingCount})`}
        </h1>
        <p className="al-text-body-sm al-muted">{cleanText(agent, 80)}</p>
      </header>
      {items.length === 0 ? (
        <p className="al-rv-empty al-text-body">Nothing is waiting for you.</p>
      ) : (
        <ul className="al-rv-list">
          {shown.map((item) => {
            const { id, status, decideAlone, ...card } = withoutExpiresAt(item);
            return (
              <li key={id} className="al-rv-item">
                <ApprovalCard
                  {...card}
                  state={status ?? 'pending'}
                  method={method}
                  review={{
                    decision: decisions[id],
                    onDecide: (d) => onDecide(id, d),
                    alone: decideAlone === true,
                    disabled: locked || done,
                    result: done ? results?.[id] : undefined,
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 ? (
        <p className="al-rv-more al-text-body-sm al-muted">
          {`${hidden} more are waiting. They show after this review.`}
        </p>
      ) : null}
      {phase === 'waiting' ? (
        <div className="al-astate al-tone-info" role="status" aria-live="polite">
          <Icon name="approval" size={16} />
          <span className="al-text-body">
            {`Waiting for your ${method}… Confirm in the system prompt.`}
          </span>
        </div>
      ) : null}
      {phase === 'failed' ? (
        <div className="al-astate al-tone-danger" role="alert">
          <Icon name="triangle-alert" size={16} />
          <span className="al-text-body">Nothing was applied. Your choices are still here.</span>
        </div>
      ) : null}
      {done ? (
        <div className="al-astate al-tone-success" role="status" aria-live="polite">
          <Icon name="check" size={16} />
          <span className="al-text-body">Done. Each result is shown on its card.</span>
        </div>
      ) : null}
      {!done && items.length > 0 ? (
        <div className="al-rv-confirm">
          <Button
            variant="primary"
            size="lg"
            icon="approval"
            data-review-confirm=""
            disabled={summary === undefined || locked}
            onClick={() => onConfirm(batch)}
          >
            {summary ?? 'Choose Approve or Deny'}
          </Button>
          {summary === undefined ? null : (
            <p className="al-text-body-sm al-muted">
              {`This covers exactly these ${included}. Anything new waits for your next review. You confirm once with your ${method}.`}
            </p>
          )}
        </div>
      ) : null}
      <p className="al-approval-foot al-text-caption">
        <Icon name="approval" size={14} />
        Your AI can't approve this for you.
      </p>
    </section>
  );
}
