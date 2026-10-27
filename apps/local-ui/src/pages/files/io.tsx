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
  EmptyState,
  Icon,
  ProofBadge,
  StatusChip,
  UntrustedContent,
} from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
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
}: {
  readonly tab: FilesTab;
  readonly onTab: (next: FilesTab) => void;
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
    };

/** Loads the first page on mount; "Show more" appends; a failed refresh keeps what is on screen. */
function useFeed<T>(
  get: Getter,
  base: string,
  parse: (json: unknown) => Feed<T> | undefined,
): { state: FeedState<T>; retry: () => void; more: () => void } {
  const [state, setState] = useState<FeedState<T>>({ phase: 'loading' });
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
          const before = cursor !== null && prev.phase === 'ok' ? prev.items : [];
          return {
            phase: 'ok',
            items: [...before, ...result.feed.items],
            next: result.feed.next,
            staleAt: null,
            more: false,
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

/** Loading shorter than this shows no skeleton rows (b11 §15: no flash). */
const SKELETON_DELAY_MS = 400;

/** Skeleton rows in the shape of the coming list (b11 §15): a status word now, rows after 400 ms. */
function Skeleton(): ReactElement {
  const [rows, setRows] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setRows(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="fl-feed" aria-busy="true">
      <p role="status" className="fl-sr-only">
        {IO.loading}
      </p>
      {rows ? (
        <ul className="fl-list" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="fl-item">
              <span className="fl-skeleton fl-skeleton-name" />
              <span className="fl-skeleton fl-skeleton-meta" />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FeedFrame<T>({
  feed,
  empty,
  row,
  note,
}: {
  readonly feed: ReturnType<typeof useFeed<T>>;
  readonly empty: { readonly title: string; readonly hint: string; readonly icon: string };
  readonly row: (item: T) => ReactElement;
  readonly note?: ReactElement;
}): ReactElement {
  const { state } = feed;
  if (state.phase === 'loading') return <Skeleton />;
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
      <ul className="fl-list">{state.items.map((item) => row(item))}</ul>
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

function ReceivedRow({
  item,
  reveal,
}: {
  readonly item: ReceivedItem;
  readonly reveal: Reveal;
}): ReactElement {
  return (
    <li className="fl-item">
      <UntrustedContent from={item.from} fileName={item.name} />
      <p className="fl-meta al-text-body-sm al-muted">
        <When at={item.at} />
        <span>{sizeText(item.size)}</span>
        {item.proof ? <ProofBadge state="recorded" /> : null}
      </p>
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
    </li>
  );
}

function SentRow({ item }: { readonly item: SentItem }): ReactElement {
  return (
    <li className="fl-item">
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
      <p className="fl-chips">
        {item.status === 'sent' ? <StatusChip status="sent">{IO.statusSent}</StatusChip> : null}
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
        ) : item.status === 'not_delivered' ? null : (
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
    </li>
  );
}

export function ReceivedPanel({
  get,
  reveal,
}: {
  readonly get: Getter;
  readonly reveal: Reveal;
}): ReactElement {
  const feed = useFeed(get, RECEIVED_PATH, parseReceived);
  return (
    <FeedFrame
      feed={feed}
      empty={{ title: IO.receivedEmptyTitle, hint: IO.receivedEmptyHint, icon: 'inbox' }}
      note={<UntrustedNote />}
      row={(item) => <ReceivedRow key={item.id} item={item} reveal={reveal} />}
    />
  );
}

export function SentPanel({ get }: { readonly get: Getter }): ReactElement {
  const feed = useFeed(get, SENT_PATH, parseSent);
  return (
    <FeedFrame
      feed={feed}
      empty={{ title: IO.sentEmptyTitle, hint: IO.sentEmptyHint, icon: 'arrow-right' }}
      row={(item) => <SentRow key={item.id} item={item} />}
    />
  );
}
