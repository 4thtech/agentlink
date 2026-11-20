// NET-UI-A (0.5.14; owner wireframe frames A1-A5; D-157): Advanced › Message network, the live view of
// the servers the app sends through, for Under the hood only (the page mounts it only while the
// switch is on; nothing here shows without it). Read-only. Server cards (host, roles, health, times,
// 24 h counts, last OK), the contact reach summary and an expand that lists contacts' servers.
//
// - One read, `GET /api/ui/network` (`?contacts=hosts` only while the expand is open). The backend
//   probes at most once per NETWORK_POLL_MS, so the page reads at most that often while the tab is
//   visible, plus when the stream's `network` event arrives (api/live.ts; never faster than
//   NETWORK_EVENT_MIN_MS).
// - Contacts' hosts are inbound content (I-5): plain text only, never a link or markup; the contact
//   `ref` is joined to a name through `/api/ui/contacts` (the name rule) and never shown.
// - Health is a dot that differs by shape as well as colour, always with its word beside it.
//   Proposed defaults, pending the owner's confirmation (easy to change: TONES and DOT_SHAPE):
//   "can't reach" and "slow" use the warning tone, not danger.
import { Banner, Button, formatContactName, Skeleton } from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type RefObject,
} from 'react';
import { createApiClient, type ApiResult } from '../../../api/client.js';
import { agoText, getLive, subscribeLive } from '../../../api/live.js';
import { parseList, LIST_PATH as CONTACTS_PATH, type ContactRow } from '../../contacts/data.js';
import {
  NETWORK_CHANGED,
  OWN_VISIBLE,
  NETWORK_CONTACTS_PATH,
  NETWORK_EVENT_MIN_MS,
  NETWORK_PATH,
  NETWORK_POLL_MS,
  formatMs,
  isProblem,
  parseNetwork,
  problemsFirst,
  summarize,
  type NetworkAnswer,
  type NetworkServer,
  type NetworkSummary,
} from './data.js';
import { DOT_SHAPE, NetworkDiagram } from './diagram.js';
import { ServersEntry } from './servers/entry.js';
import { NETWORK_STRINGS as S } from './strings.js';
import './network.css';

/** The banner tone per headline state. Warning, never danger (danger is for integrity failures). */
const TONES: Readonly<Record<NetworkSummary, 'info' | 'warning' | 'neutral' | undefined>> = {
  checking: 'neutral',
  empty: 'neutral',
  healthy: undefined,
  one_slow: 'warning',
  some_slow: 'warning',
  one_down: 'warning',
  some_down: 'warning',
  all_down: 'warning',
};

export interface NetworkViewProps {
  /** The network read (default: production); `contacts` asks for the expanded answer. */
  readonly read?: (contacts: boolean) => Promise<ApiResult<unknown>>;
  /** The contacts read that joins a `ref` to a name (default: production). */
  readonly readContacts?: () => Promise<ApiResult<unknown>>;
  /** Unix seconds (default: the clock). */
  readonly now?: () => number;
  /** Whether this computer is online (default: the browser's own flag). */
  readonly online?: () => boolean;
  readonly pollMs?: number;
  /** This ID's label for the diagram (default: the live ID list's current ID). */
  readonly agentLabel?: string;
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly last?: NetworkAnswer }
  | { readonly kind: 'ok'; readonly answer: NetworkAnswer };

/** A server that took messages this recently and fails a fresh check gets downRecentNote. */
const RECENT_OK_SECONDS = 600;

/** After a failed `?contacts=hosts` read, the diagram shows servers alone for this long. */
const HOSTS_RETRY_MS = 60_000;

const api = createApiClient();
const defaultRead = (contacts: boolean): Promise<ApiResult<unknown>> =>
  api.get(contacts ? NETWORK_CONTACTS_PATH : NETWORK_PATH);
const defaultReadContacts = (): Promise<ApiResult<unknown>> => api.get(CONTACTS_PATH);
const defaultNow = (): number => Math.floor(Date.now() / 1000);
const defaultOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine;

const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

const contactName = (c: ContactRow): string =>
  formatContactName(
    c.nameSource === 'owner'
      ? { alias: c.name }
      : { name: c.name, ...(c.fingerprint === undefined ? {} : { fingerprint: c.fingerprint }) },
  ).text;

export function NetworkView({
  read = defaultRead,
  readContacts = defaultReadContacts,
  now = defaultNow,
  online = defaultOnline,
  pollMs = NETWORK_POLL_MS,
  agentLabel,
}: NetworkViewProps): ReactElement {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [oldOpen, setOldOpen] = useState(false);
  const listTop = useRef<HTMLDivElement>(null);
  const reachTop = useRef<HTMLDivElement>(null);
  const [names, setNames] = useState<ReadonlyMap<string, string> | undefined>(undefined);
  const [, redraw] = useState(0);
  const liveIds = useSyncExternalStore(subscribeLive, getLive);
  const idLabel = agentLabel ?? liveIds.agents.find((a) => a.current)?.label;
  const last = useRef<NetworkAnswer | undefined>(undefined);
  const lastReadAt = useRef(0);
  const busy = useRef<(() => boolean) | undefined>(undefined);
  const hostsRetryAt = useRef(0);

  const attempt = useCallback(
    async (contacts: boolean): Promise<NetworkAnswer | undefined> => {
      try {
        const res = await read(contacts);
        return res.kind === 'ok' ? parseNetwork(res.data) : undefined;
      } catch {
        return undefined;
      }
    },
    [read],
  );
  const refresh = useCallback(
    async (live: () => boolean): Promise<void> => {
      // One read at a time, but a read whose effect has ended never blocks the next one.
      if (busy.current?.() === true) return;
      busy.current = live;
      lastReadAt.current = Date.now();
      try {
        // The diagram needs contacts' hosts (`?contacts=hosts`); the view only mounts under the hood and
        // reads only while the tab is visible. If that read fails, ask once without them (the diagram
        // then shows the server column alone) and try the hosts again after HOSTS_RETRY_MS.
        const tryHosts = expanded || Date.now() >= hostsRetryAt.current;
        let answer = await attempt(tryHosts);
        if (!live()) return;
        if (answer === undefined && tryHosts && !expanded) {
          hostsRetryAt.current = Date.now() + HOSTS_RETRY_MS;
          answer = await attempt(false);
          if (!live()) return;
        }
        if (answer === undefined) {
          setLoad({
            kind: 'failed',
            ...(last.current === undefined ? {} : { last: last.current }),
          });
        } else {
          last.current = answer;
          setLoad({ kind: 'ok', answer });
        }
      } catch {
        if (live()) {
          setLoad({
            kind: 'failed',
            ...(last.current === undefined ? {} : { last: last.current }),
          });
        }
      } finally {
        if (busy.current === live) busy.current = undefined;
      }
    },
    [attempt, expanded],
  );

  useEffect(() => {
    let alive = true;
    const live = (): boolean => alive;
    const visible = (): boolean =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden';
    void refresh(live);
    const poll = setInterval(() => {
      if (visible()) void refresh(live);
      else redraw((n) => n + 1);
    }, pollMs);
    // The stream's `network` event: read again, but never faster than NETWORK_EVENT_MIN_MS.
    const onEvent = (): void => {
      if (visible() && Date.now() - lastReadAt.current >= NETWORK_EVENT_MIN_MS) void refresh(live);
    };
    const onVisible = (): void => {
      if (visible() && Date.now() - lastReadAt.current >= pollMs) void refresh(live);
    };
    window.addEventListener(NETWORK_CHANGED, onEvent);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(poll);
      window.removeEventListener(NETWORK_CHANGED, onEvent);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, pollMs]);

  // The diagram is drawn for a running or paused ID that has servers; contacts' hosts are asked for
  // only then (the fetch below), and the picture falls back to the server column when they fail.
  const shown = load.kind === 'ok' ? load.answer : load.kind === 'failed' ? load.last : undefined;
  const diagramOn =
    shown !== undefined &&
    (shown.agent === 'running' || shown.agent === 'paused') &&
    shown.servers.length > 0;
  const wantContacts = diagramOn && shown.contacts.total > 0;
  // Names for the expanded list and the diagram: one read of the contacts the Contacts page uses.
  useEffect(() => {
    if (!(expanded || wantContacts) || names !== undefined) return;
    let alive = true;
    readContacts().then(
      (res) => {
        if (!alive) return;
        const parsed = res.kind === 'ok' ? parseList(res.data) : undefined;
        setNames(
          new Map(
            parsed?.kind === 'ok'
              ? parsed.contacts.map((c) => [c.ref, contactName(c)] as const)
              : [],
          ),
        );
      },
      () => {
        if (alive) setNames(new Map());
      },
    );
    return () => {
      alive = false;
    };
  }, [expanded, wantContacts, names, readContacts]);

  if (load.kind === 'loading') {
    return (
      <section className="nw" aria-label={S.serversHeading}>
        <Skeleton loading lines={3}>
          {null}
        </Skeleton>
      </section>
    );
  }
  const answer = load.kind === 'ok' ? load.answer : load.last;
  if (answer === undefined) {
    return (
      <section className="nw" aria-label={S.serversHeading}>
        <p className="al-text-body al-muted">{S.noAnswer}</p>
      </section>
    );
  }
  const clock = now();
  const offline = !online();
  return (
    <section className="nw" aria-label={S.serversHeading} data-agent={answer.agent}>
      {/* The network diagram (owner's three-column design): a separate card in its slot. */}
      <div className="nw-diagram-slot" data-slot="network-diagram" hidden={!diagramOn}>
        {diagramOn ? (
          <NetworkDiagram
            answer={answer}
            names={names}
            agentLabel={idLabel}
            onMoreServers={() => {
              setShowAll(true);
              setOldOpen(true);
              listTop.current?.scrollIntoView?.({ block: 'nearest' });
            }}
            onMoreContacts={() => {
              setExpanded(true);
              reachTop.current?.scrollIntoView?.({ block: 'nearest' });
            }}
          />
        ) : null}
      </div>
      <div className="nw-head">
        <h2 className="al-text-title-3">{S.serversHeading}</h2>
        {answer.mode === null ? null : (
          // NET-VIEW-0514-1: a static status chip, not the shell's `.al-chip` (the agent switcher's
          // pill button). It only names the mode: nothing here looks clickable.
          <span className="nw-mode al-text-body-sm">
            {answer.mode === 'automatic' ? S.modeAutomatic : S.modeCustom}
          </span>
        )}
      </div>
      {load.kind === 'failed' ? <p className="al-text-body al-muted">{S.noAnswer}</p> : null}
      {answer.updateWouldDrop > 0 ? (
        <Banner tone="warning" title={S.dropTitle}>
          {S.drop(answer.updateWouldDrop)}
        </Banner>
      ) : null}
      <Headline answer={answer} offline={offline} />
      <div ref={listTop}>
        <Servers
          answer={answer}
          now={clock}
          open={open}
          onToggle={(host) => {
            setOpen((cur) => {
              const next = new Set(cur);
              if (!next.delete(host)) next.add(host);
              return next;
            });
          }}
          showAll={showAll}
          onShowAll={() => {
            setShowAll((v) => !v);
          }}
          oldOpen={oldOpen}
          onOld={() => {
            setOldOpen((v) => !v);
          }}
        />
      </div>
      {answer.agent === 'needs_setup' || answer.agent === 'not_running' ? null : (
        <Reach
          top={reachTop}
          answer={answer}
          expanded={expanded}
          onToggle={() => {
            setExpanded((v) => !v);
          }}
          names={names}
          offline={offline}
        />
      )}
      {answer.checkedAt === null || answer.agent !== 'running' ? null : (
        <p className="al-text-body-sm al-muted nw-checked">
          {S.lastChecked(agoText(answer.checkedAt, clock))}
        </p>
      )}
      <ServersEntry />
    </section>
  );
}

function Headline({
  answer,
  offline,
}: {
  readonly answer: NetworkAnswer;
  readonly offline: boolean;
}): ReactElement | null {
  if (answer.agent === 'needs_setup') {
    return (
      <Banner tone="neutral" title={S.needsSetupTitle}>
        {S.needsSetup}
      </Banner>
    );
  }
  if (answer.agent === 'not_running') {
    return (
      <Banner tone="neutral" title={S.notRunningTitle}>
        {S.notRunning}
      </Banner>
    );
  }
  if (answer.agent === 'paused') {
    return (
      <Banner tone="neutral" title={S.pausedTitle}>
        {S.paused}
      </Banner>
    );
  }
  if (offline) {
    const at =
      answer.checkedAt === null ? undefined : CLOCK.format(new Date(answer.checkedAt * 1000));
    return (
      <Banner tone="offline" title={S.offlineTitle}>
        {S.offline(at)}
      </Banner>
    );
  }
  const summary = summarize(answer);
  const own = answer.servers.filter((s) => s.kind === 'own');
  const slow = own.filter((s) => s.state === 'slow').length;
  const isDown = (s: NetworkServer): boolean => s.state === 'unreachable' || s.state === 'blocked';
  const down = own.filter(isDown).length;
  const oldDown = answer.servers.filter((s) => s.kind === 'legacy' && isDown(s)).length;
  const old = oldDown === 0 ? '' : ` ${S.oldDown(oldDown)}`;
  // A message counts as sent once MIN_ACKS (2) servers accept it: with fewer working, it waits.
  const sending = own.length - down >= 2 ? S.stillSending : S.mayWait;
  const tone = TONES[summary];
  switch (summary) {
    case 'checking':
      return (
        <Banner tone={tone ?? 'neutral'} title={S.checkingTitle}>
          {S.checking}
        </Banner>
      );
    case 'empty':
      return <p className="al-text-body al-muted">{S.noServers}</p>;
    case 'healthy':
      return (
        <p className="al-text-body al-muted nw-ok">
          {oldDown === 0 ? S.allHealthy : `${S.ownHealthy}${old}`}
        </p>
      );
    case 'one_slow':
      return (
        <Banner tone={tone ?? 'warning'} title={S.oneSlowTitle}>
          {`${S.oneSlow}${old}`}
        </Banner>
      );
    case 'some_slow':
      return (
        <Banner tone={tone ?? 'warning'} title={S.someSlowTitle(slow)}>
          {`${S.someSlow}${old}`}
        </Banner>
      );
    case 'one_down':
      return (
        <Banner tone={tone ?? 'warning'} title={S.oneDownTitle}>
          {`${sending}${old}`}
        </Banner>
      );
    case 'some_down':
      return (
        <Banner tone={tone ?? 'warning'} title={S.someDownTitle(down)}>
          {`${sending}${old}`}
        </Banner>
      );
    case 'all_down':
      return (
        <Banner tone={tone ?? 'warning'} title={S.allDownTitle}>
          {S.allDown}
        </Banner>
      );
  }
}

function Chevron(): ReactElement {
  return <span className="nw-chev" aria-hidden="true" />;
}

/** The servers: problems first, own servers folded after OWN_VISIBLE, old read-only ones in a group. */
function Servers({
  answer,
  now,
  open,
  onToggle,
  showAll,
  onShowAll,
  oldOpen,
  onOld,
}: {
  readonly answer: NetworkAnswer;
  readonly now: number;
  readonly open: ReadonlySet<string>;
  readonly onToggle: (host: string) => void;
  readonly showAll: boolean;
  readonly onShowAll: () => void;
  readonly oldOpen: boolean;
  readonly onOld: () => void;
}): ReactElement | null {
  const ordered = problemsFirst(answer.servers);
  const own = ordered.filter((s) => s.kind === 'own');
  const old = ordered.filter((s) => s.kind === 'legacy');
  // A server with a problem is never behind "Show all": only the healthy ones fold.
  const limit = showAll ? own.length : Math.max(OWN_VISIBLE, own.filter(isProblem).length);
  const shown = own.slice(0, limit);
  const toggle = own.length > shown.length || (showAll && own.length > OWN_VISIBLE);
  const oldId = useId();
  const oldDown = old.filter(isProblem).length;
  const until =
    answer.legacyReadUntil === null
      ? undefined
      : DAY.format(new Date(answer.legacyReadUntil * 1000));
  const row = (s: NetworkServer): ReactElement => (
    <ServerCard
      key={s.host}
      server={s}
      answer={answer}
      now={now}
      open={open.has(s.host)}
      onToggle={() => {
        onToggle(s.host);
      }}
    />
  );
  if (own.length + old.length === 0) return null;
  return (
    <>
      {own.length === 0 ? null : (
        <ul className="nw-list">
          {shown.map(row)}
          {toggle ? (
            <li className="nw-srv">
              <div>
                <Button size="sm" aria-expanded={showAll} onClick={onShowAll}>
                  {showAll ? S.showFewerServers : S.showAllServers(own.length)}
                </Button>
              </div>
            </li>
          ) : null}
        </ul>
      )}
      {old.length === 0 ? null : (
        <ul className="nw-list">
          <li className="nw-srv is-fold is-old">
            <button
              type="button"
              className="nw-srv-top nw-srv-btn"
              aria-expanded={oldOpen}
              aria-controls={oldId}
              onClick={onOld}
            >
              <span className="nw-host al-text-body-sm">{S.oldGroup(old.length, until)}</span>
              {oldDown === 0 ? null : (
                <span className="nw-state al-text-body-sm">{S.oldGroupDown(oldDown)}</span>
              )}
              <Chevron />
            </button>
          </li>
          {oldOpen ? (
            <li id={oldId} className="nw-fold">
              <ul>{old.map(row)}</ul>
            </li>
          ) : null}
        </ul>
      )}
    </>
  );
}

/** A 24 h bar of accepted against failed, from the counts the route returns (never inline styles). */
function Bar24({
  ok,
  failed,
}: {
  readonly ok: number;
  readonly failed: number;
}): ReactElement | null {
  const total = ok + failed;
  if (total === 0) return null;
  const pct = failed === 0 ? 100 : Math.min(99, Math.round((ok / total) * 100));
  return (
    <svg
      className="nw-bar"
      viewBox="0 0 100 4"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      data-bar24=""
    >
      <rect className="nw-bar-ok" x={0} y={0} width={pct} height={4} />
      <rect className="nw-bar-bad" x={pct} y={0} width={100 - pct} height={4} />
    </svg>
  );
}

function ServerCard({
  server: s,
  answer,
  now,
  open,
  onToggle,
}: {
  readonly server: NetworkServer;
  readonly answer: NetworkAnswer;
  readonly now: number;
  readonly open: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  const detailId = useId();
  const legacy = s.kind === 'legacy';
  const role = legacy
    ? answer.legacyReadUntil === null
      ? S.oldServer
      : S.oldServerUntil(DAY.format(new Date(answer.legacyReadUntil * 1000)))
    : s.sends
      ? S.sendsAndReads
      : S.oldServer;
  const times = [
    s.connectMs === null ? undefined : S.connect(formatMs(s.connectMs)),
    s.roundTripMs === null ? undefined : S.roundTrip(formatMs(s.roundTripMs)),
  ].filter((t): t is string => t !== undefined);
  const usedBy =
    s.contacts ??
    (answer.contactHosts === undefined
      ? null
      : answer.contactHosts.filter((c) => c.hosts.includes(s.host)).length);
  const counted = s.publishedOk + s.publishedFailed + s.received > 0;
  const quick = s.roundTripMs ?? s.connectMs;
  const note =
    s.state === 'slow'
      ? S.slowNote
      : s.state === 'unreachable'
        ? // NET-VIEW-0514-1: "Can't reach" next to "Last worked just now" is explained, not left as is.
          s.lastOkAt !== null && now - s.lastOkAt <= RECENT_OK_SECONDS
          ? S.downRecentNote
          : legacy
            ? S.oldDownNote
            : S.downNote
        : s.state === 'blocked'
          ? S.blockedNote
          : undefined;
  return (
    <li className={`nw-srv is-fold${legacy ? ' is-old' : ''}`} data-state={s.state}>
      <button
        type="button"
        className="nw-srv-top nw-srv-btn"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <span className={`al-dot nw-dot ${DOT_SHAPE[s.state]}`} aria-hidden="true" />
        <span className="nw-host al-text-code" title={s.host}>
          {s.host}
        </span>
        <span className="nw-state al-text-body-sm">
          {S.health[s.state]}
          {quick === null ? '' : ` · ${formatMs(quick)}`}
        </span>
        <Chevron />
      </button>
      {open ? (
        <div id={detailId} className="nw-more">
          <div className="nw-meta al-text-body-sm al-muted">
            <span>{role}</span>
            {times.length === 0 ? null : <span>{times.join(' · ')}</span>}
            <span>
              {counted ? S.counts(s.publishedOk, s.publishedFailed, s.received) : S.noCounts}
            </span>
            {usedBy === null ? null : <span>{S.usedBy(usedBy)}</span>}
            <span>{s.lastOkAt === null ? S.neverOk : S.lastOk(agoText(s.lastOkAt, now))}</span>
          </div>
          <Bar24 ok={s.publishedOk} failed={s.publishedFailed} />
          {note === undefined ? null : <p className="al-text-body-sm nw-detail">{note}</p>}
          {s.signInRequired === true ? (
            <p className="al-text-body-sm nw-detail">{S.needsSignIn}</p>
          ) : null}
          {s.paymentRequired === true ? (
            <p className="al-text-body-sm nw-detail">{S.needsPayment}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Reach({
  top,
  answer,
  expanded,
  onToggle,
  names,
  offline,
}: {
  readonly top: RefObject<HTMLDivElement | null>;
  readonly answer: NetworkAnswer;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly names: ReadonlyMap<string, string> | undefined;
  readonly offline: boolean;
}): ReactElement {
  const { total, sharing } = answer.contacts;
  const rows = answer.contactHosts;
  return (
    <div className="nw-card" ref={top}>
      <div className="nw-reach">
        <div>
          <h3 className="al-text-title-3">{S.reachHeading}</h3>
          <p className="al-text-body al-muted nw-summary">
            {total === 0 ? S.noContacts : `${S.reaches(sharing)} · ${S.reach(sharing, total)}`}
          </p>
        </div>
        {total === 0 ? null : (
          <Button size="sm" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? S.hideContacts : S.showContacts}
          </Button>
        )}
      </div>
      {!expanded || total === 0 ? null : rows === undefined ? (
        <p className="al-text-body-sm al-muted">{offline ? S.contactsFailed : S.contactsLoading}</p>
      ) : (
        <ul className="nw-contacts">
          {rows.map((c) => (
            <li key={c.ref} className="nw-contact">
              <div className="al-text-body nw-contact-name">
                {names?.get(c.ref) ?? S.someoneUnknown}
              </div>
              <div className="al-text-body-sm al-muted">
                {S.contactServers(c.servers, c.shared)}
              </div>
              <ul className="nw-hosts al-text-code al-muted">
                {c.hosts.map((h) => (
                  <li
                    key={h}
                    title={h}
                    className={answer.servers.some((s) => s.host === h) ? 'is-shared' : ''}
                  >
                    {h}
                    {answer.servers.some((s) => s.host === h) ? ` · ${S.shared}` : ''}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
