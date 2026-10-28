// M1-11b-2: Approvals in the app (08 §1; 11 §6.2.1; 04 §2.5, §2.5.2, §2.5.3; D-68, D-118, D-132).
// Ported from the server-rendered approval page, removed in M1-11b-2c (a server without the app
// bundle now shows a fixed page that points to the terminal). Same routes, words and rules:
//
// - "Waiting for you (n)": the pending requests, soonest to expire first, at most 20. A plain
//   request offers Approve, Deny or Later; one button names exactly what is included. Before asking
//   for presence the page checks the list again, leaves out what is no longer waiting (or changed),
//   says so and shows "This covers exactly these n"; then one passkey gesture or one owner code.
// - A commitment (D-31) and a request that costs credits (04 §2.5.3 rule 7) are never list items:
//   each is its own card with its own Approve and Deny; the paid one approves through the sheet.
// - Before the owner is set up nothing can be approved, with the reason. The switch to a passkey is
//   the layout's next-step banner (M1-UX-FIRSTRUN-V2-c); where passkeys can't work, the page says
//   the owner code is the way.
// - Every server value is React text (I-5). The browser never signs (D-118).
// - UI-REFRESH-o (visual only): cards on level 1, the one being decided on level 2; the shared
//   Skeleton on first load; the approved moment after a review that approved something. What is
//   sent, when presence is asked and what the owner sees are unchanged (approvals.test.ts).
// - UI-REFRESH-o-b: an approved card collapses out and leaves its result as a line of text; the
//   sidebar badge is told how many still wait (a number only; badge.ts).
import { Button, Skeleton, Surface, type PayPlatform } from '@4thtech-io/ui';
import { UnderTheHood } from '../../lazy/hood.js';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { announceDecided, announceWaiting } from './badge.js';
import type { PayConfirmClient } from '../../pay-confirm/index.js';
import {
  ApprovalFacts,
  ApprovalFoot,
  ApprovedMoment,
  approvalHoodFields,
  OwnerStep,
  SingleApproval,
  Statuses,
  waitText,
  type OwnerState,
  type SheetOptions,
} from './card.js';
import {
  createApprovalsClient,
  type ApprovalItem,
  type ApprovalsClient,
  type DecideAnswer,
  type Decision,
  type ReviewPick,
} from './client.js';
import { APPROVAL_STRINGS as S, fmt } from './strings.js';
import './approvals.css';

export { APPROVAL_TTL } from './card.js';

const MAX_LIST = 20;

export interface ApprovalsPageProps {
  readonly client?: ApprovalsClient;
  readonly payConfirm?: PayConfirmClient;
  /** Whether this browser can use a passkey. Default: detected. */
  readonly canPasskey?: boolean;
  readonly platform?: PayPlatform;
  readonly reducedMotion?: boolean;
}

function browserPasskeys(): boolean {
  return (
    typeof window !== 'undefined' &&
    'PublicKeyCredential' in window &&
    typeof navigator !== 'undefined' &&
    navigator.credentials !== undefined
  );
}

export interface OwnerView extends OwnerState {
  /** The server offers a localhost passkey (registered or not). */
  readonly offered: boolean;
}

/** Reads the owner and the decision passkey once; undefined while loading. */
export function useOwner(client: ApprovalsClient, canPasskey: boolean): OwnerView | undefined {
  const [owner, setOwner] = useState<OwnerView | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void client.passkey().then((answer) => {
      if (!live) return;
      if (answer.kind === 'needs_owner') setOwner({ ready: false, offered: false });
      else {
        setOwner({
          ready: true,
          offered: answer.offered,
          ...(canPasskey && answer.passkey !== undefined ? { passkey: answer.passkey } : {}),
        });
      }
    });
    return () => {
      live = false;
    };
  }, [client, canPasskey]);
  return owner;
}

/** Owner set up? If not, the reason; where passkeys can't work, the owner code is the way. */
export function OwnerPanel({
  owner,
  canPasskey,
  needsOwnerOnly = false,
}: {
  owner: OwnerView;
  canPasskey: boolean;
  needsOwnerOnly?: boolean;
}): ReactElement | null {
  if (!owner.ready) {
    return (
      <Surface as="section" level={1} className="al-panel">
        <h2>{S.needsOwnerTitle}</h2>
        <p>{S.needsOwner}</p>
      </Surface>
    );
  }
  if (needsOwnerOnly || owner.passkey !== undefined) return null;
  // A passkey can be set up here: the layout's "Switch to …" banner is the one place to start.
  if (canPasskey && owner.offered) return null;
  return (
    <Surface as="section" level={1} className="al-panel">
      <h2>{S.firstRunTitle}</h2>
      <p>{S.firstRun}</p>
      <p>{S.noPasskeys}</p>
      <p className="al-note">{S.desktopNote}</p>
    </Surface>
  );
}

/**
 * What an approved card left behind once it collapsed out (UI-REFRESH-o-b): plain text a screen
 * reader can reach. Not a live region: the card's own status line already said it. When the card
 * took the focus with it, the focus lands on the line, never on a button.
 */
export function Results({ lines }: { lines: readonly string[] }): ReactElement | null {
  const last = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (lines.length === 0) return;
    const active = document.activeElement;
    if (active === null || active === document.body) last.current?.focus();
  }, [lines.length]);
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line, i) => (
        <p
          key={i}
          ref={i === lines.length - 1 ? last : undefined}
          className="al-status ap-result"
          tabIndex={-1}
        >
          {line}
        </p>
      ))}
    </>
  );
}

/** The page head every approvals view shares. */
export function ApprovalsHead(): ReactElement {
  return (
    <>
      <h1 className="al-text-title-1">{S.appTitle}</h1>
      <p className="al-lede">{S.cannotApprove}</p>
    </>
  );
}

function byExpiry(a: ApprovalItem, b: ApprovalItem): number {
  if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
  return a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0;
}

interface Counts {
  readonly approve: number;
  readonly deny: number;
}
function counts(picks: readonly ReviewPick[]): Counts {
  const approve = picks.filter((p) => p.decision === 'approve').length;
  return { approve, deny: picks.length - approve };
}
function totalsText(c: Counts): string {
  if (c.deny === 0) return fmt(S.totalsApprove, { approve: c.approve });
  if (c.approve === 0) return fmt(S.totalsDeny, { deny: c.deny });
  return fmt(S.totalsBoth, { approve: c.approve, deny: c.deny });
}
function doneText(c: Counts): string {
  if (c.deny === 0) return fmt(S.doneApprove, { approve: c.approve });
  if (c.approve === 0) return fmt(S.doneDeny, { deny: c.deny });
  return fmt(S.doneBoth, { approve: c.approve, deny: c.deny });
}

const LIST_RESULT: Readonly<Record<string, string>> = {
  presence_required: S.presenceRequired,
  presence_rejected: S.presenceRejected,
  not_pending: S.listNotPending,
  changed: S.listChanged,
  commitment: S.listTerms,
  paid_item_in_batch: S.listPaid,
  busy: S.busy,
  refused: S.listRefused,
  invalid: S.listRefused,
  needs_setup: S.needsSetup,
};
const RETRY = new Set(['presence_rejected', 'presence_required', 'busy', 'wait']);

function listText(answer: DecideAnswer): string {
  if (answer.kind === 'offline') return S.notRunning;
  if (answer.kind === 'dismissed') return S.notUsed;
  if (answer.status === 'wait') return waitText(answer.retryAfter);
  return LIST_RESULT[answer.status] ?? S.listRefused;
}

/** Approve, Deny or Later for one plain request; Later is the starting choice. */
function Choices({
  item,
  value,
  disabled,
  onChange,
}: {
  item: ApprovalItem;
  value: Decision | undefined;
  disabled: boolean;
  onChange: (next: Decision | undefined) => void;
}): ReactElement {
  const options: readonly (readonly [Decision | 'later', string])[] = [
    ['approve', S.approve],
    ['deny', S.deny],
    ['later', S.later],
  ];
  return (
    <div className="al-choices" role="radiogroup">
      {options.map(([v, label]) => (
        <label key={v} className="al-choice">
          <input
            type="radio"
            name={`choice-${item.approvalId}`}
            value={v}
            checked={(value ?? 'later') === v}
            disabled={disabled}
            onChange={() => onChange(v === 'later' ? undefined : v)}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

/** 04 §2.5.2 steps 4-6: the checked list, exactly what is included, then presence once. */
function ReviewStep({
  kept,
  owner,
  client,
  onBack,
  onFinished,
}: {
  kept: readonly ReviewPick[];
  owner: OwnerState;
  client: ApprovalsClient;
  onBack: () => void;
  onFinished: (notice: string, approved: number, applied: number) => void;
}): ReactElement {
  const [lines, setLines] = useState<readonly string[]>([]);
  const say = (text: string): void => setLines((l) => [...l, text]);
  const answer = (a: DecideAnswer): void => {
    if (a.kind === 'status' && a.status === 'applied') {
      onFinished(doneText(counts(kept)), counts(kept).approve, kept.length);
      return;
    }
    say(listText(a));
    if (a.kind === 'status' && !RETRY.has(a.status)) onFinished(listText(a), 0, 0);
  };
  return (
    <Surface level={2} className="al-panel">
      <OwnerStep
        passkey={owner.passkey !== undefined}
        passkeyLabel={S.confirmPasskey}
        codeSubmit={S.confirm}
        label={S.confirm}
        onPasskey={async () => {
          if (owner.passkey === undefined) return;
          answer(await client.review(kept, { kind: 'passkey', passkey: owner.passkey }));
        }}
        onCode={async (code) => answer(await client.review(kept, { kind: 'code', code }))}
      >
        <>
          <ul className="al-lines">
            {kept.map((p) => (
              <li key={p.item.approvalId}>
                {fmt(p.decision === 'approve' ? S.lineApprove : S.lineDeny, {
                  summary: p.item.summary,
                })}
              </li>
            ))}
          </ul>
          <p>{kept.length === 1 ? S.coversOne : fmt(S.coversMany, { count: kept.length })}</p>
        </>
      </OwnerStep>
      <Statuses lines={lines} />
      <Button variant="ghost" block onClick={onBack}>
        {S.back}
      </Button>
    </Surface>
  );
}

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'ok'; readonly all: readonly ApprovalItem[] };

/** The approvals list with review together. */
function ApprovalsList({
  owner,
  client,
  sheet,
}: {
  owner: OwnerView;
  client: ApprovalsClient;
  sheet: SheetOptions;
}): ReactElement {
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  const [choices, setChoices] = useState<Readonly<Record<string, Decision>>>({});
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [checking, setChecking] = useState(false);
  const [kept, setKept] = useState<readonly ReviewPick[] | undefined>(undefined);
  const [moment, setMoment] = useState(false);
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<readonly string[]>([]);
  const notice = (text: string): void => setNotices((n) => [...n, text]);

  useEffect(() => {
    let live = true;
    void client.list().then((answer) => {
      if (!live) return;
      setChoices({});
      setKept(undefined);
      setChecking(false);
      setDecided(new Set());
      setList(
        answer.kind === 'ok'
          ? { kind: 'ok', all: [...answer.items].sort(byExpiry) }
          : { kind: 'offline' },
      );
    });
    return () => {
      live = false;
    };
  }, [client, round]);
  const reload = useCallback(() => setRound((r) => r + 1), []);

  // The sidebar badge: what still waits, leaving out what was decided here (a number only).
  const waiting =
    list.kind === 'ok' ? list.all.filter((i) => !decided.has(i.approvalId)).length : undefined;
  useEffect(() => {
    if (waiting !== undefined) announceWaiting(waiting);
  }, [waiting]);
  const onDecided = (approvalId: string): void => setDecided((d) => new Set([...d, approvalId]));
  const onLeft = (approvalId: string, line: string): void => {
    setResults((r) => [...r, line]);
    setList((l) =>
      l.kind === 'ok' ? { kind: 'ok', all: l.all.filter((i) => i.approvalId !== approvalId) } : l,
    );
  };

  if (list.kind === 'loading') {
    return (
      <div className="al-list">
        <Skeleton loading label={S.loading} lines={4} />
      </div>
    );
  }
  if (list.kind === 'offline') {
    return (
      <div className="al-list">
        <Statuses lines={[S.notRunning]} />
      </div>
    );
  }
  const all = list.all;
  const shown = all.slice(0, MAX_LIST);
  const picked: ReviewPick[] = shown
    .filter((i) => choices[i.approvalId] !== undefined)
    .map((i) => ({ item: i, decision: choices[i.approvalId] as Decision }));
  const locked = checking || kept !== undefined;

  const startReview = async (): Promise<void> => {
    if (picked.length === 0) return;
    setNotices([]);
    setMoment(false);
    setChecking(true);
    const live = await client.list();
    if (live.kind !== 'ok') {
      notice(S.notRunning);
      setChecking(false);
      return;
    }
    const digests = new Map(live.items.map((i) => [i.approvalId, i.actionDigest]));
    const keep = picked.filter(
      (p) =>
        digests.get(p.item.approvalId) === p.item.actionDigest &&
        !p.item.commitment &&
        !p.item.paid,
    );
    const dropped = picked.length - keep.length;
    if (dropped === 1) notice(S.droppedOne);
    else if (dropped > 1) notice(fmt(S.droppedMany, { count: dropped }));
    if (keep.length === 0) {
      notice(S.nothingLeft);
      reload();
      return;
    }
    setChecking(false);
    setKept(keep);
  };

  return (
    <>
      <div className="al-notices">
        {moment ? <ApprovedMoment /> : null}
        <Results lines={results} />
        <Statuses lines={notices} />
      </div>
      <div className="al-list">
        <h2 className="al-section-title">{fmt(S.waiting, { count: all.length })}</h2>
        {all.length === 0 ? <Statuses lines={[S.nothingWaiting]} /> : null}
        {shown.map((item) =>
          item.commitment || item.paid || !owner.ready ? (
            <SingleApproval
              key={`${round}-${item.approvalId}`}
              item={item}
              owner={owner}
              client={client}
              sheet={sheet}
              onDecided={() => onDecided(item.approvalId)}
              onLeft={(line) => onLeft(item.approvalId, line)}
            />
          ) : (
            <Surface
              as="section"
              key={item.approvalId}
              level={choices[item.approvalId] === undefined ? 1 : 2}
              className="al-approval"
              data-approval={item.approvalId}
            >
              <ApprovalFacts item={item} />
              <Choices
                item={item}
                value={choices[item.approvalId]}
                disabled={locked}
                onChange={(next) =>
                  setChoices((c) => {
                    const copy = { ...c };
                    if (next === undefined) delete copy[item.approvalId];
                    else copy[item.approvalId] = next;
                    return copy;
                  })
                }
              />
              <ApprovalFoot />
              <UnderTheHood fields={approvalHoodFields(item)} />
            </Surface>
          ),
        )}
        {all.length > shown.length ? (
          <Statuses lines={[fmt(S.moreWaiting, { count: all.length - shown.length })]} />
        ) : null}
        {owner.ready && all.length > 0 ? (
          <div className="al-bar">
            {locked ? null : (
              <Button
                variant="primary"
                size="lg"
                block
                disabled={picked.length === 0}
                onClick={() => void startReview()}
              >
                {picked.length === 0 ? S.nothingSelected : totalsText(counts(picked))}
              </Button>
            )}
            {kept === undefined ? null : (
              <ReviewStep
                kept={kept}
                owner={owner}
                client={client}
                onBack={() => setKept(undefined)}
                onFinished={(text, approved, applied) => {
                  announceDecided(applied);
                  notice(text);
                  setMoment(approved > 0);
                  reload();
                }}
              />
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function ApprovalsPage({
  client: given,
  payConfirm,
  canPasskey: givenCanPasskey,
  platform,
  reducedMotion,
}: ApprovalsPageProps): ReactElement {
  const client = useMemo(() => given ?? createApprovalsClient(), [given]);
  const canPasskey = givenCanPasskey ?? browserPasskeys();
  const owner = useOwner(client, canPasskey);
  const sheet: SheetOptions = {
    ...(payConfirm === undefined ? {} : { payConfirm }),
    ...(platform === undefined ? {} : { platform }),
    ...(reducedMotion === undefined ? {} : { reducedMotion }),
  };
  return (
    <div className="al-approvals">
      <ApprovalsHead />
      {owner === undefined ? (
        <Skeleton loading label={S.loading} lines={4} />
      ) : (
        <>
          <OwnerPanel owner={owner} canPasskey={canPasskey} />
          <ApprovalsList owner={owner} client={client} sheet={sheet} />
        </>
      )}
    </div>
  );
}
