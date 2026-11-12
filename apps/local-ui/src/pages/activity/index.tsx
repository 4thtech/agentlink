// Activity (M1-11c-a1; d1 Local-activity; 08 §1; 11 §6.2; D-116, D-118; UX1113 WP-A2, design-1112 §7).
//
// Everything that was decided or changed in the owner's name, newest first, from
// `GET /api/ui/activity`, with "Show earlier" for the next page. Read only: nothing on this page
// changes anything, so nothing asks for presence.
//
// Every row is one plain sentence (`time · icon · sentence + one grey line · pill · chevron`), never a
// table cell with a dash. A person is a reference (`contactId`); the page names them with its own read
// of `GET /api/ui/contacts`, and a person it cannot name gets neutral words ("a contact"). Names and
// file names are text in <bdi> (I-5); every value from the server passes the per-kind check in
// clean.ts first and an entry of another kind is skipped. No IDs, hashes or networks reach the view.
// Classes only, no inline styles (08 §4 CSP).
//
// UI-REFRESH-h: day groups with sticky headers, a live dot, and a refresh every 20 s whose new rows
// enter at the top (at most two with the highlight). Skeleton on the first load.
import {
  Banner,
  Button,
  EmptyState,
  Icon,
  LiveDot,
  Segmented,
  Skeleton,
  useRowPresence,
  useVisibilityPause,
} from '@4thtech-io/ui';
import { UnderTheHood } from '../../lazy/hood.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../api/client.js';
import { LIST_PATH, parseList } from '../contacts/data.js';
import { cleanName } from '../home/person-name.js';
import './activity.css';
import {
  WEEK_SECONDS,
  formatUsd,
  inCount,
  inFilter,
  parseItem,
  render,
  sumUsd,
  type ActivityItem,
  type CountKey,
  type Filter,
  type NameOf,
  type Part,
  type Rendered,
} from './clean.js';
import { ACTIVITY_COPY as S } from './strings.js';

export type { ActivityItem } from './clean.js';

const PATH = '/api/ui/activity';
const PAGE_SIZE = 20;
/** How often the first page is fetched again while the tab is visible. */
export const ACTIVITY_POLL_MS = 20_000;
/** However many rows arrive at once, only this many enter with the highlight. */
const MAX_ENTERING = 2;

interface Page {
  readonly items: readonly ActivityItem[];
  readonly nextCursor?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

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
const FULL_TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: S.filterAll },
  { id: 'approvals', label: S.filterApprovals },
  { id: 'proofs', label: S.filterProofs },
  { id: 'people', label: S.filterPeople },
  { id: 'safety', label: S.filterSafety },
];

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

const dayKey = (d: Date): string =>
  `${String(d.getFullYear())}-${String(d.getMonth())}-${String(d.getDate())}`;

/** The entries grouped by local day, in the order given. */
function byDay(rows: readonly Keyed[]): { day: string; at: number; rows: Keyed[] }[] {
  const groups: { day: string; at: number; rows: Keyed[] }[] = [];
  for (const row of rows) {
    const day = dayKey(new Date(row.item.at * 1000));
    const last = groups[groups.length - 1];
    if (last !== undefined && last.day === day) last.rows.push(row);
    else groups.push({ day, at: row.item.at, rows: [row] });
  }
  return groups;
}

function dayTitle(at: number): string {
  const d = new Date(at * 1000);
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const text = DAY.format(d);
  if (dayKey(d) === dayKey(now)) return `${S.today} · ${text}`;
  if (dayKey(d) === dayKey(yesterday)) return `${S.yesterday} · ${text}`;
  return text;
}

/** A sentence: names and file names are text, isolated so they cannot reorder what is around them. */
function Sentence({ parts }: { parts: readonly Part[] }): ReactElement {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : 'name' in p ? (
          <bdi key={i} dir="auto" className="al-act-name">
            {cleanName(p.name)}
          </bdi>
        ) : (
          <bdi key={i} dir="auto" className="al-act-name">
            {cleanName(p.file)}
          </bdi>
        ),
      )}
    </>
  );
}

function Row({
  item,
  isNew,
  nameOf,
  open,
  onToggle,
  id,
}: {
  item: ActivityItem;
  isNew: boolean;
  nameOf: NameOf;
  open: boolean;
  onToggle: () => void;
  id: string;
}): ReactElement {
  const date = new Date(item.at * 1000);
  const r: Rendered = render(item, nameOf, `${DAY.format(date)}, ${FULL_TIME.format(date)}`);
  const presence = useRowPresence<HTMLLIElement>(true, { isNew });
  return (
    <li
      ref={presence.ref}
      className="al-act-row"
      data-open={open ? 'true' : 'false'}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) onToggle();
      }}
    >
      <button
        type="button"
        className="al-act-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className="al-act-time al-text-code">
          {presence.highlight}
          <time dateTime={date.toISOString()}>{TIME.format(date)}</time>
        </span>
        <span className={`al-act-icon al-tone-${r.tone}`} aria-hidden="true">
          <Icon name={r.icon} size={16} />
        </span>
        <span className="al-act-text">
          <span className="al-act-sentence al-text-body">
            <Sentence parts={r.sentence} />
          </span>
          <span className="al-act-grey al-text-body-sm">{r.grey}</span>
        </span>
        <span className={`al-act-pill al-tone-${r.tone} al-text-label`}>{r.pill}</span>
        <span className="al-act-chevron" aria-hidden="true">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
        </span>
      </button>
      {open ? (
        <dl id={id} className="al-act-facts al-text-body">
          {r.facts.map((f) => (
            <div key={f.label} className="al-act-fact">
              <dt className="al-muted">{f.label}</dt>
              <dd>
                <Sentence parts={f.parts} />
              </dd>
            </div>
          ))}
          <div className="al-act-fact">
            <dt className="al-muted">{S.rowResult}</dt>
            <dd>
              <a className="al-link" href={r.link.href}>
                {r.link.label}
              </a>
            </dd>
          </div>
        </dl>
      ) : null}
    </li>
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

const COUNTS: readonly { key: CountKey; label: string; sub: string }[] = [
  { key: 'approved', label: S.countApproved, sub: S.countApprovedSub },
  { key: 'rules', label: S.countRules, sub: S.countRulesSub },
  { key: 'blocked', label: S.countBlocked, sub: S.countBlockedSub },
  { key: 'proofs', label: S.countProofs, sub: '' },
];

export function ActivityPage({ api }: ActivityPageProps): ReactElement {
  const client = useRef<ApiClient>(api ?? createApiClient());
  const [view, setView] = useState<View>({ state: 'loading' });
  const [filter, setFilter] = useState<Filter>('all');
  const [count, setCount] = useState<CountKey | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState<string | undefined>(undefined);
  const [people, setPeople] = useState<ReadonlyMap<string, string>>(new Map());
  const live = useRef(true);
  const hidden = useVisibilityPause();

  /** The people's names, as the people page shows them; a failure leaves every person unnamed. */
  const loadPeople = useCallback(async (): Promise<void> => {
    const result = await client.current.get<unknown>(LIST_PATH);
    if (!live.current || result.kind !== 'ok') return;
    const list = parseList(result.data);
    if (list.kind !== 'ok') return;
    setPeople(new Map(list.contacts.map((c) => [c.ref.toLowerCase(), c.name])));
  }, []);

  const fetchPage = useCallback(async (cursor?: string): Promise<Page | Problem> => {
    const query = `?limit=${String(PAGE_SIZE)}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const result = await client.current.get<unknown>(`${PATH}${query}`);
    if (result.kind !== 'ok') return problemOf(result);
    return parsePage(result.data) ?? 'error';
  }, []);

  const loadFirst = useCallback(async (): Promise<void> => {
    setView({ state: 'loading' });
    const [page] = await Promise.all([fetchPage(), loadPeople()]);
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
  }, [fetchPage, loadPeople]);

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
      void loadPeople();
      return {
        ...current,
        items: [...added.map((k) => k.item), ...current.items],
        asOf: Date.now(),
        stale: false,
        entering: added.slice(0, MAX_ENTERING).map((k) => k.key),
      };
    });
  }, [fetchPage, loadPeople]);

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

  const nameOf = useCallback<NameOf>(
    (id) => (id === undefined ? undefined : people.get(id.toLowerCase())),
    [people],
  );

  const items = view.state === 'ready' ? view.items : undefined;
  const totals = useMemo(() => {
    const since = Math.floor(Date.now() / 1000) - WEEK_SECONDS;
    const week = (items ?? []).filter((i) => i.at >= since);
    const proofs = week.filter((i) => inCount(i, 'proofs'));
    const credits = sumUsd(
      proofs.flatMap((i) => (i.kind === 'proof' && i.costUsd !== undefined ? [i.costUsd] : [])),
    );
    return {
      since,
      n: {
        approved: week.filter((i) => inCount(i, 'approved')).length,
        rules: week.filter((i) => inCount(i, 'rules')).length,
        blocked: week.filter((i) => inCount(i, 'blocked')).length,
        proofs: proofs.length,
      },
      credits,
    };
  }, [items]);

  const dot =
    view.state === 'loading'
      ? 'checking'
      : view.state === 'ready'
        ? view.stale
          ? 'reconnecting'
          : 'connected'
        : 'not-running';

  const pickFilter = (next: Filter): void => {
    setFilter(next);
    setCount(undefined);
    setOpenKey(undefined);
    setView((cur) => (cur.state === 'ready' ? { ...cur, entering: [] } : cur));
  };

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
      <p className="al-text-body al-muted al-activity-lead">{S.lead}</p>
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
          <div className="al-act-counts" role="group" aria-label={S.countsLabel}>
            {COUNTS.map((c) => {
              const sub =
                c.key === 'proofs'
                  ? totals.credits === '0'
                    ? S.countProofsNoCredits
                    : S.countProofsCredits.replace('{usd}', formatUsd(totals.credits))
                  : c.sub;
              return (
                <button
                  key={c.key}
                  type="button"
                  className="al-act-count"
                  aria-pressed={count === c.key}
                  onClick={() => {
                    setCount(count === c.key ? undefined : c.key);
                    setFilter('all');
                    setOpenKey(undefined);
                  }}
                >
                  <span className="al-act-count-n">{totals.n[c.key]}</span>
                  <span className="al-act-count-label">{c.label}</span>
                  <span className="al-act-count-sub al-muted al-text-body-sm">{sub}</span>
                </button>
              );
            })}
          </div>
          <div className="al-activity-filter">
            <Segmented
              label={S.filterLabel}
              value={filter}
              onChange={(v) => pickFilter(FILTERS.find((f) => f.id === v)?.id ?? 'all')}
              options={FILTERS.map((f) => ({ value: f.id, label: f.label }))}
            />
            <label className="al-act-search">
              <Icon name="search" size={16} />
              <input
                type="search"
                className="al-input"
                aria-label={S.searchLabel}
                placeholder={S.searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <div className="al-activity-stage">
            <FilteredList
              key={`${filter}-${count ?? ''}`}
              filter={filter}
              count={count}
              since={totals.since}
              query={query}
              items={view.items}
              entering={view.entering}
              nameOf={nameOf}
              openKey={openKey}
              onToggle={(k) => setOpenKey((cur) => (cur === k ? undefined : k))}
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
  count,
  since,
  query,
  items,
  entering,
  nameOf,
  openKey,
  onToggle,
}: {
  filter: Filter;
  count: CountKey | undefined;
  since: number;
  query: string;
  items: readonly ActivityItem[];
  entering: readonly string[];
  nameOf: NameOf;
  openKey: string | undefined;
  onToggle: (key: string) => void;
}): ReactElement {
  const needle = query.trim().toLowerCase();
  const rows = keyed(items).filter((k) => {
    if (count !== undefined && !(inCount(k.item, count) && k.item.at >= since)) return false;
    if (!inFilter(k.item, filter)) return false;
    return needle === '' || render(k.item, nameOf, '').search.includes(needle);
  });
  const isNew = new Set(entering);
  const empty: ReactNode = needle !== '' ? S.searchEmpty : S.filterEmpty;
  return (
    <div className="al-activity-list" data-filter={filter}>
      {rows.length === 0 ? (
        <p className="al-text-body al-muted al-activity-none">{empty}</p>
      ) : (
        byDay(rows).map((g) => (
          <section key={g.day} className="al-activity-section" aria-label={dayTitle(g.at)}>
            <h2 className="al-activity-day al-text-label">{dayTitle(g.at)}</h2>
            <ul className="al-act-list" aria-label={`${S.tableLabel}, ${dayTitle(g.at)}`}>
              {g.rows.map((k, i) => (
                <Row
                  key={k.key}
                  id={`al-act-${String(g.at)}-${String(i)}`}
                  item={k.item}
                  isNew={isNew.has(k.key)}
                  nameOf={nameOf}
                  open={openKey === k.key}
                  onToggle={() => onToggle(k.key)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function cursorOf(page: Page): { nextCursor?: string } {
  return page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor };
}
