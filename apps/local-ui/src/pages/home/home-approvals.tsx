// W4-HOME: the approval card on top of Home (prototype v23 A4/A10; W4 UX v2 "Approvals"; 11 §6.2.1;
// 04 §2.5, §2.5.2, §2.5.3; D-68, D-118). The soonest-to-expire request is the compact card (#714's
// SingleApproval: Approve and Deny, the presence step inline, Details folded); "+N more waiting"
// opens the others in place, each with its own Approve and Deny.
//
// N3 (run1113 D3): each card is compact: one line with what the AI wants, "Approve with Touch ID",
// "Deny with Touch ID" and "Review", which opens the full approval in place.
//
// Under the hood adds each request's ID, kind and exact expiry, and the bulk review: free plain
// requests can be picked and approved together with ONE presence step (client.review, the same
// call and "This covers exactly these n" as the old Approvals list). OWNERSTEP-LEFT: the bulk
// button itself is the sensor ("Approve 2 with Touch ID"); no second box. Terms and anything that
// costs money are never pickable: each keeps its own Approve (paid through the confirmation sheet).
//
// Nothing here signs (D-118); every server value is React text (I-5); the badge hears how many
// still wait (a number only).
import { AgentIcon, Banner, Icon, VT_CLASS } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { announceDecided, announceWaiting } from '../approvals/badge.js';
import {
  decisionText,
  PresenceAction,
  SingleApproval,
  type OwnerState,
  type SheetOptions,
} from '../approvals/card.js';
import type { ApprovalItem, ApprovalsClient, DecideAnswer, Presence } from '../approvals/client.js';
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
    <p className="hm-ap-meta hm-f al-text-code al-reveal">
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

/**
 * OWNERSTEP-LEFT: the bulk approve's answer in the page's words, or undefined once it applied. A
 * refused sensor proof was used and refused (IR-UX1113-N2-1 #2), never "wasn't used".
 */
function bulkAnswerText(a: DecideAnswer, by: Presence['kind']): string | undefined {
  if (a.kind === 'offline') return A.notRunning;
  if (a.kind === 'dismissed') return A.notUsed;
  if (a.status === 'applied') return undefined;
  if (RETRY.has(a.status)) {
    return by !== 'code' && a.status !== 'busy' && a.status !== 'wait'
      ? A.sensorRefused
      : decisionText(a);
  }
  return NOT_APPLIED[a.status] ?? A.listRefused;
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
  asker,
  askerSeed,
  askerLabel,
  onChanged,
}: {
  readonly items: readonly ApprovalItem[];
  readonly owner: OwnerState;
  readonly client: ApprovalsClient;
  readonly sheet: SheetOptions;
  readonly pro: boolean;
  /** W7-ID-B2: which ID is asking ("Claude Code's ID is asking"); from the live list, text only. */
  readonly asker?: string | undefined;
  /** W7-ID-X1: the asking ID's colour seed (its folder name) and label, as the switcher draws it. */
  readonly askerSeed?: string | undefined;
  readonly askerLabel?: string | undefined;
  /** A decision was applied: read the list again. */
  readonly onChanged: () => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
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
      <Banner tone="info" compact className="hm-ap-done" onDismiss={() => setNotice(undefined)}>
        {notice}
      </Banner>
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
  // OWNERSTEP-LEFT: one press of "Approve 2 with Touch ID" is the whole step. Before the request,
  // read the list again: what is no longer waiting, or changed, is said and nothing is sent, so the
  // owner confirms only what is still there (04 §2.5.2). Otherwise one review, one gesture.
  const approveSelected = async (presence: Presence): Promise<void> => {
    setNotice(undefined);
    setReviewing(true);
    try {
      const live = await client.list();
      if (live.kind !== 'ok') {
        setNotice(A.notRunning);
        return;
      }
      const digests = new Map(live.items.map((i) => [i.approvalId, i.actionDigest]));
      const keep = bulk.filter((i) => digests.get(i.approvalId) === i.actionDigest && pickable(i));
      const dropped = bulk.length - keep.length;
      if (dropped > 0) {
        setPicked(new Set(keep.map((i) => i.approvalId)));
        setNotice(
          keep.length === 0
            ? A.nothingLeft
            : dropped === 1
              ? A.droppedOne
              : fmt(A.droppedMany, { count: dropped }),
        );
        onChanged();
        return;
      }
      const a = await client.review(
        keep.map((item) => ({ item, decision: 'approve' as const })),
        presence,
      );
      const said = bulkAnswerText(a, presence.kind);
      if (said !== undefined) {
        setNotice(said);
        if (a.kind === 'status' && !RETRY.has(a.status)) onChanged();
        return;
      }
      setPicked(new Set());
      announceDecided(keep.length);
      setNotice(fmt(S.approvedSelected, { count: keep.length }));
      onChanged();
    } finally {
      setReviewing(false);
    }
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
      {asker === undefined || asker === '' ? null : (
        <p className="hm-ap-asker hm-f al-text-body-sm al-muted">
          {askerSeed === undefined || askerLabel === undefined ? null : (
            <AgentIcon label={askerLabel} seed={askerSeed} />
          )}
          <span>{asker}</span>
        </p>
      )}
      {pro ? (
        <div className="hm-ap-top hm-f">
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
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        </button>
      )}
      {open && more.length > 0 ? (
        <div className="hm-ap-list hm-c al-expand">
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
              <div className="hm-ap-body hm-c">
                {pro ? <Meta item={item} /> : null}
                <SingleApproval
                  item={item}
                  owner={owner}
                  client={client}
                  sheet={sheet}
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
        <div className="hm-ap-bar hm-f">
          {bulk.length > 0 ? (
            <PresenceAction
              owner={owner}
              size="sm"
              withSensor={(sensor) => fmt(S.approveSelectedWith, { count: bulk.length, sensor })}
              withCode={fmt(S.approveSelected, { count: bulk.length })}
              codeSubmit={A.confirm}
              statement={
                bulk.length === 1 ? A.coversOne : fmt(A.coversMany, { count: bulk.length })
              }
              disabled={reviewing}
              send={approveSelected}
            />
          ) : null}
          {open ? <span className="hm-ap-note al-text-body-sm">{S.paidAlone}</span> : null}
        </div>
      ) : null}
      {notice === undefined ? null : (
        <Banner tone="info" compact className="hm-ap-done" onDismiss={() => setNotice(undefined)}>
          {notice}
        </Banner>
      )}
    </section>
  );
}
