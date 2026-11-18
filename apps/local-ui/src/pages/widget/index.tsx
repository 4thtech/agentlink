// The menu bar widget page, `/settings/widget` (D-155; b11 §25.4; 11 §5.9; card TRAY-WIDGET-UI). A small
// page of its own (about 360 x 560, no sidebar) that the desktop popover loads, in the main window's
// session. Design: the owner-approved prototype (16 Nov 2026), built with the shared tokens.
//
// - READ-ONLY, and it never sends a write (the popover cancels every request but a GET): no approve, deny,
//   presence prompt or POST. Review, Pause, Resume and Update now all open the main window through the
//   popover's bridge (`window.agentlinkWidget.open`). No history change or redirect on this page.
// - I-5: the one piece of inbound text is a message preview. It is a React text node, one line by CSS,
//   never markup, never a link, never in a title or tooltip, and hidden when the API omits it (previews
//   off). Every other word is built here from fixed codes; a contact's name comes from the contacts read.
// - Reads: /api/ui/widget (today, unread, contacts), health, notifications (approvals, files),
//   /api/ui/activity (Live), /api/ui/contacts (names), /api/ui/app-update, and the shared live store
//   (/api/ui/agents and its events). Re-read, debounced, on an agents change, the `activity` event, a
//   return to view or focus, and every 15 s as a fallback; nothing is read while the window is hidden.
// - Keyboard: Escape closes, the arrow keys move between the actionable rows, Enter opens.
import {
  Banner,
  CountBadge,
  Icon,
  LiveDot,
  Mark,
  Skeleton,
  formatContactName,
  type LiveDotState,
} from '@4thtech-io/ui';
import {
  NOTIFICATIONS_PATH,
  readNotificationList,
  type NotificationList,
} from '@4thtech-io/types/ui-contract/notifications';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../api/client.js';
import { getLive, subscribeLive, type LiveAgent, type LiveSnapshot } from '../../api/live.js';
import { subscribeHealth } from '../../layout/health-feed.js';
import { HEALTH_PATH } from '../../layout/health.js';
import { initials } from '../../initials.js';
import type { WidgetRoute } from '../../desktop.js';
import { parseItem, render, type ActivityItem } from '../activity/clean.js';
import { LIST_PATH, parseList, type ContactRow } from '../contacts/data.js';
import { parseHealthSnapshot, type HealthSnapshot } from '../home/data.js';
import { APP_UPDATE_PATH, parseUpdate, type UpdateView } from '../updates/data.js';
import { APPROVAL_ID } from '../approvals/client.js';
import { closeWidget, openMain, quitApp } from './bridge.js';
import { WIDGET_PATH, parseWidget, sum, type WidgetView } from './data.js';
import {
  WIDGET_STRINGS as S,
  agoWords,
  appsActive,
  lastActivity,
  moreMessages,
  newCount,
  newFiles,
  newViaAi,
  rowLabel,
  shortAgo,
  todayLabel,
  waitingForYou,
} from './strings.js';
import './widget.css';

const ACTIVITY_PATH = '/api/ui/activity?limit=5';
/** The window event the live store raises for the stream's `activity` `{at}` (see the SHELL note). */
export const WIDGET_ACTIVITY_DOM_EVENT = 'agentlink:activity-changed';
export const DEBOUNCE_MS = 400;
export const FALLBACK_MS = 15_000;
const MAX_MESSAGES = 4;
const MAX_CONTACTS = 5;

export interface WidgetPageProps {
  readonly api?: ApiClient;
  readonly subscribe?: (listener: () => void) => () => void;
  readonly snapshot?: () => LiveSnapshot;
  readonly now?: () => number;
}

interface Model {
  readonly widget?: WidgetView;
  readonly widgetFailed: boolean;
  readonly contacts: readonly ContactRow[];
  readonly notes?: NotificationList;
  /** The one request waiting, when exactly one does (an `apr_…` ID, checked); else none. */
  readonly soleApproval?: string | undefined;
  readonly feed: readonly ActivityItem[];
  readonly update?: UpdateView;
  readonly loaded: boolean;
}
const APPROVALS_PATH = '/api/approvals';
const EMPTY: Model = { widgetFailed: false, contacts: [], feed: [], loaded: false };

const nameOfRow = (c: ContactRow): string =>
  formatContactName(
    c.nameSource === 'owner'
      ? { alias: c.name }
      : { name: c.name, ...(c.fingerprint === undefined ? {} : { fingerprint: c.fingerprint }) },
  ).text;

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

type Link = 'connecting' | 'connected' | 'paused' | 'offline' | 'update' | 'setup';

function appWord(state: string, word: string): string {
  switch (state) {
    case 'working':
      return S.working;
    case 'ready':
      return S.ready;
    case 'idle':
      return S.idle;
    case 'paused':
      return S.appPaused;
    default: {
      const seen = word.split(' · ').slice(1).join(' · ');
      return seen === '' ? S.notRunningApp : `${S.notRunningApp} · ${seen}`;
    }
  }
}
const ACTIVE = new Set(['working', 'ready', 'idle']);

function Strip({ today, now }: { today: WidgetView['today']; now: number }): ReactElement {
  const totals = today.in.map(
    (n, i) => n + (today.out[i] ?? 0) + (today.proofs[i] ?? 0) + (today.files[i] ?? 0),
  );
  const max = Math.max(4, ...totals);
  const current = Math.min(23, Math.max(0, Math.floor((now - today.start) / 3_600)));
  const H = 28;
  const scale = (n: number): number => (n === 0 ? 0 : Math.max(1, Math.round((n / max) * H)));
  const layers: readonly [string, readonly number[]][] = [
    ['in', today.in],
    ['out', today.out],
    ['proofs', today.proofs],
    ['files', today.files],
  ];
  return (
    <svg
      className="wg-strip"
      viewBox="0 0 120 28"
      preserveAspectRatio="none"
      role="img"
      aria-label={todayLabel(sum(today.in), sum(today.out), sum(today.proofs), sum(today.files))}
    >
      {totals.map((total, i) => {
        let y = H;
        const rects: ReactElement[] = [];
        if (total === 0) {
          rects.push(
            <rect
              key="t"
              className="wg-bar is-empty"
              x={i * 5 + 0.5}
              y={H - 1}
              width={4}
              height={1}
            />,
          );
        }
        for (const [kind, values] of layers) {
          const h = scale(values[i] ?? 0);
          if (h === 0) continue;
          y -= h;
          rects.push(
            <rect
              key={kind}
              className={`wg-bar is-${kind}`}
              x={i * 5 + 0.5}
              y={y}
              width={4}
              height={h}
            />,
          );
        }
        return (
          <g
            key={i}
            className={
              i === current ? 'wg-hour is-now' : i > current ? 'wg-hour is-future' : 'wg-hour'
            }
          >
            {rects}
          </g>
        );
      })}
    </svg>
  );
}

function Section({
  id,
  label,
  head,
  attention,
  children,
}: {
  id: string;
  label: string;
  head?: ReactNode;
  attention?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <section
      className="wg-blk"
      data-block={id}
      data-attention={attention ? 'true' : undefined}
      aria-label={label}
    >
      <h2 className="wg-head al-text-body-sm">
        <span className="wg-grow">{label}</span>
        {head}
      </h2>
      {children}
    </section>
  );
}

export function WidgetPage({
  api,
  subscribe = subscribeLive,
  snapshot = getLive,
  now = () => Math.floor(Date.now() / 1000),
}: WidgetPageProps): ReactElement {
  const client = useRef<ApiClient>(api ?? createApiClient());
  const clock = useRef(now);
  clock.current = now;
  const [model, setModel] = useState<Model>(EMPTY);
  const [health, setHealth] = useState<{ value?: HealthSnapshot; offline: boolean; done: boolean }>(
    { offline: false, done: false },
  );
  const [live, setLive] = useState<LiveSnapshot>(() => snapshot());
  const [, setTick] = useState(0);
  const alive = useRef(true);
  const root = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reading = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    document.title = S.title;
  }, []);

  const readAll = useCallback(async (): Promise<void> => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (reading.current) {
      again.current = true;
      return;
    }
    reading.current = true;
    try {
      const get = (p: string): Promise<ApiResult<unknown>> =>
        client.current.get(p).catch((): ApiResult<unknown> => ({ kind: 'offline' }));
      const [w, c, n, a, u] = await Promise.all([
        get(WIDGET_PATH),
        get(LIST_PATH),
        get(NOTIFICATIONS_PATH),
        get(ACTIVITY_PATH),
        get(APP_UPDATE_PATH),
      ]);
      if (!alive.current) return;
      // Exactly one request waits: its ID goes to the main window, which opens that request.
      let sole: string | undefined;
      const waiting = n.kind === 'ok' ? readNotificationList(n.data)?.approvals : undefined;
      if (waiting === 1) {
        const list = await get(APPROVALS_PATH);
        const raw =
          list.kind === 'ok' && typeof list.data === 'object' && list.data !== null
            ? (list.data as { approvals?: unknown }).approvals
            : undefined;
        if (Array.isArray(raw) && raw.length === 1) {
          const id = (raw[0] as { approvalId?: unknown } | null)?.approvalId;
          if (typeof id === 'string' && APPROVAL_ID.test(id)) sole = id;
        }
        if (!alive.current) return;
      }
      setModel((m) => {
        const view = w.kind === 'ok' ? parseWidget(w.data) : undefined;
        const list = c.kind === 'ok' ? parseList(c.data) : undefined;
        const notes = n.kind === 'ok' ? readNotificationList(n.data) : undefined;
        const feedRaw =
          a.kind === 'ok' && typeof a.data === 'object' && a.data !== null
            ? (a.data as { items?: unknown }).items
            : undefined;
        const feed = Array.isArray(feedRaw)
          ? (feedRaw as unknown[])
              .map(parseItem)
              .filter((i): i is ActivityItem => i !== undefined)
              .slice(0, 5)
          : undefined;
        const upd = u.kind === 'ok' ? parseUpdate(u.data) : undefined;
        return {
          ...m,
          ...(view === undefined ? {} : { widget: view }),
          widgetFailed: view === undefined,
          contacts: list?.kind === 'ok' ? list.contacts : m.contacts,
          ...(notes === undefined ? {} : { notes }),
          ...(sole === undefined ? { soleApproval: undefined } : { soleApproval: sole }),
          feed: feed ?? m.feed,
          ...(upd === undefined ? {} : { update: upd }),
          loaded: true,
        };
      });
    } finally {
      reading.current = false;
      if (again.current && alive.current) {
        again.current = false;
        schedule();
      }
    }
  }, []);

  const schedule = useCallback((): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void readAll();
    }, DEBOUNCE_MS);
  }, [readAll]);

  useEffect(() => {
    alive.current = true;
    void readAll();
    let signature = '';
    const sign = (s: LiveSnapshot): string =>
      JSON.stringify(s.agents.map((a) => [a.name, a.state, a.apps.map((x) => x.state)]));
    const stopLive = subscribe(() => {
      const s = snapshot();
      setLive(s);
      const next = sign(s);
      if (signature !== '' && next !== signature) schedule();
      signature = next;
    });
    const onActivity = (): void => schedule();
    const onVisible = (): void => {
      if (document.visibilityState !== 'hidden') schedule();
    };
    window.addEventListener(WIDGET_ACTIVITY_DOM_EVENT, onActivity);
    // WIDGET-POLISH-0511: the popover gaining focus (it opens again) reads again, so a file opened or
    // marked as seen in the main window leaves Needs you without waiting for the fallback poll.
    window.addEventListener('focus', onActivity);
    document.addEventListener('visibilitychange', onVisible);
    const poll = setInterval(() => {
      if (document.visibilityState !== 'hidden') void readAll();
      setTick((t) => t + 1);
    }, FALLBACK_MS);
    const onHealth = (result: ApiResult<unknown>): void => {
      if (!alive.current) return;
      const value = parseHealthSnapshot(result);
      if (value !== undefined) setHealth({ value, offline: false, done: true });
      else setHealth((h) => ({ ...h, offline: result.kind === 'offline', done: true }));
    };
    const stopHealth = subscribeHealth(() => client.current.get(HEALTH_PATH), {
      onResult: onHealth,
    });
    return () => {
      alive.current = false;
      stopLive();
      stopHealth();
      clearInterval(poll);
      if (timer.current !== undefined) clearTimeout(timer.current);
      window.removeEventListener(WIDGET_ACTIVITY_DOM_EVENT, onActivity);
      window.removeEventListener('focus', onActivity);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Focus the first actionable row once, when the page first has something to show.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !model.loaded) return;
    focused.current = true;
    root.current?.querySelector<HTMLElement>('[data-wg-nav]:not(:disabled)')?.focus();
  }, [model.loaded]);

  const names = useMemo(
    () => new Map(model.contacts.map((c) => [c.ref, nameOfRow(c)] as const)),
    [model.contacts],
  );
  const nameFor = (ref: string | undefined): string | undefined =>
    ref === undefined ? undefined : names.get(ref);
  const nameOrDefault = (ref: string): string => names.get(ref) ?? S.unknownContact;

  const t = clock.current();
  const widget = model.widget;
  const snap = health.value;
  const gone = health.offline && snap === undefined;
  const updateReady = model.update?.state === 'ready';
  const link: Link =
    !health.done && snap === undefined
      ? 'connecting'
      : health.offline || snap?.agent === 'not_running'
        ? 'offline'
        : snap?.agent === 'paused'
          ? 'paused'
          : snap?.agent === 'needs_setup'
            ? 'setup'
            : updateReady
              ? 'update'
              : 'connected';
  const word: Record<Link, string> = {
    connecting: S.connecting,
    connected: S.running,
    paused: S.paused,
    offline: S.notRunning,
    update: S.updateReady,
    setup: S.needsSetup,
  };
  const dot: LiveDotState =
    link === 'connecting'
      ? 'checking'
      : link === 'update'
        ? 'connected'
        : link === 'offline'
          ? 'not-running'
          : link === 'setup'
            ? 'needs-setup'
            : link;

  const agents: readonly LiveAgent[] = live.agents.filter((a) => a.apps.length > 0);
  const activeApps = live.agents.reduce(
    (n, a) => n + a.apps.filter((x) => ACTIVE.has(x.state)).length,
    0,
  );
  const lastAt = Math.max(
    0,
    model.feed[0]?.at ?? 0,
    ...(widget?.contacts.map((c) => c.lastAt) ?? []),
    ...(widget?.unread.map((u) => u.lastAt) ?? []),
  );

  const approvals = model.notes?.approvals ?? 0;
  const files = (model.notes?.items ?? [])
    .filter((i) => i.kind === 'files' && !i.read)
    .reduce((n, i) => n + i.count, 0);
  // One person with new files: their conversation (and files) open; several: no target.
  const fileRefs = (model.notes?.items ?? [])
    .filter((i) => i.kind === 'files' && !i.read && i.ref !== undefined)
    .map((i) => i.ref as string)
    .filter((r) => /^0x[0-9a-f]{40}$/.test(r));
  const filesTarget = new Set(fileRefs).size === 1 ? fileRefs[0] : undefined;
  // SEC-INVITE-CAPS (D-156): contacts the AI connected, waiting for Keep or Remove (Home shows
  // them and links to People, where the gesture is).
  const viaAi = model.contacts.filter(
    (c) => c.waitingForOwner === true && c.status === 'active',
  ).length;
  const needs = approvals + files + viaAi > 0;
  const paused = link === 'paused';
  const offline = link === 'offline';

  const go = (route: WidgetRoute, target?: string) => (): void => {
    void openMain(route, target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void closeWidget();
      return;
    }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key) || root.current === null) return;
    const items = [...root.current.querySelectorAll<HTMLElement>('[data-wg-nav]')].filter(
      (e) => !(e as HTMLButtonElement).disabled,
    );
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(items.length - 1, at + 1)
            : Math.max(0, at <= 0 ? 0 : at - 1);
    items[next]?.focus();
  };

  const loadingFirst = !model.loaded;
  const unread = widget?.unread ?? [];
  const newTotal = unread.reduce((n, u) => n + u.count, 0);
  const anyPreview = unread.slice(0, MAX_MESSAGES).some((u) => u.preview !== undefined);
  const people = [...(widget?.contacts ?? [])]
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, MAX_CONTACTS);

  return (
    <main className="wg" ref={root} aria-label={S.title} onKeyDown={onKeyDown}>
      <h1 className="al-sr-only">{S.title}</h1>

      <section className="wg-blk" data-block="status" aria-label={S.statusLabel}>
        <div className="wg-agent">
          <Mark size={16} mono title="" />
          <span className="wg-agent-name al-text-body">{S.thisComputer}</span>
          <LiveDot state={dot} label={word[link]} className="wg-dot" />
        </div>
        <p className="wg-line al-text-caption al-muted">
          {appsActive(activeApps)}
          {lastAt > 0 ? ` · ${lastActivity(agoWords(t - lastAt))}` : ''}
        </p>
        {link === 'paused' ? (
          <p className="wg-line al-text-caption al-muted">{S.pausedLine}</p>
        ) : null}
        {gone ? (
          <Banner tone="offline" compact>
            {S.processGone}
          </Banner>
        ) : model.widgetFailed && model.loaded ? (
          <Banner tone="info" icon="refresh-cw" compact>
            {S.readError}
          </Banner>
        ) : null}
      </section>

      <Section id="needs" label={S.needs} attention={needs}>
        {!needs ? <p className="wg-empty al-text-body-sm">{S.noneWaiting}</p> : null}
        {needs ? (
          <>
            <ul className="wg-rows">
              {approvals > 0 ? (
                <li>
                  <button
                    type="button"
                    className="wg-row"
                    data-wg-nav
                    onClick={go('approvals', model.soleApproval)}
                    disabled={offline}
                  >
                    <span className="wg-ico">
                      <Icon name="approval" size={16} />
                    </span>
                    <span className="wg-main al-text-body-sm">{waitingForYou(approvals)}</span>
                    <span className="wg-chev">
                      <Icon name="chevron-right" size={14} />
                    </span>
                  </button>
                </li>
              ) : null}
              {viaAi > 0 ? (
                <li>
                  <button
                    type="button"
                    className="wg-row"
                    data-wg-nav
                    data-wg-via-ai
                    onClick={go('home')}
                    disabled={offline}
                  >
                    <span className="wg-ico">
                      <Icon name="user-plus" size={16} />
                    </span>
                    <span className="wg-main al-text-body-sm">{newViaAi(viaAi)}</span>
                    <span className="wg-chev">
                      <Icon name="chevron-right" size={14} />
                    </span>
                  </button>
                </li>
              ) : null}
              {files > 0 ? (
                <li>
                  <button
                    type="button"
                    className="wg-row"
                    data-wg-nav
                    onClick={go('inbox', filesTarget)}
                    disabled={offline}
                  >
                    <span className="wg-ico">
                      <Icon name="download" size={16} />
                    </span>
                    <span className="wg-main al-text-body-sm">{newFiles(files)}</span>
                    <span className="wg-chev">
                      <Icon name="chevron-right" size={14} />
                    </span>
                  </button>
                </li>
              ) : null}
            </ul>
            {approvals > 0 && !offline ? (
              <button
                type="button"
                className="al-btn al-btn-primary al-btn-sm wg-block-btn"
                data-wg-nav
                onClick={go('approvals', model.soleApproval)}
              >
                {S.review}
              </button>
            ) : null}
          </>
        ) : null}
      </Section>

      <Section id="connected" label={S.connected}>
        <Skeleton
          loading={live.list === undefined && !live.error && agents.length === 0 && loadingFirst}
          lines={2}
          label={`${S.connected}: ${S.loading}`}
        >
          {agents.length === 0 ? (
            <p className="wg-empty al-text-body-sm">{S.noApps}</p>
          ) : (
            <ul className="wg-rows" aria-label={S.connected}>
              {agents.map((agent) => (
                <li key={agent.name} className="wg-id" data-agent>
                  <span className="wg-id-name al-text-body-sm">
                    <bdi>{agent.label}</bdi>
                  </span>
                  <ul className="wg-apps">
                    {agent.apps.map((app) => (
                      <li key={app.app} className="wg-app al-text-caption" data-state={app.state}>
                        <span className={`wg-appdot is-${app.state}`} aria-hidden="true" />
                        <span className="wg-app-name">
                          <bdi>{app.app}</bdi>
                        </span>
                        <span className="al-muted">{appWord(app.state, app.word)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Skeleton>
      </Section>

      <Section id="contacts" label={S.contacts}>
        <Skeleton loading={loadingFirst} lines={2} label={`${S.contacts}: ${S.loading}`}>
          {people.length === 0 ? (
            <p className="wg-empty al-text-body-sm">{S.noContacts}</p>
          ) : (
            <ul className="wg-rows" aria-label={S.contacts}>
              {people.map((p) => (
                <li key={p.contactId} className="wg-contact" data-contact>
                  <span className="wg-contact-name al-text-body-sm">
                    <bdi>{nameOrDefault(p.contactId)}</bdi>
                  </span>
                  <span className="wg-when al-text-caption" data-activity={p.activity}>
                    <span className={`wg-marker is-${p.activity}`} aria-hidden="true" />
                    {p.activity === 'active_now' ? S.activeNow : S.today}
                  </span>
                  <span className="wg-time al-text-caption al-muted num">
                    {shortAgo(t - p.lastAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Skeleton>
      </Section>

      <Section
        id="messages"
        label={S.messages}
        head={newTotal > 0 ? <CountBadge count={newTotal} label="new messages" /> : null}
      >
        <Skeleton loading={loadingFirst} lines={3} label={`${S.messages}: ${S.loading}`}>
          {unread.length === 0 ? (
            <p className="wg-empty al-text-body-sm">{S.noMessages}</p>
          ) : (
            <>
              <ul className="wg-rows" aria-label={S.messages}>
                {unread.slice(0, MAX_MESSAGES).map((u) => {
                  const name = nameOrDefault(u.contactId);
                  const recent = widget !== undefined && t - u.lastAt < 300;
                  return (
                    <li key={u.contactId}>
                      <button
                        type="button"
                        className="wg-row"
                        data-wg-nav
                        data-unread
                        aria-label={rowLabel(name, u.count, agoWords(t - u.lastAt))}
                        onClick={go('inbox', u.contactId)}
                        disabled={offline}
                      >
                        <span className="wg-avatar" aria-hidden="true">
                          {initials(name)}
                          {recent ? <span className="wg-avatar-dot" /> : null}
                        </span>
                        <span className="wg-main">
                          <span className="wg-top">
                            <span className="wg-name al-text-body-sm">
                              <bdi>{name}</bdi>
                            </span>
                            <span className="wg-time al-text-caption num">
                              {shortAgo(t - u.lastAt)}
                            </span>
                          </span>
                          {u.preview === undefined ? (
                            <span className="wg-sub al-text-caption al-muted">
                              {newCount(u.count)}
                            </span>
                          ) : (
                            // I-5: a text node, one line by CSS; never markup, a link or a title.
                            <span
                              className="wg-preview al-text-caption"
                              data-untrusted-preview
                              dir="auto"
                            >
                              {u.preview}
                            </span>
                          )}
                        </span>
                        <span className="wg-count num">
                          {u.count > 99 ? '99+' : String(u.count)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {unread.length > MAX_MESSAGES ? (
                <span className="al-text-caption al-muted">
                  {moreMessages(unread.length - MAX_MESSAGES)}
                </span>
              ) : null}
              {anyPreview ? (
                <span className="wg-untrusted al-text-caption">
                  <Icon name="untrusted" size={12} />
                  {S.untrustedNote}
                </span>
              ) : null}
            </>
          )}
        </Skeleton>
      </Section>

      <Section id="today" label={S.todayTitle}>
        {widget === undefined ? (
          <Skeleton loading={loadingFirst} lines={2} label={`${S.todayTitle}: ${S.loading}`}>
            <p className="wg-empty al-text-body-sm">{S.noLive}</p>
          </Skeleton>
        ) : (
          <>
            <Strip today={widget.today} now={widget.now} />
            <div className="wg-axis al-text-caption subtle" aria-hidden="true">
              <span>00</span>
              <span>06</span>
              <span>12</span>
              <span>18</span>
              <span>24</span>
            </div>
            <ul className="wg-legend al-text-caption" aria-label={S.todayTitle}>
              <li>
                <span className="wg-key is-in" aria-hidden="true" />
                {S.legendIn} <b className="num">{sum(widget.today.in)}</b>
              </li>
              <li>
                <span className="wg-key is-out" aria-hidden="true" />
                {S.legendOut} <b className="num">{sum(widget.today.out)}</b>
              </li>
              <li>
                <span className="wg-key is-proofs" aria-hidden="true" />
                {S.legendProofs} <b className="num">{sum(widget.today.proofs)}</b>
              </li>
              <li>
                <span className="wg-key is-files" aria-hidden="true" />
                {S.legendFiles} <b className="num">{sum(widget.today.files)}</b>
              </li>
            </ul>
          </>
        )}
      </Section>

      <Section id="live" label={S.live}>
        <Skeleton loading={loadingFirst} lines={3} label={`${S.live}: ${S.loading}`}>
          {model.feed.length === 0 ? (
            <p className="wg-empty al-text-body-sm">{S.noLive}</p>
          ) : (
            <ul className="wg-rows" aria-label={S.live}>
              {model.feed.map((item, i) => (
                <li key={`${String(item.at)}-${String(i)}`} className="wg-event">
                  <span className="wg-event-text al-text-caption">
                    {render(item, (id) => nameFor(id), '').sentence.map((p, k) =>
                      typeof p === 'string' ? (
                        p
                      ) : 'name' in p ? (
                        <bdi key={k}>{p.name}</bdi>
                      ) : (
                        S.aFile
                      ),
                    )}
                  </span>
                  <span className="wg-time al-text-caption al-muted num">
                    {shortAgo(t - item.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Skeleton>
      </Section>

      <footer className="wg-foot" data-block="footer">
        <button type="button" className="al-btn al-btn-block" data-wg-nav onClick={go('home')}>
          <Icon name="external-link" size={14} />
          {S.openApp}
        </button>
        {updateReady ? (
          <button
            type="button"
            className="al-btn al-btn-primary al-btn-block"
            data-wg-nav
            onClick={go('updates')}
          >
            <Icon name="download" size={14} />
            {S.updateReady}
          </button>
        ) : null}
        <div className="wg-foot-actions">
          <button
            type="button"
            className="al-btn al-btn-ghost al-btn-sm"
            data-wg-nav
            onClick={go('home')}
            disabled={offline}
          >
            <Icon name={paused ? 'play' : 'pause'} size={14} />
            <span>{paused ? S.resume : S.pause}</span>
          </button>
          <button
            type="button"
            className="al-btn al-btn-ghost al-btn-sm"
            data-wg-nav
            onClick={() => void quitApp()}
          >
            <svg
              className="al-icon"
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 2v10" />
              <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
            </svg>
            <span>{S.quit}</span>
            {isMac() ? <kbd className="wg-kbd">⌘Q</kbd> : null}
          </button>
        </div>
      </footer>
    </main>
  );
}
