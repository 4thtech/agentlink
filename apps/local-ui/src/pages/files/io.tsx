// Files: Received and Sent, and the tab strip (MSG-FILES-IO-f; 08 §1; 11 §5.7; design b11 §15,
// §17.3; plan docs/process/proposals/MSG-FILES-IO.md §5).
//
// Read-only lists of what this computer already holds, decrypted only here. Other people's file
// names (and contact names) are untrusted (I-5): shown only inside UntrustedContent as plain text,
// never as a link, never in the page title, never used as a path. The app never opens a received
// file. MSG-FILES-IO-h: a saved file has "Show in Finder" ("Show in folder" off macOS, 11 §5.7),
// which sends only the item ID; the server finds the file in the Inbox folder and asks the OS file
// manager to show it (D-134, no Touch ID). Nothing here ever receives or shows a key, a drop link,
// a token or a path.
import {
  Banner,
  Button,
  CountBadge,
  EmptyState,
  Icon,
  ProgressBar,
  ProofBadge,
  Skeleton,
  StatusChip,
  Surface,
  SuccessMoment,
  UntrustedContent,
  useRowPresence,
} from '@4thtech-io/ui';
import { UnderTheHood } from '../../lazy/hood.js';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { RevealOutcome } from './files-api.js';
import {
  RECEIVED_PATH,
  SENT_PATH,
  loadFeed,
  parseReceived,
  parseSent,
  type Feed,
  type Getter,
  type LoadResult,
  type ReceivedItem,
  type SentItem,
} from './io-api.js';
import { FILES_IO_STRINGS as IO, asOf } from './strings.js';

export type FilesTab = 'received' | 'sent' | 'folders';
const TABS: readonly (readonly [FilesTab, string])[] = [
  ['received', IO.tabReceived],
  ['sent', IO.tabSent],
  ['folders', IO.tabFolders],
];

/** Tabs with the roving tabindex and arrow keys of the ARIA tabs pattern. */
export function FilesTabs({
  tab,
  onTab,
  counts,
}: {
  readonly tab: FilesTab;
  readonly onTab: (next: FilesTab) => void;
  /** Files waiting (to be saved, to be sent): a ticking badge when above zero. */
  readonly counts?: Readonly<Partial<Record<FilesTab, number>>>;
}): ReactElement {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const at = TABS.findIndex(([id]) => id === tab);
    let to: number;
    if (e.key === 'ArrowRight') to = (at + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') to = (at + TABS.length - 1) % TABS.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = TABS.length - 1;
    else return;
    e.preventDefault();
    const next = TABS[to];
    if (next === undefined) return;
    onTab(next[0]);
    refs.current[next[0]]?.focus();
  };
  return (
    <div className="fl-tabs" role="tablist" aria-label={IO.tabsLabel}>
      {TABS.map(([id, label]) => (
        <button
          key={id}
          ref={(el) => {
            refs.current[id] = el;
          }}
          type="button"
          role="tab"
          id={`fl-tab-${id}`}
          aria-selected={tab === id}
          aria-controls="fl-tabpanel"
          tabIndex={tab === id ? 0 : -1}
          className={tab === id ? 'fl-tab is-active' : 'fl-tab'}
          onClick={() => onTab(id)}
          onKeyDown={move}
        >
          {label}
          {(counts?.[id] ?? 0) > 0 ? (
            <CountBadge count={counts?.[id] ?? 0} label={IO.waitingLabel[id]} />
          ) : null}
        </button>
      ))}
    </div>
  );
}

const DAY = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Unix seconds as a `<time>`. */
function When({ at, date }: { readonly at: number; readonly date?: boolean }): ReactElement {
  const d = new Date(at * 1000);
  return <time dateTime={d.toISOString()}>{(date === true ? DATE : DAY).format(d)}</time>;
}

/** Plaintext bytes as the sender stated them, in decimal units. */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[i]}`;
}

const POLL_MS = 5_000;
const POLL_SLOW_MS = 15_000;
const POLL_BACKOFF_AFTER_MS = 2 * 60_000;
const POLL_STOP_MS = 30 * 60_000;
/** A sent file without a receipt after this long stops waiting for one (owner decision 6.1). */
const RECEIPT_WAIT_MS = 24 * 60 * 60_000;

/** Sent, available, and no receipt, but a day has passed: the wait is over. */
const receiptGaveUp = (i: SentItem): boolean =>
  i.status === 'sent' &&
  !i.receipt &&
  i.state === 'available' &&
  Date.now() - i.at * 1000 >= RECEIPT_WAIT_MS;

/** Rows the Sent list keeps re-reading for: queued, or sent and still waiting for a receipt. */
const sentInFlight = (i: SentItem): boolean =>
  i.status === 'queued' ||
  (i.status === 'sent' && !i.receipt && i.state === 'available' && !receiptGaveUp(i));

type FeedState<T> =
  | { readonly phase: 'loading' }
  | { readonly phase: 'not_set_up' }
  | { readonly phase: 'error' }
  | {
      readonly phase: 'ok';
      readonly items: readonly T[];
      readonly next: string | null;
      /** Set when the last refresh failed: the list is the one loaded at this time. */
      readonly staleAt: number | null;
      readonly more: boolean;
      /** IDs of rows that arrived on a refresh while the page was open (at most two). */
      readonly arrived: readonly string[];
    };

/** Loads the first page on mount; "Show more" appends; a failed refresh keeps what is on screen. */
function useFeed<T extends { readonly id: string; readonly at: number }>(
  get: Getter,
  base: string,
  parse: (json: unknown) => Feed<T> | undefined,
  inFlight?: (item: T) => boolean,
): { state: FeedState<T>; retry: () => void; more: () => void } {
  const [state, setState] = useState<FeedState<T>>({ phase: 'loading' });
  // Bumped when the tab comes back, so a polling window that ran out while hidden starts again.
  const [epoch, setEpoch] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (cursor: string | null): Promise<void> => {
      const result: LoadResult<T> = await loadFeed(get, base, cursor, parse);
      if (!alive.current) return;
      setState((prev) => {
        if (result.kind === 'ok') {
          if (cursor === null && prev.phase === 'ok' && result.feed.items.length === 0) {
            // An empty newest page does not say the rows are gone: keep them, marked "as of".
            if (prev.items.length > 0) return { ...prev, staleAt: Date.now(), more: false };
          }
          if (cursor === null && prev.phase === 'ok') {
            // A refresh: the newest page replaces the top; older pages already loaded stay.
            const known = new Set(prev.items.map((i) => i.id));
            const top = result.feed.items;
            const topIds = new Set(top.map((i) => i.id));
            const oldest = top.length === 0 ? 0 : Math.min(...top.map((i) => i.at));
            const rest = prev.items.filter((i) => !topIds.has(i.id) && i.at < oldest);
            return {
              phase: 'ok',
              items: [...top, ...rest],
              next: rest.length > 0 ? prev.next : result.feed.next,
              staleAt: null,
              more: false,
              arrived: top
                .filter((i) => !known.has(i.id))
                .slice(0, 2)
                .map((i) => i.id),
            };
          }
          const before = cursor !== null && prev.phase === 'ok' ? prev.items : [];
          return {
            phase: 'ok',
            items: [...before, ...result.feed.items],
            next: result.feed.next,
            staleAt: null,
            more: false,
            arrived: cursor !== null && prev.phase === 'ok' ? prev.arrived : [],
          };
        }
        if (prev.phase === 'ok') return { ...prev, staleAt: Date.now(), more: false };
        return { phase: result.kind === 'not_set_up' ? 'not_set_up' : 'error' };
      });
    },
    [get, base, parse],
  );

  useEffect(() => {
    void run(null);
  }, [run]);

  // Coming back to the page looks for anything new (no timer, no stream).
  useEffect(() => {
    const onShown = (): void => {
      if (document.visibilityState !== 'visible') return;
      setEpoch((e) => e + 1);
      void run(null);
    };
    document.addEventListener('visibilitychange', onShown);
    return () => document.removeEventListener('visibilitychange', onShown);
  }, [run]);

  // While any row is still moving, look again every few seconds, slower after 2 minutes and not at
  // all after 30 minutes. A hidden tab is not polled; coming back looks once (above).
  const pending = inFlight !== undefined && state.phase === 'ok' && state.items.some(inFlight);
  useEffect(() => {
    if (!pending) return undefined;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      const age = Date.now() - started;
      if (age >= POLL_STOP_MS) return;
      timer = setTimeout(
        () => {
          if (document.visibilityState === 'visible') void run(null);
          arm();
        },
        age >= POLL_BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_MS,
      );
    };
    arm();
    return () => clearTimeout(timer);
  }, [pending, run, epoch]);

  return {
    state,
    retry: () => {
      setState((prev) => (prev.phase === 'ok' ? prev : { phase: 'loading' }));
      void run(null);
    },
    more: () => {
      if (state.phase !== 'ok' || state.next === null) return;
      setState({ ...state, more: true });
      void run(state.next);
    },
  };
}

/** The shared Skeleton (nothing for 400 ms, b11 §15) with the status word kept for screen readers. */
export function FilesSkeleton({ word }: { readonly word: string }): ReactElement {
  return (
    <div className="fl-feed" aria-busy="true">
      <p role="status" className="fl-sr-only">
        {word}
      </p>
      <div aria-hidden="true">
        <Skeleton loading lines={3} className="fl-skeleton" />
      </div>
    </div>
  );
}

function FeedFrame<T extends { readonly id: string; readonly at: number }>({
  feed,
  empty,
  row,
  note,
  card = false,
}: {
  readonly feed: ReturnType<typeof useFeed<T>>;
  readonly empty: { readonly title: string; readonly hint: string; readonly icon: string };
  readonly row: (item: T, arrived: boolean) => ReactElement;
  readonly note?: ReactElement;
  /** The list sits on a raised card (Received: where files land). */
  readonly card?: boolean;
}): ReactElement {
  const { state } = feed;
  if (state.phase === 'loading') return <FilesSkeleton word={IO.loading} />;
  if (state.phase === 'not_set_up') return <Banner tone="info">{IO.notSetUp}</Banner>;
  if (state.phase === 'error') {
    return (
      <div className="fl-feed">
        <Banner tone="warning">{IO.unavailable}</Banner>
        <div className="fl-actions">
          <Button onClick={feed.retry}>{IO.tryAgain}</Button>
        </div>
      </div>
    );
  }
  if (state.items.length === 0) {
    return (
      <EmptyState
        icon={empty.icon}
        title={empty.title}
        action={<p className="al-text-body-sm al-muted">{empty.hint}</p>}
      />
    );
  }
  return (
    <div className="fl-feed">
      {state.staleAt === null ? null : (
        <Banner tone="warning">{asOf(CLOCK.format(new Date(state.staleAt)))}</Banner>
      )}
      {note}
      {card ? (
        <Surface level={2} className="fl-card">
          <ul className="fl-list">
            {state.items.map((item) => row(item, state.arrived.includes(item.id)))}
          </ul>
        </Surface>
      ) : (
        <ul className="fl-list">
          {state.items.map((item) => row(item, state.arrived.includes(item.id)))}
        </ul>
      )}
      {state.next === null ? null : (
        <div className="fl-actions">
          <Button disabled={state.more} onClick={feed.more}>
            {IO.showMore}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A name another party chose: plain text, wrapped, in the recessed well (I-5). */
function Name({ children }: { readonly children: string }): ReactElement {
  return (
    <code className="fl-name al-text-code">
      <bdi>{children}</bdi>
    </code>
  );
}

const NOTE_KEY = 'agentlink.files.untrusted-note';
const noteSeen = (): boolean => {
  try {
    return window.localStorage.getItem(NOTE_KEY) === 'seen';
  } catch {
    return false;
  }
};
const markNoteSeen = (): void => {
  try {
    window.localStorage.setItem(NOTE_KEY, 'seen');
  } catch {
    // The note simply shows again next time.
  }
};

/** The one-time note that file names are other people's words. */
function UntrustedNote(): ReactElement | null {
  const [hidden, setHidden] = useState(noteSeen);
  if (hidden) return null;
  return (
    <div className="fl-note">
      <Banner tone="info">{IO.untrustedNote}</Banner>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          markNoteSeen();
          setHidden(true);
        }}
      >
        {IO.gotIt}
      </Button>
    </div>
  );
}

/** Show in Finder for one saved file (MSG-FILES-IO-h): what to tell the owner after a click. */
export type Reveal = (id: string) => Promise<RevealOutcome>;

const REVEAL_PROBLEM: Readonly<Record<Exclude<RevealOutcome, 'shown'>, string>> = {
  not_found: IO.revealNotFound,
  refused: IO.revealRefused,
  unavailable: IO.revealUnavailable,
  not_opened: IO.revealFailed,
  session_expired: IO.revealSessionExpired,
  offline: IO.revealUnavailable,
  failed: IO.revealFailed,
};

/** macOS has Finder; Windows and Linux get "Show in folder" (11 §5.7). */
function onMac(): boolean {
  try {
    return /^Mac/i.test(navigator.platform);
  } catch {
    return false;
  }
}

function ShowInFinder({
  id,
  reveal,
}: {
  readonly id: string;
  readonly reveal: Reveal;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const click = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    let outcome: RevealOutcome;
    try {
      outcome = await reveal(id);
    } catch {
      outcome = 'failed';
    }
    if (!alive.current) return;
    setBusy(false);
    setProblem(outcome === 'shown' ? undefined : REVEAL_PROBLEM[outcome]);
  };
  return (
    <div className="fl-row-actions">
      <Button size="sm" icon="folder" disabled={busy} onClick={() => void click()}>
        {onMac() ? IO.showInFinder : IO.showInFolder}
      </Button>
      <p role="status" className="al-text-body-sm al-muted">
        {problem ?? ''}
      </p>
    </div>
  );
}

/** A list row on Surface 1; a row that just arrived enters with the shared entrance. */
function Row({
  arrived,
  children,
}: {
  readonly arrived: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const presence = useRowPresence<HTMLLIElement>(true, { isNew: arrived });
  return (
    <li ref={presence.ref} className="fl-row-li">
      {presence.highlight}
      <Surface level={1} className="fl-item">
        {children}
      </Surface>
    </li>
  );
}

function ReceivedRow({
  item,
  reveal,
  arrived,
}: {
  readonly item: ReceivedItem;
  readonly reveal: Reveal;
  readonly arrived: boolean;
}): ReactElement {
  return (
    <Row arrived={arrived}>
      <UntrustedContent from={item.from} fileName={item.name} />
      <p className="fl-meta al-text-body-sm al-muted">
        <When at={item.at} />
        <span>{sizeText(item.size)}</span>
        {item.proof ? <ProofBadge state="recorded" /> : null}
      </p>
      {arrived ? <SuccessMoment kind="file" /> : null}
      {item.state === 'not_saved' ? (
        <ProgressBar label={IO.progressArriving} steps={IO.arrivingSteps} current={0} />
      ) : null}
      {item.state === 'saved' && item.savedName !== null ? (
        <p className="fl-state al-text-body-sm">
          {IO.savedAs} <Name>{item.savedName}</Name>
          <span className="al-text-caption al-muted"> {IO.mayHaveMoved}</span>
        </p>
      ) : null}
      {item.state === 'saved' && item.savedName === null ? (
        <p className="fl-state al-text-body-sm al-muted">{IO.notSaved}</p>
      ) : null}
      {item.state === 'not_saved' ? (
        <p className="fl-state al-text-body-sm al-muted">{IO.notSaved}</p>
      ) : null}
      {item.state === 'expired' ? (
        <p className="fl-state al-text-body-sm al-muted">{IO.expired}</p>
      ) : null}
      {item.state === 'deleted' ? (
        <p className="fl-state al-text-body-sm al-muted">{IO.deleted}</p>
      ) : null}
      {item.state === 'saved' && item.savedName !== null ? (
        <ShowInFinder id={item.id} reveal={reveal} />
      ) : null}
    </Row>
  );
}

function SentRow({ item }: { readonly item: SentItem }): ReactElement {
  const quiet = receiptGaveUp(item);
  return (
    <Row arrived={false}>
      <div className="fl-item-head">
        <Icon name="file" size={16} />
        <Name>{item.name}</Name>
      </div>
      <p className="fl-meta al-text-body-sm al-muted">
        <span>
          {IO.to} <bdi>{item.to}</bdi>
        </span>
        <When at={item.at} />
        <span>{sizeText(item.size)}</span>
      </p>
      {item.status === 'queued' ? (
        <ProgressBar label={IO.progressSending} steps={IO.sendingSteps} current={0} />
      ) : null}
      {item.status === 'sent' && !item.receipt && item.state === 'available' && !quiet ? (
        <ProgressBar label={IO.progressSending} steps={IO.sendingSteps} current={1} />
      ) : null}
      <p className="fl-chips">
        {item.status === 'sent' ? (
          <StatusChip status="sent">{quiet ? IO.statusSentNoReceipt : IO.statusSent}</StatusChip>
        ) : null}
        {item.status === 'queued' ? (
          <StatusChip status="waiting-to-post">{IO.statusQueued}</StatusChip>
        ) : null}
        {item.status === 'not_delivered' ? (
          <StatusChip status="failed">{IO.statusNotDelivered}</StatusChip>
        ) : null}
        {item.receipt ? (
          <span className="fl-receipt is-confirmed" data-receipt="true">
            <Icon name="receipt-delivered" size={14} />
            <span className="al-text-body-sm">{IO.receiptConfirmed}</span>
          </span>
        ) : item.status === 'not_delivered' || quiet ? null : (
          <span className="fl-receipt al-muted" data-receipt="false">
            <Icon name="clock" size={14} />
            <span className="al-text-body-sm">{IO.receiptNone}</span>
          </span>
        )}
      </p>
      {item.status === 'not_delivered' ? (
        <p className="fl-state al-text-body-sm al-muted">{IO.sentNotDelivered}</p>
      ) : null}
      {item.status !== 'not_delivered' && item.state === 'available' && item.expiresAt !== null ? (
        <p className="fl-state al-text-body-sm al-muted">
          {IO.availableUntil} <When at={item.expiresAt} date />
        </p>
      ) : null}
      {item.state === 'expired' ? (
        <p className="fl-state al-text-body-sm al-muted">{IO.sentExpired}</p>
      ) : null}
      {item.state === 'deleted' ? (
        <p className="fl-state al-text-body-sm al-muted">{IO.sentDeleted}</p>
      ) : null}
    </Row>
  );
}

/** What the Under the hood panel may say about a list: how many rows and how big, nothing else. */
function listHood(count: number, bytes: number): unknown[] {
  return [
    { kind: 'count', label: IO.hoodFiles, value: String(count) },
    { kind: 'size', label: IO.hoodSize, value: sizeText(bytes) },
  ];
}

/** Tells the tab strip how many rows wait, whenever the loaded list changes. */
function useWaiting<T>(
  state: FeedState<T>,
  waiting: (item: T) => boolean,
  report?: (n: number) => void,
): void {
  const n = state.phase === 'ok' ? state.items.filter(waiting).length : null;
  useEffect(() => {
    if (n !== null) report?.(n);
  }, [n, report]);
}

export function ReceivedPanel({
  get,
  reveal,
  onWaiting,
}: {
  readonly get: Getter;
  readonly reveal: Reveal;
  readonly onWaiting?: (n: number) => void;
}): ReactElement {
  const feed = useFeed(get, RECEIVED_PATH, parseReceived);
  useWaiting(feed.state, (i: ReceivedItem) => i.state === 'not_saved', onWaiting);
  const items = feed.state.phase === 'ok' ? feed.state.items : [];
  return (
    <>
      <FeedFrame
        feed={feed}
        card
        empty={{ title: IO.receivedEmptyTitle, hint: IO.receivedEmptyHint, icon: 'inbox' }}
        note={<UntrustedNote />}
        row={(item, arrived) => (
          <ReceivedRow key={item.id} item={item} reveal={reveal} arrived={arrived} />
        )}
      />
      {feed.state.phase === 'ok' ? (
        <UnderTheHood
          fields={listHood(
            items.length,
            items.reduce((n, i) => n + i.size, 0),
          )}
        />
      ) : null}
    </>
  );
}

export function SentPanel({
  get,
  onWaiting,
}: {
  readonly get: Getter;
  readonly onWaiting?: (n: number) => void;
}): ReactElement {
  const feed = useFeed(get, SENT_PATH, parseSent, sentInFlight);
  useWaiting(feed.state, (i: SentItem) => i.status === 'queued', onWaiting);
  const items = feed.state.phase === 'ok' ? feed.state.items : [];
  return (
    <>
      <FeedFrame
        feed={feed}
        empty={{ title: IO.sentEmptyTitle, hint: IO.sentEmptyHint, icon: 'arrow-right' }}
        row={(item) => <SentRow key={item.id} item={item} />}
      />
      {feed.state.phase === 'ok' ? (
        <UnderTheHood
          fields={listHood(
            items.length,
            items.reduce((n, i) => n + i.size, 0),
          )}
        />
      ) : null}
    </>
  );
}
