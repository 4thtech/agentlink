// Activity (M1-11c-a1; d1 Local-activity; 08 §1; 11 §6.2; D-116, D-118).
//
// The merged feed of events that are not messages (approvals decided, proofs, blocked senders and
// contacts, rules updated), newest first, from `GET /api/ui/activity`, with "Show more" for the next
// page. Read only: nothing on this page changes anything, so nothing asks for presence.
//
// I-5: every value from the server is rendered as React text, never as HTML, and only after it
// passed the per-kind check below; an entry of another kind is skipped. No IDs, hashes or networks
// reach the view (the server does not send them), so Under the hood has nothing to list yet. Classes
// only, no inline styles (08 §4 CSP).
//
// UI-REFRESH-h: day groups with sticky headers, filter chips, a live dot, and a refresh every 20 s
// whose new rows enter at the top (at most two with the highlight). Skeleton on the first load.
import {
  Banner,
  Button,
  EmptyState,
  Fingerprint,
  LiveDot,
  ProofBadge,
  Skeleton,
  StatusChip,
  useRowPresence,
  useVisibilityPause,
  type ProofState,
} from '@4thtech-io/ui';
import { UnderTheHood } from '../../lazy/hood.js';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../api/client.js';
import './activity.css';
import { ACTIVITY_STRINGS as S } from './strings.js';

const PATH = '/api/ui/activity';
const PAGE_SIZE = 20;
/** How often the first page is fetched again while the tab is visible. */
export const ACTIVITY_POLL_MS = 20_000;
/** However many rows arrive at once, only this many enter with the highlight. */
const MAX_ENTERING = 2;

type Decision = 'approved' | 'approved_by_rules' | 'denied' | 'cancelled';
type ProofView = 'submitted' | 'needs_credits' | 'failed' | 'recorded' | 'received';

/** One feed entry as the page shows it. */
export type ActivityItem =
  | { readonly kind: 'approval_decided'; readonly at: number; readonly decision: Decision }
  | {
      readonly kind: 'proof';
      readonly at: number;
      readonly direction: 'sent' | 'received';
      readonly state: ProofView;
    }
  | { readonly kind: 'sender_blocked'; readonly at: number; readonly senderCode: string }
  | { readonly kind: 'contact_blocked'; readonly at: number }
  | { readonly kind: 'rules_changed'; readonly at: number };

interface Page {
  readonly items: readonly ActivityItem[];
  readonly nextCursor?: string;
}

const DECISIONS: ReadonlySet<string> = new Set([
  'approved',
  'approved_by_rules',
  'denied',
  'cancelled',
]);
const PROOF_VIEWS: ReadonlySet<string> = new Set([
  'submitted',
  'needs_credits',
  'failed',
  'recorded',
  'received',
]);
const MAX_TEXT = 64;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One entry, or undefined when it is not one this page knows (skipped, never guessed). */
function parseItem(raw: unknown): ActivityItem | undefined {
  if (!isRecord(raw)) return undefined;
  const { kind, at } = raw;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined;
  switch (kind) {
    case 'approval_decided':
      return typeof raw['decision'] === 'string' && DECISIONS.has(raw['decision'])
        ? { kind, at, decision: raw['decision'] as Decision }
        : undefined;
    case 'proof': {
      const { direction, state } = raw;
      if (direction !== 'sent' && direction !== 'received') return undefined;
      if (typeof state !== 'string' || !PROOF_VIEWS.has(state)) return undefined;
      return { kind, at, direction, state: state as ProofView };
    }
    case 'sender_blocked': {
      const code = raw['senderCode'];
      return typeof code === 'string' && code.length > 0 && code.length <= MAX_TEXT
        ? { kind, at, senderCode: code }
        : undefined;
    }
    case 'contact_blocked':
    case 'rules_changed':
      return { kind, at };
    default:
      return undefined;
  }
}

/** The page body, or undefined when it is malformed. */
function parsePage(data: unknown): Page | undefined {
  if (!isRecord(data) || !Array.isArray(data['items'])) return undefined;
  const next = data['nextCursor'];
  if (next !== undefined && (typeof next !== 'string' || next.length === 0)) return undefined;
  const items: ActivityItem[] = [];
  for (const raw of data['items'] as unknown[]) {
    const item = parseItem(raw);
    if (item !== undefined) items.push(item);
  }
  return next === undefined ? { items } : { items, nextCursor: next };
}

type Problem = 'error' | 'offline' | 'session' | 'not_set_up';

function problemOf(result: ApiResult<unknown>): Problem {
  switch (result.kind) {
    case 'offline':
      return 'offline';
    case 'session_expired':
    case 'forbidden':
      return 'session';
    case 'error':
      return result.status === 409 ? 'not_set_up' : 'error';
    default:
      return 'error';
  }
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

type Filter = 'all' | 'approvals' | 'proofs' | 'other';
const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: S.filterAll },
  { id: 'approvals', label: S.filterApprovals },
  { id: 'proofs', label: S.filterProofs },
  { id: 'other', label: S.filterOther },
];

function inFilter(item: ActivityItem, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'approvals':
      return item.kind === 'approval_decided';
    case 'proofs':
      return item.kind === 'proof';
    case 'other':
      return item.kind !== 'approval_decided' && item.kind !== 'proof';
  }
}

interface Keyed {
  readonly key: string;
  readonly item: ActivityItem;
}

/** A stable key per entry (the server sends no IDs): its content, plus a count for exact repeats. */
function keyed(items: readonly ActivityItem[]): Keyed[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = JSON.stringify(item);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: `${base}#${String(n)}`, item };
  });
}

/** The entries grouped by local day, in the order given. */
function byDay(rows: readonly Keyed[]): { day: string; at: number; rows: Keyed[] }[] {
  const groups: { day: string; at: number; rows: Keyed[] }[] = [];
  for (const row of rows) {
    const d = new Date(row.item.at * 1000);
    const day = `${String(d.getFullYear())}-${String(d.getMonth())}-${String(d.getDate())}`;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.day === day) last.rows.push(row);
    else groups.push({ day, at: row.item.at, rows: [row] });
  }
  return groups;
}

const PROOF_BADGE: Readonly<Record<Exclude<ProofView, 'received'>, ProofState>> = {
  submitted: 'submitted',
  needs_credits: 'needs-credits',
  failed: 'failed',
  recorded: 'recorded',
};

/** What happened, who it concerns and its status: plain words per kind. */
function describeItem(item: ActivityItem): {
  what: string;
  contact: ReactNode;
  status: ReactNode;
} {
  const none = <span className="al-muted">{S.none}</span>;
  switch (item.kind) {
    case 'approval_decided':
      switch (item.decision) {
        case 'approved':
          return { what: S.approved, contact: none, status: <StatusChip status="approved" /> };
        case 'approved_by_rules':
          return {
            what: S.approvedByRules,
            contact: none,
            status: <StatusChip status="approved" />,
          };
        case 'denied':
          return { what: S.denied, contact: none, status: <StatusChip status="denied" /> };
        case 'cancelled':
          return {
            what: S.cancelled,
            contact: none,
            status: <StatusChip status="denied">{S.cancelledChip}</StatusChip>,
          };
      }
      break;
    case 'proof':
      return item.state === 'received'
        ? { what: S.proofReceived, contact: none, status: <StatusChip status="received" /> }
        : {
            what: item.direction === 'received' ? S.proofReceived : S.proofSent,
            contact: none,
            status: <ProofBadge state={PROOF_BADGE[item.state]} />,
          };
    case 'sender_blocked':
      return {
        what: S.senderBlocked,
        contact: <Fingerprint prefix={S.senderPrefix} value={item.senderCode} />,
        status: none,
      };
    case 'contact_blocked':
      return { what: S.contactBlocked, contact: none, status: none };
    case 'rules_changed':
      return { what: S.rulesChanged, contact: none, status: none };
  }
  return { what: '', contact: none, status: none };
}

function Row({ item, isNew }: { item: ActivityItem; isNew: boolean }): ReactElement {
  const date = new Date(item.at * 1000);
  const { what, contact, status } = describeItem(item);
  const presence = useRowPresence<HTMLTableRowElement>(true, { isNew });
  return (
    <tr ref={presence.ref}>
      <td className="al-activity-time al-text-code">
        {presence.highlight}
        <time dateTime={date.toISOString()}>{TIME.format(date)}</time>
      </td>
      <td>{what}</td>
      <td>{contact}</td>
      <td>{status}</td>
    </tr>
  );
}

function ProblemView({
  problem,
  onRetry,
}: {
  problem: Problem;
  onRetry: () => void;
}): ReactElement {
  const retry = (
    <Button size="sm" onClick={onRetry}>
      {S.tryAgain}
    </Button>
  );
  switch (problem) {
    case 'not_set_up':
      return <EmptyState icon="settings" title={S.notSetUpTitle} prompt={S.notSetUpPrompt} />;
    case 'session':
      return (
        <Banner tone="info" title={S.sessionTitle}>
          {S.sessionBody}
        </Banner>
      );
    case 'offline':
      return (
        <Banner tone="offline" title={S.offlineTitle} action={retry}>
          {S.offlineBody}
        </Banner>
      );
    case 'error':
      return (
        <Banner tone="warning" title={S.errorTitle} action={retry}>
          {S.errorBody}
        </Banner>
      );
  }
}

type View =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly problem: Problem }
  | {
      readonly state: 'ready';
      readonly items: readonly ActivityItem[];
      readonly nextCursor?: string;
      readonly more: 'idle' | 'loading' | Problem;
      /** The last successful load, and whether the latest refresh failed (rows stay as they were). */
      readonly asOf: number;
      readonly stale: boolean;
      /** Keys of rows that arrived by a refresh and enter with the highlight. */
      readonly entering: readonly string[];
    };

export interface ActivityPageProps {
  /** The API client; the app's default one when absent (tests pass their own). */
  readonly api?: ApiClient;
}

export function ActivityPage({ api }: ActivityPageProps): ReactElement {
  const client = useRef<ApiClient>(api ?? createApiClient());
  const [view, setView] = useState<View>({ state: 'loading' });
  const [filter, setFilter] = useState<Filter>('all');
  const live = useRef(true);
  const hidden = useVisibilityPause();

  const fetchPage = useCallback(async (cursor?: string): Promise<Page | Problem> => {
    const query = `?limit=${String(PAGE_SIZE)}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const result = await client.current.get<unknown>(`${PATH}${query}`);
    if (result.kind !== 'ok') return problemOf(result);
    return parsePage(result.data) ?? 'error';
  }, []);

  const loadFirst = useCallback(async (): Promise<void> => {
    setView({ state: 'loading' });
    const page = await fetchPage();
    if (!live.current) return;
    setView(
      typeof page === 'string'
        ? { state: 'failed', problem: page }
        : {
            state: 'ready',
            items: page.items,
            ...cursorOf(page),
            more: 'idle',
            asOf: Date.now(),
            stale: false,
            entering: [],
          },
    );
  }, [fetchPage]);

  const loadMore = useCallback(
    async (current: Extract<View, { state: 'ready' }>): Promise<void> => {
      if (current.nextCursor === undefined) return;
      setView({ ...current, more: 'loading' });
      const page = await fetchPage(current.nextCursor);
      if (!live.current) return;
      setView(
        typeof page === 'string'
          ? { ...current, more: page }
          : {
              state: 'ready',
              asOf: current.asOf,
              stale: current.stale,
              items: [...current.items, ...page.items],
              ...cursorOf(page),
              more: 'idle',
              entering: [],
            },
      );
    },
    [fetchPage],
  );

  /** A refresh of the first page: new entries go on top; a failure keeps everything as it is. */
  const refresh = useCallback(async (): Promise<void> => {
    const page = await fetchPage();
    if (!live.current) return;
    setView((current) => {
      if (current.state !== 'ready') return current;
      if (typeof page === 'string') return { ...current, stale: true };
      const known = new Set(keyed(current.items).map((k) => k.key));
      const added = keyed(page.items).filter((k) => !known.has(k.key));
      if (added.length === 0) return { ...current, asOf: Date.now(), stale: false, entering: [] };
      return {
        ...current,
        items: [...added.map((k) => k.item), ...current.items],
        asOf: Date.now(),
        stale: false,
        entering: added.slice(0, MAX_ENTERING).map((k) => k.key),
      };
    });
  }, [fetchPage]);

  useEffect(() => {
    live.current = true;
    void loadFirst();
    return () => {
      live.current = false;
    };
  }, [loadFirst]);

  const ready = view.state === 'ready';
  useEffect(() => {
    if (!ready || hidden) return undefined;
    const timer = setInterval(() => void refresh(), ACTIVITY_POLL_MS);
    return () => clearInterval(timer);
  }, [ready, hidden, refresh]);

  const dot =
    view.state === 'loading'
      ? 'checking'
      : view.state === 'ready'
        ? view.stale
          ? 'reconnecting'
          : 'connected'
        : 'not-running';

  return (
    <>
      <div className="al-activity-head">
        <h1 className="al-text-title-1">{S.title}</h1>
        <LiveDot state={dot} />
        {view.state === 'ready' && view.stale ? (
          <span className="al-activity-asof al-text-caption al-muted">
            {S.asOf}{' '}
            <time dateTime={new Date(view.asOf).toISOString()}>{TIME.format(view.asOf)}</time>
          </span>
        ) : null}
      </div>
      {view.state === 'loading' ? (
        <>
          <p className="al-text-body al-muted al-sr-only" role="status">
            {S.loading}
          </p>
          <div aria-hidden="true">
            <Skeleton loading lines={6} label={S.loading} />
          </div>
        </>
      ) : view.state === 'failed' ? (
        <ProblemView problem={view.problem} onRetry={() => void loadFirst()} />
      ) : view.items.length === 0 && view.nextCursor === undefined ? (
        <EmptyState icon="activity" title={S.emptyTitle} prompt={S.emptyPrompt} />
      ) : (
        <>
          <div className="al-activity-chips" role="group" aria-label={S.filterLabel}>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="al-activity-chip al-text-body-sm"
                aria-pressed={filter === f.id ? 'true' : 'false'}
                onClick={() => {
                  setFilter(f.id);
                  // A filter change remounts the rows; none of them replays its entrance.
                  setView((v) => (v.state === 'ready' ? { ...v, entering: [] } : v));
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="al-activity-stage">
            <FilteredList
              key={filter}
              filter={filter}
              items={view.items}
              entering={view.entering}
            />
          </div>
          {view.more !== 'idle' && view.more !== 'loading' ? (
            <ProblemView problem={view.more} onRetry={() => void loadMore(view)} />
          ) : null}
          {view.nextCursor !== undefined && (view.more === 'idle' || view.more === 'loading') ? (
            <div className="al-activity-more">
              <Button
                onClick={() => void loadMore(view)}
                disabled={view.more === 'loading'}
                aria-busy={view.more === 'loading'}
              >
                {view.more === 'loading' ? S.loadingMore : S.showMore}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {/* The server sends no event IDs yet, so there is nothing to list: the panel says so. */}
      <UnderTheHood fields={[]} />
    </>
  );
}

/** The list for one filter: day sections with a sticky header each. It fades in when the filter changes. */
function FilteredList({
  filter,
  items,
  entering,
}: {
  filter: Filter;
  items: readonly ActivityItem[];
  entering: readonly string[];
}): ReactElement {
  const rows = keyed(items).filter((k) => inFilter(k.item, filter));
  const isNew = new Set(entering);
  return (
    <div className="al-activity-list" data-filter={filter}>
      {rows.length === 0 ? (
        <p className="al-text-body al-muted al-activity-none">{S.filterEmpty}</p>
      ) : (
        byDay(rows).map((g) => (
          <section key={g.day} className="al-activity-section">
            <h2 className="al-activity-day al-text-label">{DAY.format(g.at * 1000)}</h2>
            <table className="al-activity-table">
              <caption className="al-sr-only">{`${S.tableLabel}, ${DAY.format(g.at * 1000)}`}</caption>
              <thead className="al-sr-only">
                <tr>
                  <th scope="col">{S.colTime}</th>
                  <th scope="col">{S.colWhat}</th>
                  <th scope="col">{S.colContact}</th>
                  <th scope="col">{S.colStatus}</th>
                </tr>
              </thead>
              <tbody className="al-text-body">
                {g.rows.map((k) => (
                  <Row key={k.key} item={k.item} isNew={isNew.has(k.key)} />
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  );
}

function cursorOf(page: Page): { nextCursor?: string } {
  return page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor };
}
