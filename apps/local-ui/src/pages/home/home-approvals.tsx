// W4-HOME: the approval card on top of Home (prototype v23 A4/A10; W4 UX v2 "Approvals"; 11 §6.2.1;
// 04 §2.5, §2.5.2, §2.5.3; D-68, D-118). The soonest-to-expire request is the compact card (#714's
// SingleApproval: Approve and Deny, the presence step inline, Details folded); "+N more waiting"
// opens the others in place, each with its own Approve and Deny.
//
// Under the hood adds each request's ID, kind and exact expiry, and the bulk review: free plain
// requests can be picked and approved together with ONE presence step (client.review, the same
// call and "This covers exactly these n" as the old Approvals list). Terms and anything that costs
// money are never pickable: each keeps its own Approve (paid through the confirmation sheet).
//
// Nothing here signs (D-118); every server value is React text (I-5); the badge hears how many
// still wait (a number only).
import { Button, VT_CLASS } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { announceDecided, announceWaiting } from '../approvals/badge.js';
import {
  OwnerStep,
  SingleApproval,
  Statuses,
  type OwnerState,
  type SheetOptions,
} from '../approvals/card.js';
import type { ApprovalItem, ApprovalsClient, DecideAnswer } from '../approvals/client.js';
import { APPROVAL_STRINGS as A } from '../approvals/strings.js';
import { HOME_STRINGS as S, fmt } from './people-strings.js';

const EXACT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Soonest to expire first; ties by ID, so the order never jumps. */
export function byExpiry(a: ApprovalItem, b: ApprovalItem): number {
  if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
  return a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0;
}

/** A request that may join a bulk review: neither terms nor paid (04 §2.5.2, §2.5.3 rule 7). */
export const pickable = (item: ApprovalItem): boolean => !item.commitment && !item.paid;

function kindOf(item: ApprovalItem): string {
  if (item.commitment) return S.kindTerms;
  if (item.paid) return S.kindPaid;
  return S.kindRequest;
}

/** Under the hood: ID, kind, exact expiry, and whether it costs money. */
function Meta({ item }: { readonly item: ApprovalItem }): ReactElement {
  return (
    <p className="hm-ap-meta al-reveal">
      <span>
        {S.approvalId} {item.approvalId}
      </span>
      <span>
        {S.approvalKind} {kindOf(item)}
      </span>
      <span>
        {S.approvalExpires} {EXACT.format(new Date(item.expiresAt * 1000))}
      </span>
      <span>{item.paid ? S.paidText : S.freeText}</span>
    </p>
  );
}

const RETRY = new Set(['presence_rejected', 'presence_required', 'busy', 'wait']);
/** A review that applied nothing: what changed, in the list's own words (IR-W4-HOME-1 b). */
const NOT_APPLIED: Readonly<Record<string, string>> = {
  changed: A.listChanged,
  not_pending: A.listNotPending,
  commitment: A.listTerms,
  paid_item_in_batch: A.listPaid,
};

/** The bulk review's presence step: exactly the picked requests, then one gesture. */
function BulkReview({
  picks,
  owner,
  client,
  onDone,
  onBack,
}: {
  readonly picks: readonly ApprovalItem[];
  readonly owner: OwnerState;
  readonly client: ApprovalsClient;
  /** `applied` requests were decided; otherwise `why` says why nothing was. */
  readonly onDone: (applied: number, why?: string) => void;
  readonly onBack: () => void;
}): ReactElement {
  const [lines, setLines] = useState<readonly string[]>([]);
  const review = picks.map((item) => ({ item, decision: 'approve' as const }));
  const answer = (a: DecideAnswer): void => {
    if (a.kind === 'status' && a.status === 'applied') {
      onDone(picks.length);
      return;
    }
    if (a.kind === 'offline') setLines((l) => [...l, A.notRunning]);
    else if (a.kind === 'dismissed') setLines((l) => [...l, A.notUsed]);
    else if (!RETRY.has(a.status)) onDone(0, NOT_APPLIED[a.status] ?? A.listRefused);
    else setLines((l) => [...l, A.presenceRejected]);
  };
  return (
    <div className="hm-ap-bulk al-reveal">
      <OwnerStep
        passkey={owner.passkey !== undefined}
        passkeyLabel={A.confirmPasskey}
        codeSubmit={A.confirm}
        label={A.confirm}
        onPasskey={async () => {
          if (owner.passkey === undefined) return;
          answer(await client.review(review, { kind: 'passkey', passkey: owner.passkey }));
        }}
        onCode={async (code) => answer(await client.review(review, { kind: 'code', code }))}
      >
        <>
          <ul className="al-lines">
            {picks.map((item) => (
              <li key={item.approvalId}>{fmt(A.lineApprove, { summary: item.summary })}</li>
            ))}
          </ul>
          <p>{picks.length === 1 ? A.coversOne : fmt(A.coversMany, { count: picks.length })}</p>
        </>
      </OwnerStep>
      <Statuses lines={lines} />
      <Button variant="ghost" size="sm" onClick={onBack}>
        {A.back}
      </Button>
    </div>
  );
}

function Pick({
  item,
  picked,
  disabled,
  onToggle,
}: {
  readonly item: ApprovalItem;
  readonly picked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  return (
    <input
      type="checkbox"
      className="hm-ap-pick"
      checked={picked}
      disabled={disabled}
      aria-label={fmt(S.selectApproval, { summary: item.summary })}
      onChange={onToggle}
    />
  );
}

export function HomeApprovals({
  items,
  owner,
  client,
  sheet,
  pro,
  onChanged,
}: {
  readonly items: readonly ApprovalItem[];
  readonly owner: OwnerState;
  readonly client: ApprovalsClient;
  readonly sheet: SheetOptions;
  readonly pro: boolean;
  /** A decision was applied: read the list again. */
  readonly onChanged: () => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const [kept, setKept] = useState<readonly ApprovalItem[]>([]);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  // A decided card stays (its Approved moment, the pay sheet's Done) until it has collapsed out,
  // even when the list read meanwhile no longer holds it; then the list is read again.
  const [held, setHeld] = useState<ReadonlyMap<string, ApprovalItem>>(new Map());
  const listed = new Set(items.map((i) => i.approvalId));
  const sorted = [...items, ...[...held.values()].filter((i) => !listed.has(i.approvalId))].sort(
    byExpiry,
  );
  const ids = sorted.map((i) => i.approvalId).join(' ');

  useEffect(() => {
    announceWaiting(sorted.length);
    // Drop picks that no longer wait.
    const waiting = new Set(ids.split(' '));
    setPicked((p) => new Set([...p].filter((id) => waiting.has(id))));
    // Only the set of IDs matters here (`ids` carries the count too).
  }, [ids, sorted.length]);

  const first = sorted[0];
  if (first === undefined) {
    return notice === undefined ? null : (
      <p role="status" className="hm-ap-done al-text-body-sm">
        {notice}
      </p>
    );
  }
  const more = sorted.slice(1);
  // The card on top can be picked too (IR-W4-HOME-1 a); terms and paid requests never.
  const bulk = pro ? sorted.filter((i) => picked.has(i.approvalId) && pickable(i)) : [];
  const canPick = (i: ApprovalItem): boolean => pro && pickable(i) && owner.ready;
  const toggle = (i: ApprovalItem): void =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(i.approvalId)) next.delete(i.approvalId);
      else next.add(i.approvalId);
      return next;
    });
  // Before presence, read the list again: what is no longer waiting, or changed, is left out and
  // said (04 §2.5.2, as the review-together list did); only the rest goes to the gesture.
  const startReview = async (): Promise<void> => {
    setNotice(undefined);
    const live = await client.list();
    if (live.kind !== 'ok') {
      setNotice(A.notRunning);
      return;
    }
    const digests = new Map(live.items.map((i) => [i.approvalId, i.actionDigest]));
    const keep = bulk.filter((i) => digests.get(i.approvalId) === i.actionDigest && pickable(i));
    const dropped = bulk.length - keep.length;
    if (dropped === 1) setNotice(A.droppedOne);
    else if (dropped > 1) setNotice(fmt(A.droppedMany, { count: dropped }));
    if (keep.length === 0) {
      setNotice(A.nothingLeft);
      onChanged();
      return;
    }
    setKept(keep);
    setReviewing(true);
  };
  const decided = (item: ApprovalItem): void => {
    announceDecided(1);
    setHeld((h) => new Map(h).set(item.approvalId, item));
  };
  const left = (item: ApprovalItem): void => {
    setHeld((h) => {
      const next = new Map(h);
      next.delete(item.approvalId);
      return next;
    });
    onChanged();
  };

  return (
    <section aria-label={S.approvalsLabel} className={`hm-approvals ${VT_CLASS.approval}`}>
      {pro ? (
        <div className="hm-ap-top">
          {canPick(first) ? (
            <Pick
              item={first}
              picked={picked.has(first.approvalId)}
              disabled={reviewing}
              onToggle={() => toggle(first)}
            />
          ) : null}
          <Meta item={first} />
        </div>
      ) : null}
      <SingleApproval
        key={first.approvalId}
        item={first}
        owner={owner}
        client={client}
        sheet={sheet}
        passkeyLabel={A.confirmPasskey}
        compact
        onDecided={() => decided(first)}
        onLeft={() => left(first)}
      />
      {more.length === 0 ? null : (
        <button
          type="button"
          className="hm-ap-more"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {fmt(open ? S.hideMore : S.moreWaiting, { count: more.length })}
          <span className="hm-chev" data-open={open ? 'down' : 'up'} aria-hidden="true" />
        </button>
      )}
      {open && more.length > 0 ? (
        <div className="hm-ap-list al-expand">
          {more.map((item) => (
            <div key={item.approvalId} className="hm-ap-item">
              {canPick(item) ? (
                <Pick
                  item={item}
                  picked={picked.has(item.approvalId)}
                  disabled={reviewing}
                  onToggle={() => toggle(item)}
                />
              ) : null}
              <div className="hm-ap-body">
                {pro ? <Meta item={item} /> : null}
                <SingleApproval
                  item={item}
                  owner={owner}
                  client={client}
                  sheet={sheet}
                  passkeyLabel={A.confirmPasskey}
                  compact
                  onDecided={() => decided(item)}
                  onLeft={() => left(item)}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {pro && (open || bulk.length > 0) ? (
        <div className="hm-ap-bar">
          {bulk.length > 0 && !reviewing ? (
            <Button variant="primary" size="sm" onClick={() => void startReview()}>
              {fmt(S.approveSelected, { count: bulk.length })}
            </Button>
          ) : null}
          {open ? <span className="hm-ap-note al-text-body-sm">{S.paidAlone}</span> : null}
        </div>
      ) : null}
      {reviewing && kept.length > 0 ? (
        <BulkReview
          picks={kept}
          owner={owner}
          client={client}
          onBack={() => setReviewing(false)}
          onDone={(applied, why) => {
            setReviewing(false);
            setPicked(new Set());
            if (applied > 0) {
              announceDecided(applied);
              setNotice(fmt(S.approvedSelected, { count: applied }));
            } else if (why !== undefined) {
              setNotice(why);
            }
            onChanged();
          }}
        />
      ) : null}
      {notice === undefined ? null : (
        <p role="status" className="hm-ap-done al-text-body-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
