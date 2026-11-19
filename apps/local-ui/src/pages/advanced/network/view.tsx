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
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { createApiClient, type ApiResult } from '../../../api/client.js';
import { agoText, getLive, subscribeLive } from '../../../api/live.js';
import { parseList, LIST_PATH as CONTACTS_PATH, type ContactRow } from '../../contacts/data.js';
import {
  NETWORK_CHANGED,
  NETWORK_CONTACTS_PATH,
  NETWORK_EVENT_MIN_MS,
  NETWORK_PATH,
  NETWORK_POLL_MS,
  formatMs,
  parseNetwork,
  summarize,
  type NetworkAnswer,
  type NetworkServer,
  type NetworkSummary,
} from './data.js';
import { DOT_SHAPE, NetworkDiagram } from './diagram.js';
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
      <div className="nw-diagram-slot" data-slot="network-diagram">
        {diagramOn ? <NetworkDiagram answer={answer} names={names} agentLabel={idLabel} /> : null}
      </div>
      <div className="nw-head">
        <h2 className="al-text-title-3">{S.serversHeading}</h2>
        {answer.mode === null ? null : (
          <span className="al-chip al-tone-info">
            <span className="al-text-label">
              {answer.mode === 'automatic' ? S.modeAutomatic : S.modeCustom}
            </span>
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
      {answer.servers.length === 0 ? null : (
        <ul className="nw-list">
          {answer.servers.map((s) => (
            <ServerCard key={s.host} server={s} answer={answer} now={clock} />
          ))}
        </ul>
      )}
      {answer.agent === 'needs_setup' || answer.agent === 'not_running' ? null : (
        <Reach
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
  const down = own.filter((s) => s.state === 'unreachable' || s.state === 'blocked').length;
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
      return <p className="al-text-body al-muted nw-ok">{S.allHealthy}</p>;
    case 'one_slow':
      return (
        <Banner tone={tone ?? 'warning'} title={S.oneSlowTitle}>
          {S.oneSlow}
        </Banner>
      );
    case 'some_slow':
      return (
        <Banner tone={tone ?? 'warning'} title={S.someSlowTitle(slow)}>
          {S.someSlow}
        </Banner>
      );
    case 'one_down':
      return (
        <Banner tone={tone ?? 'warning'} title={S.oneDownTitle}>
          {S.oneDown}
        </Banner>
      );
    case 'some_down':
      return (
        <Banner tone={tone ?? 'warning'} title={S.someDownTitle(down)}>
          {S.someDown}
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

function ServerCard({
  server: s,
  answer,
  now,
}: {
  readonly server: NetworkServer;
  readonly answer: NetworkAnswer;
  readonly now: number;
}): ReactElement {
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
  const note =
    s.state === 'slow'
      ? S.slowNote
      : s.state === 'unreachable'
        ? S.downNote
        : s.state === 'blocked'
          ? S.blockedNote
          : undefined;
  return (
    <li className={`nw-srv${legacy ? ' is-old' : ''}`} data-state={s.state}>
      <div className="nw-srv-top">
        <span className={`nw-dot ${DOT_SHAPE[s.state]}`} aria-hidden="true" />
        <span className="nw-host al-text-code" title={s.host}>
          {s.host}
        </span>
        <span className="nw-state al-text-body-sm">{S.health[s.state]}</span>
      </div>
      <div className="nw-meta al-text-body-sm al-muted">
        <span className="nw-pill">{role}</span>
        {times.length === 0 ? null : <span>{times.join(' · ')}</span>}
        <span>{counted ? S.counts(s.publishedOk, s.publishedFailed, s.received) : S.noCounts}</span>
        {usedBy === null ? null : <span>{S.usedBy(usedBy)}</span>}
        {s.publishedOk + s.publishedFailed > 0 ? (
          <Bar ok={s.publishedOk} failed={s.publishedFailed} />
        ) : null}
        <span>{s.lastOkAt === null ? S.neverOk : S.lastOk(agoText(s.lastOkAt, now))}</span>
      </div>
      {note === undefined ? null : <p className="al-text-body-sm nw-detail">{note}</p>}
      {s.signInRequired === true ? (
        <p className="al-text-body-sm nw-detail">{S.needsSignIn}</p>
      ) : null}
      {s.paymentRequired === true ? (
        <p className="al-text-body-sm nw-detail">{S.needsPayment}</p>
      ) : null}
    </li>
  );
}

/** Accepted versus failed in the last 24 hours: one small bar, never a number the text lacks. */
function Bar({ ok, failed }: { readonly ok: number; readonly failed: number }): ReactElement {
  const total = ok + failed;
  const okPct = total === 0 ? 0 : Math.round((ok / total) * 100);
  return (
    <span className="nw-bar" role="img" aria-label={S.barLabel(ok, failed)}>
      <i className={`nw-bar-ok nw-w${String(Math.round(okPct / 5))}`} />
      <i className={`nw-bar-bad nw-w${String(20 - Math.round(okPct / 5))}`} />
    </span>
  );
}

function Reach({
  answer,
  expanded,
  onToggle,
  names,
  offline,
}: {
  readonly answer: NetworkAnswer;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly names: ReadonlyMap<string, string> | undefined;
  readonly offline: boolean;
}): ReactElement {
  const { total, sharing } = answer.contacts;
  const rows = answer.contactHosts;
  return (
    <div className="nw-card">
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
              <ul className="nw-hosts al-text-code">
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
