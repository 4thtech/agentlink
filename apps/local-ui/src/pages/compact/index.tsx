// The compact view (UX2-h; B-11 §25; UX-WAVE-2 item 5, decision 5.1): one small window, five blocks
// that never scroll at 50+ contacts. Served at /settings/compact (a path the server already serves as
// an app page); opened by "Open compact window" on Home. The same content is the future menu-bar
// popover's (UX2-i), so the blocks hold nothing a popover could not show.
//
// - Shows counts, names under the name rule, activity words and pulses. NEVER message text, a file
//   name or size (§17.4). The one line of text from a request is the soonest approval's summary,
//   clamped, as on Home's Waiting for you tile.
// - NEVER approves (08 §1): no Approve, Deny or presence prompt, no POST. "Review" and the other
//   links hand over to the main app, which opens at the right page.
// - Reads only existing GET routes (health, approvals list, contacts, credits, pulse). The health
//   poller (shared, pauses while the window is hidden) paces the other reads, as on Home.
// - I-5: every value is React text from a typed parse. No inline styles (CSP); the pulse is SVG with
//   attribute sizes. No looping motion: reduced motion changes nothing, because nothing here moves
//   except the shared skeleton and the Live dot's own arrival ring.
import {
  CountBadge,
  Icon,
  LiveDot,
  Mark,
  Skeleton,
  formatContactName,
  type LiveDotState,
} from '@4thtech-io/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../api/client.js';
import { subscribeHealth } from '../../layout/health-feed.js';
import { HEALTH_PATH } from '../../layout/health.js';
import { createApprovalsClient, type ListAnswer } from '../approvals/client.js';
import { LIST_PATH, parseList, type ContactRow } from '../contacts/data.js';
import { ADD_CONTACT_HREF } from '../contacts/add-contact-link.js';
import {
  creditsOf,
  parseHealthSnapshot,
  waitingOf,
  type CreditsView,
  type HealthSnapshot,
  type WaitingView,
} from '../home/data.js';
import { HOME_STRINGS as H, creditsLine, minutesLeft, waitingCount } from '../home/strings.js';
import { CREDITS_PATH } from '../proofs/data.js';
import './compact.css';
import {
  PULSE_PATH,
  TOP_N,
  barHeights,
  parsePulse,
  pulseTotal,
  rankByActivity,
  type Activity,
  type PulseAnswer,
  type PulseRow,
} from './data.js';
import { openInMainApp } from './open.js';
import { COMPACT_STRINGS as S, moreContacts, pulseLabel } from './strings.js';

/** Health ticks come every 5 s; the other reads at most this often (as on Home). */
const SECONDARY_MS = 14_000;
const MESSAGES_PATH = '/settings/messages';
const HOME_PATH = '/settings/home';
const APPROVALS_PATH = '/';

export interface CompactPageProps {
  /** The API client; the app's default one when absent (tests pass their own). */
  readonly api?: ApiClient;
  /** The approvals list (the same route the Approvals page reads). */
  readonly approvals?: { list(): Promise<ListAnswer> };
  /** Bring the main app to the front at a path. The default uses the window that opened this one. */
  readonly openMain?: (path: string) => void;
  readonly now?: () => Date;
}

type Flag<T> = { readonly done: boolean; readonly value?: T };

interface Model {
  readonly health: Flag<HealthSnapshot>;
  readonly offline: boolean;
  readonly error: boolean;
  readonly asOf: Date | null;
  readonly waiting: Flag<WaitingView>;
  readonly credits: Flag<CreditsView | 'unavailable'>;
  readonly contacts: Flag<readonly ContactRow[]>;
  readonly pulse: Flag<PulseAnswer>;
}

const EMPTY: Model = {
  health: { done: false },
  offline: false,
  error: false,
  asOf: null,
  waiting: { done: false },
  credits: { done: false },
  contacts: { done: false },
  pulse: { done: false },
};

type Agent = HealthSnapshot['agent'];
const AGENT_DOT: Readonly<Record<Agent, LiveDotState>> = {
  connected: 'connected',
  paused: 'paused',
  not_running: 'not-running',
  needs_setup: 'needs-setup',
};
const AGENT_WORD: Readonly<Record<Agent, string>> = {
  connected: H.agentRunning,
  paused: H.agentPaused,
  not_running: H.agentNotRunning,
  needs_setup: H.agentNeedsSetup,
};

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const WORD: Readonly<Record<Activity, string>> = {
  active_now: S.activeNow,
  today: S.today,
  quiet: S.quiet,
};
const MARKER: Readonly<Record<Activity, 'filled' | 'ring' | 'none'>> = {
  active_now: 'filled',
  today: 'ring',
  quiet: 'none',
};

const nameOf = (c: ContactRow): string =>
  formatContactName(
    c.nameSource === 'owner'
      ? { alias: c.name }
      : { name: c.name, ...(c.fingerprint === undefined ? {} : { fingerprint: c.fingerprint }) },
  ).text;

/** The 47 x 16 pulse (b11 §24.2): one image, 12 bars, the current two hours darker. */
function Pulse({ counts }: { counts: readonly number[] }): ReactElement {
  const heights = barHeights(counts);
  return (
    <svg
      className="cp-pulse"
      width={47}
      height={16}
      viewBox="0 0 47 16"
      role="img"
      aria-label={pulseLabel(pulseTotal(counts))}
    >
      {heights.map((height, i) => (
        <rect
          key={i}
          className={i === heights.length - 1 ? 'cp-bar is-now' : 'cp-bar'}
          x={i * 4}
          y={16 - height}
          width={3}
          height={height}
        />
      ))}
    </svg>
  );
}

const FLAT: readonly number[] = Array.from({ length: 12 }, () => 0);

function Block({
  id,
  label,
  loading,
  attention = false,
  stale,
  children,
}: {
  id: string;
  label: string;
  loading: boolean;
  attention?: boolean;
  stale?: string | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <section
      className="cp-block"
      data-block={id}
      data-attention={attention ? 'true' : undefined}
      aria-label={label}
    >
      <Skeleton loading={loading} lines={2} label={`${label}: ${S.loading}`}>
        {children}
        {stale === undefined ? null : (
          <p className="cp-asof al-text-caption al-muted">
            {H.asOf} {stale}
          </p>
        )}
      </Skeleton>
    </section>
  );
}

function Link({
  path,
  className,
  onOpen,
  children,
}: {
  path: string;
  className: string;
  onOpen: (path: string) => void;
  children: ReactNode;
}): ReactElement {
  return (
    <a
      className={className}
      href={path}
      onClick={(event) => {
        // A plain click hands over to the main app; a modified click is left to the browser.
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        onOpen(path);
      }}
    >
      {children}
    </a>
  );
}

export function CompactPage({
  api,
  approvals,
  openMain = (path) => openInMainApp(path),
  now = () => new Date(),
}: CompactPageProps): ReactElement {
  const client = useRef<ApiClient>(api ?? createApiClient());
  const approvalsClient = useRef(approvals ?? createApprovalsClient());
  const clockNow = useRef(now);
  clockNow.current = now;
  const [model, setModel] = useState<Model>(EMPTY);
  const live = useRef(true);
  const lastSecondary = useRef(0);
  const reading = useRef(false);

  const patch = useCallback((change: Partial<Model> | ((m: Model) => Partial<Model>)): void => {
    if (!live.current) return;
    setModel((m) => ({ ...m, ...(typeof change === 'function' ? change(m) : change) }));
  }, []);

  useEffect(() => {
    document.title = S.title;
  }, []);

  const loadSecondary = useCallback(async (): Promise<void> => {
    if (reading.current) return;
    reading.current = true;
    lastSecondary.current = Date.now();
    try {
      const get = (path: string): Promise<ApiResult<unknown>> => client.current.get(path);
      const [credits, contacts, pulse, waiting] = await Promise.all([
        get(CREDITS_PATH),
        get(LIST_PATH),
        get(PULSE_PATH),
        approvalsClient.current.list().catch((): ListAnswer => ({ kind: 'offline' })),
      ]);
      // A failed read keeps the value from before; the first read only marks the block as settled.
      patch((m) => {
        const cr = credits.kind === 'ok' ? creditsOf(credits.data) : undefined;
        const list = contacts.kind === 'ok' ? parseList(contacts.data) : undefined;
        const pu = pulse.kind === 'ok' ? parsePulse(pulse.data) : undefined;
        return {
          credits: cr === undefined ? { ...m.credits, done: true } : { done: true, value: cr },
          contacts:
            list?.kind === 'ok'
              ? { done: true, value: list.contacts }
              : { ...m.contacts, done: true },
          pulse: pu === undefined ? { ...m.pulse, done: true } : { done: true, value: pu },
          waiting:
            waiting.kind === 'ok'
              ? { done: true, value: waitingOf(waiting.items) }
              : { ...m.waiting, done: true },
        };
      });
    } catch {
      patch((m) => ({
        credits: { ...m.credits, done: true },
        contacts: { ...m.contacts, done: true },
        pulse: { ...m.pulse, done: true },
        waiting: { ...m.waiting, done: true },
      }));
    } finally {
      reading.current = false;
    }
  }, [patch]);

  useEffect(() => {
    live.current = true;
    void loadSecondary();
    // The shared health poller pauses while the window is hidden and reads again when shown.
    const onResult = (result: ApiResult<unknown>): void => {
      if (!live.current) return;
      const snapshot = parseHealthSnapshot(result);
      if (snapshot !== undefined) {
        patch({
          health: { done: true, value: snapshot },
          offline: false,
          error: false,
          asOf: clockNow.current(),
        });
        if (Date.now() - lastSecondary.current >= SECONDARY_MS) void loadSecondary();
      } else if (result.kind === 'offline') {
        // The last good answer stays, so the blocks keep their values marked "as of".
        patch((m) => ({ health: { ...m.health, done: true }, offline: true, error: false }));
      } else {
        patch((m) => ({ health: { ...m.health, done: true }, offline: false, error: true }));
      }
    };
    const stop = subscribeHealth(() => client.current.get(HEALTH_PATH), { onResult });
    return () => {
      live.current = false;
      stop();
    };
  }, [loadSecondary, patch]);

  const today = now();
  const health = model.health.value;
  const agent: Agent = health?.agent ?? 'not_running';
  const stale = model.offline && model.asOf !== null ? CLOCK.format(model.asOf) : undefined;
  const waiting = model.waiting.value;
  const soonest = waiting?.soonest ?? null;
  const credits = model.credits.value;
  const pulse = model.pulse.value;
  const ranked = rankByActivity(model.contacts.value ?? [], pulse?.rows ?? []);
  const top = ranked.slice(0, TOP_N);
  const more = ranked.length - top.length;
  // Never reached the app at all: the whole-app message (b11 §25.2, process gone).
  const gone = model.offline && health === undefined;
  // Offline after values: Review is hidden (the main app cannot take it either).
  const canReview = !model.offline && (waiting?.count ?? 0) > 0;

  return (
    <main className="cp" aria-label={S.title}>
      <h1 className="al-sr-only">{S.title}</h1>
      {gone ? (
        <p className="cp-gone al-text-body-sm" role="status">
          <Icon name="wifi-off" size={16} />
          {S.processGone}
        </p>
      ) : (
        <>
          <ul className="cp-agents cp-block" data-block="agent" aria-label={S.agentList}>
            <li className="cp-agent" data-agent-row>
              <Mark size={16} mono title="" />
              <span className="cp-agent-name al-text-body-sm">{S.agentName}</span>
              <Skeleton
                loading={!model.health.done}
                lines={1}
                label={`${S.agentName}: ${S.loading}`}
              >
                <LiveDot
                  state={model.offline ? 'not-running' : AGENT_DOT[agent]}
                  label={model.offline ? H.networkOffline : AGENT_WORD[agent]}
                  className="cp-dot"
                />
              </Skeleton>
              {agent === 'paused' && !model.offline ? (
                <span className="cp-agent-line al-text-caption al-muted">{H.agentPausedLine}</span>
              ) : null}
            </li>
          </ul>
          {model.offline ? (
            <p className="cp-note al-text-body-sm" role="status">
              <Icon name="wifi-off" size={16} />
              {H.offlineLine}
            </p>
          ) : model.error ? (
            <p className="cp-note al-text-body-sm" role="status">
              <Icon name="refresh-cw" size={16} />
              {H.errorLine}
            </p>
          ) : null}
          <Block
            id="needs"
            label={S.needsList}
            loading={!waiting && !model.waiting.done}
            attention={(waiting?.count ?? 0) > 0}
            stale={stale}
          >
            {waiting === undefined || waiting.count === 0 ? (
              <p className="al-text-body-sm">{H.waitingNone}</p>
            ) : (
              <>
                <p className="cp-needs-head al-text-label">
                  {H.waitingTitle}
                  <CountBadge count={waiting.count} label={waitingCount(waiting.count)} />
                </p>
                {soonest === null ? null : (
                  <p className="cp-soonest al-text-body-sm">
                    {soonest.summary} ·{' '}
                    {minutesLeft(
                      Math.max(0, Math.ceil((soonest.expiresAt * 1000 - today.getTime()) / 60_000)),
                    )}
                  </p>
                )}
                {canReview ? (
                  <Link
                    path={APPROVALS_PATH}
                    className="al-btn al-btn-primary al-btn-sm"
                    onOpen={openMain}
                  >
                    {H.review}
                  </Link>
                ) : null}
              </>
            )}
          </Block>
          <Block id="contacts" label={S.contactsList} loading={!model.contacts.done} stale={stale}>
            {ranked.length === 0 ? (
              <>
                <p className="al-text-body-sm">{S.noContacts}</p>
                <Link
                  path={ADD_CONTACT_HREF}
                  className="al-btn al-btn-secondary al-btn-sm"
                  onOpen={openMain}
                >
                  {S.addContact}
                </Link>
              </>
            ) : (
              <>
                <p className="cp-caption al-text-caption al-muted">{S.mostActive}</p>
                <ul className="cp-contacts" aria-label={S.contactsList}>
                  {top.map(({ contact, pulse: row }) => (
                    <ContactLine
                      key={contact.ref}
                      name={nameOf(contact)}
                      row={row}
                      known={pulse !== undefined}
                    />
                  ))}
                </ul>
                {more > 0 ? (
                  <Link path={MESSAGES_PATH} className="cp-more al-text-body-sm" onOpen={openMain}>
                    {moreContacts(more)}
                  </Link>
                ) : null}
              </>
            )}
          </Block>
          <Block id="credits" label={S.creditsLabel} loading={!model.credits.done} stale={stale}>
            <p className="al-text-body-sm">
              {credits === undefined || credits === 'unavailable'
                ? H.creditsUnavailable
                : credits.proofsLeft === 0
                  ? H.creditsNone
                  : creditsLine(credits.balance, credits.proofsLeft)}
            </p>
          </Block>
        </>
      )}
      <div className="cp-block cp-footer" data-block="footer">
        <Link path={HOME_PATH} className="al-btn al-btn-secondary al-btn-block" onOpen={openMain}>
          {S.openApp}
        </Link>
      </div>
    </main>
  );
}

function ContactLine({
  name,
  row,
  known,
}: {
  name: string;
  row: PulseRow | undefined;
  /** Whether the pulse read has answered; if not, no word and a flat pulse. */
  known: boolean;
}): ReactElement {
  const activity: Activity | undefined = !known ? undefined : (row?.activity ?? 'quiet');
  return (
    <li className="cp-contact" data-contact>
      <span className="cp-contact-name al-text-body-sm">{name}</span>
      {activity === undefined ? null : (
        <>
          <span className="cp-marker" data-marker={MARKER[activity]} aria-hidden="true" />
          <span className="cp-word al-text-caption" data-activity={activity}>
            {WORD[activity]}
          </span>
        </>
      )}
      <Pulse counts={row?.counts ?? FLAT} />
    </li>
  );
}
