// Activity (M1-11c-a1; d1 Local-activity; 08 §1; 11 §6.2; D-116, D-118).
//
// The merged feed of events that are not messages (approvals decided, proofs, blocked senders and
// contacts, rules updated), newest first, from `GET /api/ui/activity`, with "Show more" for the next
// page. Read only: nothing on this page changes anything, so nothing asks for presence.
//
// I-5: every value from the server is rendered as React text, never as HTML, and only after it
// passed the per-kind check below; an entry of another kind is skipped. No IDs, hashes or networks
// reach the view (the server does not send them). Classes only, no inline styles (08 §4 CSP).
import {
  Banner,
  Button,
  EmptyState,
  Fingerprint,
  ProofBadge,
  StatusChip,
  type ProofState,
} from '@4thtech-io/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../api/client.js';
import './activity.css';
import { ACTIVITY_STRINGS as S } from './strings.js';

const PATH = '/api/ui/activity';
const PAGE_SIZE = 20;

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

const TIME = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

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

function Row({ item }: { item: ActivityItem }): ReactElement {
  const date = new Date(item.at * 1000);
  const { what, contact, status } = describeItem(item);
  return (
    <tr>
      <td className="al-activity-time al-text-code">
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
    };

export interface ActivityPageProps {
  /** The API client; the app's default one when absent (tests pass their own). */
  readonly api?: ApiClient;
}

export function ActivityPage({ api }: ActivityPageProps): ReactElement {
  const client = useRef<ApiClient>(api ?? createApiClient());
  const [view, setView] = useState<View>({ state: 'loading' });
  const live = useRef(true);

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
        : { state: 'ready', items: page.items, ...cursorOf(page), more: 'idle' },
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
              items: [...current.items, ...page.items],
              ...cursorOf(page),
              more: 'idle',
            },
      );
    },
    [fetchPage],
  );

  useEffect(() => {
    live.current = true;
    void loadFirst();
    return () => {
      live.current = false;
    };
  }, [loadFirst]);

  return (
    <>
      <div className="al-activity-head">
        <h1 className="al-text-title-1">{S.title}</h1>
      </div>
      {view.state === 'loading' ? (
        <p className="al-text-body al-muted" role="status">
          {S.loading}
        </p>
      ) : view.state === 'failed' ? (
        <ProblemView problem={view.problem} onRetry={() => void loadFirst()} />
      ) : view.items.length === 0 && view.nextCursor === undefined ? (
        <EmptyState icon="activity" title={S.emptyTitle} prompt={S.emptyPrompt} />
      ) : (
        <>
          <div className="al-activity-wrap">
            <table className="al-activity-table">
              <caption className="al-sr-only">{S.tableLabel}</caption>
              <thead>
                <tr className="al-text-label">
                  <th scope="col">{S.colTime}</th>
                  <th scope="col">{S.colWhat}</th>
                  <th scope="col">{S.colContact}</th>
                  <th scope="col">{S.colStatus}</th>
                </tr>
              </thead>
              <tbody className="al-text-body">
                {view.items.map((item, i) => (
                  // Append-only list: the position is a stable key, and no ID is needed in the page.
                  <Row key={i} item={item} />
                ))}
              </tbody>
            </table>
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
    </>
  );
}

function cursorOf(page: Page): { nextCursor?: string } {
  return page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor };
}
