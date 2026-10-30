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
  readonly onDone: (applied: number) => void;
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
    else if (!RETRY.has(a.status)) onDone(0);
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
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const sorted = [...items].sort(byExpiry);
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
  const bulk = pro ? more.filter((i) => picked.has(i.approvalId) && pickable(i)) : [];
  const decided = (): void => {
    announceDecided(1);
    onChanged();
  };

  return (
    <section aria-label={S.approvalsLabel} className={`hm-approvals ${VT_CLASS.approval}`}>
      {pro ? <Meta item={first} /> : null}
      <SingleApproval
        key={first.approvalId}
        item={first}
        owner={owner}
        client={client}
        sheet={sheet}
        passkeyLabel={A.confirmPasskey}
        compact
        onDecided={decided}
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
              {pro && pickable(item) && owner.ready ? (
                <input
                  type="checkbox"
                  className="hm-ap-pick"
                  checked={picked.has(item.approvalId)}
                  disabled={reviewing}
                  aria-label={fmt(S.selectApproval, { summary: item.summary })}
                  onChange={() =>
                    setPicked((p) => {
                      const next = new Set(p);
                      if (next.has(item.approvalId)) next.delete(item.approvalId);
                      else next.add(item.approvalId);
                      return next;
                    })
                  }
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
                  onDecided={decided}
                />
              </div>
            </div>
          ))}
          {pro ? (
            <div className="hm-ap-bar">
              {bulk.length > 0 && !reviewing ? (
                <Button variant="primary" size="sm" onClick={() => setReviewing(true)}>
                  {fmt(S.approveSelected, { count: bulk.length })}
                </Button>
              ) : null}
              <span className="hm-ap-note al-text-body-sm">{S.paidAlone}</span>
            </div>
          ) : null}
          {reviewing && bulk.length > 0 ? (
            <BulkReview
              picks={bulk}
              owner={owner}
              client={client}
              onBack={() => setReviewing(false)}
              onDone={(applied) => {
                setReviewing(false);
                setPicked(new Set());
                if (applied > 0) {
                  announceDecided(applied);
                  setNotice(fmt(S.approvedSelected, { count: applied }));
                }
                onChanged();
              }}
            />
          ) : null}
        </div>
      ) : null}
      {notice === undefined ? null : (
        <p role="status" className="hm-ap-done al-text-body-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
