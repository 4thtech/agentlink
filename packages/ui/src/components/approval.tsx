// Approvals (M1-35b; d1/components/ApprovalCard, TermsDiff, CommitmentCard; 11 §8, 04 §2.5, 06 §3;
// DESIGN-ADJ-1 C-1, C-3, LA-3…LA-9). Visual and structural only: these components never sign,
// never decide and never ask for presence. The owner's browser or OS prompt appears after Approve
// is clicked (the caller starts it in `onApprove`); no prompt is ever drawn here.
import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import { Icon } from './brand.js';
import { Button } from './forms.js';
import { Banner } from './feedback.js';
import { formatContactName } from './identity.js';
import type { ApprovalState, ContactNameInput } from './types.js';
import { UntrustedContent } from './trust.js';
import { cleanText, cx } from './util.js';

/** The approvals the local app raises. (A file over the limit is not one: it has no approval, LA-5.) */
export type ApprovalType = 'new-contact' | 'proof' | 'document-key';

const TYPE: Readonly<Record<ApprovalType, readonly [icon: string, word: string]>> = {
  'new-contact': ['user-plus', 'New contact'],
  proof: ['proof-seal', 'Add proof'],
  'document-key': ['key-round', 'Include document key'],
};

/** What made the approval necessary. "Remember for this contact" depends on it (LA-4). */
export type RememberReason =
  'ask-me' | 'per-proof-limit' | 'daily-budget' | 'new-contact' | 'file' | 'commitment';

function ApprovalFooter(): ReactElement {
  return (
    <p className="al-approval-foot al-text-caption">
      <Icon name="approval" size={14} />
      Your AI can't approve this for you.
    </p>
  );
}

function stateBox(
  state: ApprovalState,
  method: string,
): readonly [tone: string, icon: string, text: string] | undefined {
  switch (state) {
    case 'waiting':
      return ['info', 'approval', `Waiting for ${method}… Confirm in the system prompt.`];
    case 'approved':
      return ['success', 'check', 'Approved. Your AI will continue.'];
    case 'denied':
      return ['neutral', 'x', 'Denied. Nothing was sent.'];
    case 'expired':
      return ['neutral', 'clock', 'This request expired.'];
    case 'failed':
      return ['danger', 'triangle-alert', "Approval didn't go through. Nothing was sent."];
    case 'decided-elsewhere':
      return ['neutral', 'check', 'Already decided in your terminal or another window.'];
    case 'pending':
      return undefined;
  }
}

function StateBox({
  state,
  method,
  onAskAgain,
}: {
  state: ApprovalState;
  method: string;
  onAskAgain?: (() => void) | undefined;
}): ReactElement | null {
  const box = stateBox(state, method);
  if (box === undefined) return null;
  return (
    <div className={cx('al-astate', `al-tone-${box[0]}`)} role="status" aria-live="polite">
      <Icon name={box[1]} size={16} />
      <span className="al-text-body">{box[2]}</span>
      {state === 'expired' && onAskAgain !== undefined ? (
        <Button size="sm" variant="ghost" onClick={onAskAgain}>
          Ask again
        </Button>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="al-arow">
      <dt className="al-text-label">{label}</dt>
      <dd className="al-text-body">{children}</dd>
    </div>
  );
}

export interface ApprovalCardProps {
  type: ApprovalType;
  agent: string;
  time?: string;
  expires?: string;
  headline: string;
  who?: ReactNode;
  what?: ReactNode;
  cost?: ReactNode;
  /** The rule that raised the approval. */
  why?: ReactNode;
  consequence?: ReactNode;
  /** Advanced IDs; collapsed on load. */
  details?: ReactNode;
  /** The 11 §5.6 lines, as the caller's strings (for example "A proof is public. …"). */
  disclosure?: readonly string[];
  /** A proof approval that also asks the contact to confirm delivery (M1-33d, LA-9). */
  receiptRequest?: { contact: ContactNameInput };
  /** The budget window when the daily budget raised the approval (LA-7). */
  budget?: { used: string; frees?: string };
  /** The "Remember for this contact" offer. Rendered only where the rules allow it (LA-4). */
  remember?: { reason: RememberReason; contact: ContactNameInput; rule: string };
  onRememberChange?: (remember: boolean) => void;
  state?: ApprovalState;
  /** The presence method named on the button: "Touch ID", "owner code", "owner passphrase"… */
  method?: string;
  onApprove?: () => void;
  onDeny?: () => void;
  onAskAgain?: () => void;
  children?: ReactNode;
}

/**
 * The one-screen owner decision: consequences and cost first, then Approve with the named method.
 * Focus starts on the headline, never on a button; the footer is always present.
 */
export function ApprovalCard({
  type,
  agent,
  time,
  expires,
  headline,
  who,
  what,
  cost,
  why,
  consequence,
  details,
  disclosure,
  receiptRequest,
  budget,
  remember,
  onRememberChange,
  state = 'pending',
  method,
  onApprove,
  onDeny,
  onAskAgain,
  children,
}: ApprovalCardProps): ReactElement {
  const [icon, word] = TYPE[type] ?? TYPE.proof;
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state === 'pending') heading.current?.focus();
  }, [state]);
  const actionable = state === 'pending' || state === 'waiting';
  const rememberOffer =
    remember !== undefined &&
    type === 'proof' &&
    (remember.reason === 'ask-me' || remember.reason === 'per-proof-limit');
  return (
    <article className={cx('al-card al-approval', `is-${state}`)} aria-labelledby={`${id}-h`}>
      <header className="al-approval-top al-text-body-sm">
        <span className="al-approval-type">
          <Icon name={icon} size={14} />
          <span className="al-text-label">{word}</span>
        </span>
        <span className="al-muted">{time === undefined ? agent : `${agent} · ${time}`}</span>
        {expires === undefined ? null : (
          <span className="al-approval-exp al-muted">
            <Icon name="clock" size={12} />
            {expires}
          </span>
        )}
      </header>
      <h2 id={`${id}-h`} ref={heading} className="al-text-title-2" tabIndex={-1}>
        {headline}
      </h2>
      <dl className="al-approval-rows">
        {who === undefined ? null : <Row label="Who">{who}</Row>}
        {what === undefined ? null : <Row label="What">{what}</Row>}
        {cost === undefined ? null : <Row label="Cost">{cost}</Row>}
        {budget === undefined ? null : (
          <Row label="Budget">
            {budget.used}
            {budget.frees === undefined ? null : (
              <span className="al-muted">{` · ${budget.frees}`}</span>
            )}
          </Row>
        )}
        {why === undefined ? null : <Row label="Why">{why}</Row>}
        {consequence === undefined ? null : <Row label="Then">{consequence}</Row>}
      </dl>
      {disclosure !== undefined && disclosure.length > 0 ? (
        <div className="al-disclosure">
          <Icon name="info" size={14} />
          <div>
            {disclosure.map((line, i) => (
              <p key={i} className="al-text-body-sm">
                {line}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {receiptRequest === undefined ? null : (
        <p className="al-disclosure-line al-text-body-sm">
          {`Ask ${formatContactName(receiptRequest.contact).text} to confirm delivery? If they do, anyone can see that this went to their agent.`}
        </p>
      )}
      {children === undefined ? null : <div className="al-approval-extra">{children}</div>}
      {rememberOffer ? (
        <label className="al-check al-remember al-text-body">
          <input
            type="checkbox"
            defaultChecked={false}
            onChange={(event) => onRememberChange?.(event.currentTarget.checked)}
          />
          <span>
            Remember for this contact
            <span className="al-text-body-sm">{formatContactName(remember.contact).text}</span>
            <span className="al-text-body-sm al-muted">{remember.rule}</span>
          </span>
        </label>
      ) : null}
      {details === undefined ? null : (
        <details className="al-approval-details">
          <summary className="al-text-body-sm">Details</summary>
          <div className="al-text-code al-muted">{details}</div>
        </details>
      )}
      {actionable ? (
        <div className="al-approval-actions">
          <Button size="lg" onClick={onDeny} disabled={state === 'waiting'}>
            Deny
          </Button>
          <Button
            variant="primary"
            size="lg"
            icon="approval"
            onClick={onApprove}
            disabled={state === 'waiting'}
          >
            {`Approve with ${method ?? 'passkey'}`}
          </Button>
        </div>
      ) : null}
      <StateBox state={state} method={method ?? 'your passkey'} onAskAgain={onAskAgain} />
      <ApprovalFooter />
    </article>
  );
}

export interface TermsDiffRow {
  field: string;
  old: string | null;
  new: string | null;
  /** The proposer's own text (subject, deliverable): marked "their words". */
  proposerWords?: boolean;
}

export interface TermsDiffProps {
  rows: readonly TermsDiffRow[];
  oldLabel?: string;
  newLabel?: string;
}

/** Version-to-version change in agreed terms: old value struck through, new value tinted with a sign. */
export function TermsDiff({
  rows,
  oldLabel = 'v2',
  newLabel = 'v3',
}: TermsDiffProps): ReactElement {
  return (
    <table className="al-diff">
      <thead>
        <tr>
          <th className="al-text-label">
            <span className="al-sr-only">Field</span>
          </th>
          <th className="al-text-label">{oldLabel}</th>
          <th className="al-text-label">{newLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const changed = r.old !== r.new;
          const kind =
            r.old === null ? 'added' : r.new === null ? 'removed' : changed ? 'changed' : 'same';
          const sign = { added: '+', removed: '−', changed: '~', same: '' }[kind];
          return (
            <tr key={i} className={`is-${kind}`}>
              <th scope="row" className="al-text-body-sm al-muted">
                {cleanText(r.field, 200)}
                {r.proposerWords === true ? (
                  <span className="al-diff-theirs al-text-caption">their words</span>
                ) : null}
              </th>
              <td className={cx('al-text-body', changed && r.old !== null && 'al-diff-old')}>
                {r.old === null ? <span className="al-muted">{'—'}</span> : cleanText(r.old)}
              </td>
              <td className={cx('al-text-body', kind !== 'same' && 'al-diff-new')}>
                {sign === '' ? null : (
                  <span className="al-diff-sign al-text-code" role="img" aria-label={kind}>
                    {sign}
                  </span>
                )}
                {r.new === null ? 'Removed' : cleanText(r.new)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface CommitmentCardProps {
  mode?: 'accept' | 'reject';
  headline: string;
  who: ReactNode;
  /** The proposer as displayed, for the label strip of the untrusted container. */
  proposer?: string;
  /** The proposer's subject: rendered inside the untrusted container. */
  subject?: string;
  diff?: TermsDiffProps;
  validUntil?: string;
  /** What this one approval does, exactly. */
  scope?: ReactNode;
  consequence?: ReactNode;
  /** For example "Free for you". */
  cost?: string;
  autoNote?: string;
  warning?: ReactNode;
  /** The terms fingerprint, collapsed under Advanced. */
  fingerprint?: string;
  state?: ApprovalState;
  method?: string;
  onApprove?: () => void;
  onCancel?: () => void;
}

/**
 * "Accepting terms" / "Rejecting terms": the approval that commits the owner to an agreement. It
 * never offers "remember", always says AgentLink moves no money, and says the acceptance is public
 * (11 §5.6, D-109).
 */
export function CommitmentCard({
  mode = 'accept',
  headline,
  who,
  proposer,
  subject,
  diff,
  validUntil,
  scope,
  consequence,
  cost,
  autoNote,
  warning,
  fingerprint,
  state = 'pending',
  method,
  onApprove,
  onCancel,
}: CommitmentCardProps): ReactElement {
  const reject = mode === 'reject';
  const id = useId();
  return (
    <article
      className={cx('al-card al-commit', reject && 'is-reject', `is-${state}`)}
      aria-labelledby={`${id}-h`}
    >
      <header className="al-commit-head">
        <Icon name={reject ? 'receipt-rejected' : 'commitment'} size={18} />
        <div>
          <div className="al-text-label">{reject ? 'Rejecting terms' : 'Accepting terms'}</div>
          <h2 id={`${id}-h`} className="al-text-title-2">
            {headline}
          </h2>
        </div>
        {validUntil === undefined ? null : (
          <span className="al-commit-valid al-text-body-sm">
            <Icon name="clock" size={12} />
            {`Valid until ${validUntil}`}
          </span>
        )}
      </header>
      <div className="al-commit-body">
        <div className="al-commit-who al-text-body-sm">
          <span className="al-muted">With </span>
          {who}
        </div>
        {subject === undefined ? null : (
          <UntrustedContent from={proposer ?? 'the proposer'} kind="terms">
            {subject}
          </UntrustedContent>
        )}
        {diff === undefined ? null : <TermsDiff {...diff} />}
        {warning === undefined ? null : (
          <Banner tone="warning" compact>
            {warning}
          </Banner>
        )}
        <dl className="al-approval-rows">
          {scope === undefined ? null : <Row label="This approval">{scope}</Row>}
          {consequence === undefined ? null : <Row label="Then">{consequence}</Row>}
          <Row label="Cost">{cost ?? 'Free for you'}</Row>
          {autoNote === undefined ? null : <Row label="Rules">{autoNote}</Row>}
        </dl>
        <p className="al-commit-honest al-text-caption al-muted">
          AgentLink records the agreement. It doesn't move money.
        </p>
        <p className="al-commit-public al-text-caption al-muted">
          {`This is public: anyone can see that your agent ${reject ? 'rejected' : 'accepted'} it, and when.`}
        </p>
        {fingerprint === undefined ? null : (
          <details className="al-approval-details">
            <summary className="al-text-body-sm">Advanced</summary>
            <div className="al-text-code al-muted">{`Terms fingerprint ${cleanText(fingerprint, 128)}`}</div>
          </details>
        )}
      </div>
      {state === 'pending' || state === 'waiting' ? (
        <div className="al-approval-actions">
          <Button size="lg" onClick={onCancel} disabled={state === 'waiting'}>
            Cancel
          </Button>
          <Button
            variant={reject ? 'danger' : 'primary'}
            size="lg"
            icon="approval"
            onClick={onApprove}
            disabled={state === 'waiting'}
          >
            {`${reject ? 'Reject' : 'Accept'} with ${method ?? 'passkey'}`}
          </Button>
        </div>
      ) : null}
      <StateBox state={state} method={method ?? 'your passkey'} />
      <ApprovalFooter />
    </article>
  );
}
