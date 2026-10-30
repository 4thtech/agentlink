// W4-HOME: Home at `/` (Decisions 47–50; W4 UX v2 "Layer 2: Simple app" and "Layer 3"; prototype
// v23 A4 Home and A10 Home pro, implemented as approved; ux-inventory §9 items 1–4). One route, two
// layers: "Under the hood" (the shell's switch) morphs this same screen in place.
//
// Simple: the approval card on top (+N more), Invite someone, then People: each person with their
// last activity, a row that opens in place (the shared element, U0 View Transition) to the
// conversation, the files and the ⋯ menu; invites that wait to be accepted below (U4 adds Cancel).
// Pro: People as a dense table (person, handled by, last message, delivery, proofs, files), search
// and the agent filter (2+ agents), message details and contact facts, approval ID/kind/expiry and
// the bulk review.
//
// Loading: nothing under ~300 ms, then a skeleton shaped like Home (U0 SkeletonGate). Home looks
// again every few seconds while visible. Reading sends GETs only (I-4); whatever another party wrote
// is shown only inside the untrusted container (I-5); Save and Show in Finder send only an item ID.
import {
  Banner,
  Button,
  EmptyState,
  Icon,
  SkeletonGate,
  SkeletonLine,
  SkeletonList,
  SkeletonTable,
  UntrustedContent,
  useViewTransition,
  type PayPlatform,
} from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { getLive, subscribeLive, switchAgent, type LiveAgent } from '../../api/live.js';
import { INTERIM_PEOPLE_PATH } from '../../nav.js';
import type { PayConfirmClient } from '../../pay-confirm/index.js';
import { usePrefs } from '../../prefs/index.js';
import type { OwnerState, SheetOptions } from '../approvals/card.js';
import {
  createApprovalsClient,
  type ApprovalItem,
  type ApprovalsClient,
  type DecisionPasskey,
} from '../approvals/client.js';
import { ADD_CONTACT_MARKER } from '../contacts/add-contact-link.js';
import type { ContactRow } from '../contacts/data.js';
import { createInviteApi, type InviteApi, type OpenInvite } from '../contacts/invite-api.js';
import { createFilesApi } from '../files/files-api.js';
import type { Conversation as Person, MessagesApi, Problem } from '../messages/api.js';
import { createSaveApi, type SaveApi } from '../inbox/save-api.js';
import { Conversation, exactTime, useThread } from './conversation.js';
import { HomeApprovals } from './home-approvals.js';
import {
  createPeopleApi,
  MAX_SUMMARIES,
  type HomeData,
  type PeopleApi,
  type PersonSummary,
} from './people-api.js';
import { HOME_STRINGS as S, fmt } from './people-strings.js';
import { filesOf, PersonFiles, type Reveal } from './person-files.js';
import { PersonMenu } from './person-menu.js';
import { PersonName } from './person-name.js';
import './people.css';

/** How often Home looks again while the tab is visible. */
export const HOME_POLL_MS = 5_000;
/** Invite someone: today's invite sheet (U4 replaces it with the Invite panel). */
export const INVITE_HREF = `${INTERIM_PEOPLE_PATH}?${ADD_CONTACT_MARKER}`;

export interface HomeScreenProps {
  /** Test seams: the fetch, session token and passkey container; the page's own when absent. */
  readonly fetch?: typeof fetch;
  readonly token?: string;
  readonly credentials?: CredentialsContainer;
  readonly approvalsClient?: ApprovalsClient;
  readonly payConfirm?: PayConfirmClient;
  readonly canPasskey?: boolean;
  readonly platform?: PayPlatform;
  readonly reducedMotion?: boolean;
  /** 0 turns the look-again timer off (tests). */
  readonly pollMs?: number;
  /** U2's "Get started · n of 3 done" card, on top while setup is not done. */
  readonly getStarted?: ReactNode;
  /** Why nothing can be approved here yet (owner not set up, no passkeys in this browser). */
  readonly ownerNotice?: ReactNode;
  /** U4's pending invite rows; otherwise the server's open invites, each with Cancel. */
  readonly pendingRows?: ReactNode;
  /** K3's "Saved to <folder>" note for every person's Files. */
  readonly folderNote?: ReactNode;
}

function browserPasskeys(): boolean {
  return (
    typeof window !== 'undefined' &&
    'PublicKeyCredential' in window &&
    typeof navigator !== 'undefined' &&
    navigator.credentials !== undefined
  );
}

interface Clients {
  readonly api: ApiClient;
  readonly people: PeopleApi;
  readonly approvals: ApprovalsClient;
  readonly save: SaveApi;
  readonly reveal: Reveal;
  readonly invites: InviteApi;
}

function useClients(props: HomeScreenProps): Clients {
  const { fetch: givenFetch, token, credentials, approvalsClient } = props;
  return useMemo(() => {
    const opts = {
      ...(givenFetch === undefined ? {} : { fetch: givenFetch }),
      ...(token === undefined ? {} : { token }),
    };
    const withKeys = { ...opts, ...(credentials === undefined ? {} : { credentials }) };
    const api = createApiClient(opts);
    const files = createFilesApi(opts);
    return {
      api,
      people: createPeopleApi(api),
      approvals: approvalsClient ?? createApprovalsClient(withKeys),
      save: createSaveApi(withKeys),
      reveal: (id: string) => files.reveal(id),
      invites: createInviteApi(opts),
    };
  }, [givenFetch, token, credentials, approvalsClient]);
}

type View =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly problem: Problem }
  | { readonly state: 'ready'; readonly data: HomeData };

const LIVE_EMPTY = { list: undefined, agents: [], error: false };
function useLiveAgents(): readonly LiveAgent[] {
  const snap = useSyncExternalStore(subscribeLive, getLive, () => LIVE_EMPTY);
  return snap.agents;
}

/** The skeleton in the shape of Home (U0): the card, Invite, the People label and three rows. */
function HomeSkeleton({ pro }: { readonly pro: boolean }): ReactElement {
  return (
    <div className="hm-skeleton hm-c">
      <SkeletonLine width={100} size="control" />
      {pro ? null : <SkeletonLine width={100} size="control" className="hm-skel-invite" />}
      <SkeletonLine width="label" size="caption" />
      {pro ? <SkeletonTable rows={3} columns={6} /> : <SkeletonList rows={3} />}
    </div>
  );
}

function Avatar({
  name,
  small,
}: {
  readonly name: string;
  readonly small?: boolean;
}): ReactElement {
  const letter = [...name.trim()][0]?.toUpperCase() ?? '?';
  // A tint picked from the name, so a person keeps their colour (no image, no key).
  let tint = 0;
  for (const ch of name) tint = (tint * 31 + (ch.codePointAt(0) ?? 0)) % 4;
  return (
    <span
      className={small ? 'al-avatar' : 'al-avatar hm-avatar'}
      data-tint={String(tint)}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

const DELIVERY_WORD: Readonly<Record<string, string>> = {
  sent: S.sent,
  queued: S.waitingToSend,
  not_delivered: S.notDelivered,
};

function filesText(n: number): string {
  return n === 1 ? S.oneFile : fmt(S.files, { count: n });
}

/** "2 min ago", "Yesterday", or the date. */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.floor(now / 1000) - at);
  if (s < 60) return S.agoNow;
  if (s < 3600) return fmt(S.agoMinutes, { n: Math.floor(s / 60) });
  if (s < 86_400) return fmt(S.agoHours, { n: Math.floor(s / 3600) });
  if (s < 172_800) return S.agoYesterday;
  return new Date(at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The expanded part of a person: conversation, files and the ⋯ menu. */
function PersonOpen({
  person,
  contact,
  data,
  clients,
  agent,
  pro,
  tick,
  passkey,
  refresh,
  folderNote,
  props,
  onChanged,
}: {
  readonly person: Person;
  readonly contact: ContactRow | undefined;
  readonly data: HomeData;
  readonly clients: Clients;
  readonly agent: string;
  readonly pro: boolean;
  readonly tick: number;
  readonly passkey: () => Promise<DecisionPasskey | undefined>;
  readonly refresh: () => void;
  readonly folderNote?: ReactNode;
  readonly props: HomeScreenProps;
  readonly onChanged: (what: 'check' | 'rename' | 'remove') => void;
}): ReactElement {
  const messages: MessagesApi = clients.people.messages;
  const { thread, loadEarlier } = useThread(messages, person.contactId, tick);
  const files = thread.state === 'ready' ? filesOf(thread.inbox.items, thread.sent.items) : [];
  return (
    <div className="hm-open hm-c al-expand" data-person-open={person.contactId}>
      <div className="hm-open-head hm-f">
        <span className="hm-kicker al-text-label">{S.conversationTitle}</span>
        <PersonMenu
          name={person.name}
          contact={contact}
          api={clients.api}
          {...(props.fetch === undefined ? {} : { fetch: props.fetch })}
          {...(props.token === undefined ? {} : { token: props.token })}
          onChanged={(what) => onChanged(what)}
        />
      </div>
      {pro && contact !== undefined ? (
        <dl className="hm-facts al-reveal">
          {contact.fingerprint === undefined ? null : (
            <div>
              <dt className="hm-kicker al-text-label">{S.fingerprint}</dt>
              <dd className="al-text-code">{contact.fingerprint}</dd>
            </div>
          )}
          <div>
            <dt className="hm-kicker al-text-label">{S.identity}</dt>
            <dd className={contact.label === 'safety-code-checked' ? 'is-checked' : undefined}>
              {contact.label === 'safety-code-checked' ? S.identityChecked : S.identityNotChecked}
            </dd>
          </div>
          <div>
            <dt className="hm-kicker al-text-label">{S.paired}</dt>
            <dd>
              {new Date(contact.since * 1000).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </dd>
          </div>
          <div>
            <dt className="hm-kicker al-text-label">{S.handledBy}</dt>
            <dd>{agent}</dd>
          </div>
        </dl>
      ) : null}
      <Conversation
        name={person.name}
        agent={agent}
        pro={pro}
        thread={thread}
        loadEarlier={loadEarlier}
      />
      <PersonFiles
        name={person.name}
        rows={files}
        received={data.received}
        sent={data.sent}
        save={clients.save}
        passkey={passkey}
        reveal={clients.reveal}
        onSaved={refresh}
        {...(folderNote === undefined ? {} : { folderNote })}
      />
    </div>
  );
}

const DAY_MS = 86_400_000;

/** An invite that waits to be accepted: who, how long the link works, and Cancel. Never the link. */
function PendingInviteRow({
  invite,
  pro,
  agent,
  api,
  onCancelled,
}: {
  readonly invite: OpenInvite;
  readonly pro: boolean;
  readonly agent: string;
  readonly api: InviteApi;
  readonly onCancelled: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const left = Math.max(0, Math.ceil((invite.expiresAt - Date.now()) / DAY_MS));
  const name = invite.name ?? undefined;
  return (
    <div className="hm-invite-row hm-f">
      <span className="al-avatar hm-avatar is-pending" aria-hidden="true">
        {name === undefined ? (
          <Icon name="clock" size={16} />
        ) : (
          ([...name][0]?.toUpperCase() ?? '?')
        )}
      </span>
      <span className="hm-row-main hm-c">
        {name === undefined ? null : <PersonName name={name} />}
        <span className="hm-sub al-text-body-sm">
          {name === undefined ? S.waitingToAcceptNoName : fmt(S.waitingToAccept, { name })}
          {' · '}
          {left === 1 ? S.linkWorksOneDay : fmt(S.linkWorksDays, { count: left })}
        </span>
        {pro ? (
          <span className="al-text-code hm-cell-time">
            {invite.inviteId} · {S.approvalExpires} {exactTime(Math.floor(invite.expiresAt / 1000))}
            {agent === '' ? '' : ` · ${agent}`}
          </span>
        ) : null}
        {failed ? (
          <span role="alert" className="hm-inline-error al-text-body-sm">
            {S.cantCancel}
          </span>
        ) : null}
      </span>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          void api.cancel(invite.inviteId).then((outcome) => {
            setBusy(false);
            if (outcome.kind === 'cancelled' || outcome.kind === 'not_found') onCancelled();
            else setFailed(true);
          });
        }}
      >
        {S.cancelInvite}
      </Button>
    </div>
  );
}

/** Under the hood the opened part is one row of the table, its one cell spanning the columns. */
function OpenRow({
  pro,
  children,
}: {
  readonly pro: boolean;
  readonly children: ReactNode;
}): ReactElement {
  if (!pro) return <>{children}</>;
  return (
    <div role="row" className="hm-open-row">
      <div role="cell" aria-colspan={7}>
        {children}
      </div>
    </div>
  );
}

/** The pro table's last message: your AI's words as text, theirs in the untrusted container. */
function LastText({
  person,
  summary,
}: {
  readonly person: Person;
  readonly summary: PersonSummary | undefined;
}): ReactElement {
  const last = summary?.last;
  if (last === undefined) return <span className="hm-cell-muted">{S.noMessagesYet}</span>;
  const text = last.item.text === '' ? filesText(last.item.files.length) : last.item.text;
  return (
    <span className="hm-cell-last hm-c">
      {last.out || last.item.text === '' ? (
        <span className="hm-ellipsis">{text}</span>
      ) : (
        <UntrustedContent from={person.name} className="hm-untrusted-line">
          {text}
        </UntrustedContent>
      )}
      <span className="al-text-code hm-cell-time">{exactTime(last.item.at)}</span>
    </span>
  );
}

export function HomeScreen(props: HomeScreenProps): ReactElement {
  const clients = useClients(props);
  const { hood: pro } = usePrefs();
  const vt = useViewTransition();
  const agents = useLiveAgents();
  const current = agents.find((a) => a.current);
  const agentLabel = current?.label ?? '';
  const [view, setView] = useState<View>({ state: 'loading' });
  const [summaries, setSummaries] = useState<ReadonlyMap<string, PersonSummary>>(new Map());
  const [approvals, setApprovals] = useState<readonly ApprovalItem[]>([]);
  const [owner, setOwner] = useState<OwnerState>({ ready: false });
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const live = useRef(true);
  const summariesRef = useRef(summaries);
  summariesRef.current = summaries;
  const canPasskey = props.canPasskey ?? browserPasskeys();

  const loadApprovals = useCallback(async (): Promise<void> => {
    const [list, passkey] = await Promise.all([
      clients.approvals.list(),
      clients.approvals.passkey(),
    ]);
    if (!live.current) return;
    if (list.kind === 'ok') setApprovals(list.items);
    setOwner(
      passkey.kind === 'ready'
        ? {
            ready: true,
            ...(canPasskey && passkey.passkey !== undefined ? { passkey: passkey.passkey } : {}),
          }
        : { ready: false },
    );
  }, [clients, canPasskey]);

  const load = useCallback(async (): Promise<void> => {
    const [result] = await Promise.all([clients.people.load(), loadApprovals()]);
    if (!live.current) return;
    if (!result.ok) {
      setView((prev) =>
        prev.state === 'ready' ? prev : { state: 'failed', problem: result.problem },
      );
      return;
    }
    setView({ state: 'ready', data: result.data });
    // Each person's newest pages, only when their last activity changed or a message still waits.
    const known = summariesRef.current;
    const stale = result.data.people.slice(0, MAX_SUMMARIES).filter((p) => {
      const s = known.get(p.contactId);
      return s === undefined || s.lastAt !== p.lastAt || s.pending;
    });
    if (stale.length === 0) return;
    const fresh = await Promise.all(
      stale.map(async (p) => [p.contactId, await clients.people.summary(p)] as const),
    );
    if (!live.current) return;
    setSummaries((prev) => {
      const next = new Map(prev);
      for (const [id, s] of fresh) if (s !== undefined) next.set(id, s);
      return next;
    });
  }, [clients, loadApprovals]);

  const refresh = useCallback((): void => {
    setTick((t) => t + 1);
    void load();
  }, [load]);

  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  const pollMs = props.pollMs ?? HOME_POLL_MS;
  useEffect(() => {
    if (pollMs <= 0) return undefined;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refresh();
    }, pollMs);
    const onShown = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onShown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onShown);
    };
  }, [pollMs, refresh]);

  const passkey = useCallback(async (): Promise<DecisionPasskey | undefined> => {
    const answer = await clients.approvals.passkey();
    return answer.kind === 'ready' ? answer.passkey : undefined;
  }, [clients]);

  const toggle = (contactId: string, rowEl: HTMLElement | null): void => {
    const next = open === contactId ? undefined : contactId;
    vt.start(() => setOpen(next), {
      from: rowEl,
      to: () =>
        next === undefined ? rowEl : document.querySelector(`[data-person-open="${next}"]`),
    });
  };

  const sheet: SheetOptions = {
    ...(props.payConfirm === undefined ? {} : { payConfirm: props.payConfirm }),
    ...(props.platform === undefined ? {} : { platform: props.platform }),
    ...(props.reducedMotion === undefined ? {} : { reducedMotion: props.reducedMotion }),
  };

  const data = view.state === 'ready' ? view.data : undefined;
  const many = agents.length > 1;
  const otherAgent =
    pro && filter !== 'all' && current !== undefined && filter !== current.name
      ? agents.find((a) => a.name === filter)
      : undefined;
  const q = query.trim().toLowerCase();
  const people = (data?.people ?? []).filter(
    (p) => !pro || (otherAgent === undefined && (q === '' || p.name.toLowerCase().includes(q))),
  );
  const pending = props.pendingRows === undefined ? (data?.invites ?? []) : [];
  const now = Date.now();

  const peopleHead = (
    <div className="hm-people-head hm-f">
      <h2 id="hm-people-h" className="hm-kicker al-text-label">
        {S.people}
      </h2>
      {pro ? (
        <div className="hm-tools hm-f al-reveal">
          <label className="al-visually-hidden" htmlFor="hm-search">
            {S.searchPeople}
          </label>
          <span className="al-input-wrap hm-search">
            <span className="al-input-prefix" aria-hidden="true">
              <Icon name="search" size={14} />
            </span>
            <input
              id="hm-search"
              className="al-input"
              type="search"
              placeholder={S.searchPeople}
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </span>
          {many ? (
            <>
              <label className="al-visually-hidden" htmlFor="hm-agent">
                {S.handledBy}
              </label>
              <span className="al-input-wrap hm-agent">
                <select
                  id="hm-agent"
                  className="al-input"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">{S.allAgents}</option>
                  {agents.map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </span>
            </>
          ) : null}
          <a className="al-btn al-btn-primary al-btn-sm hm-invite-sm al-press" href={INVITE_HREF}>
            <Icon name="user-plus" size={16} />
            <span>{S.inviteSomeone}</span>
          </a>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="hm-page hm-c" data-layer={pro ? 'pro' : 'simple'}>
      <h1 className="al-visually-hidden">{S.title}</h1>
      {view.state === 'failed' ? (
        <Banner tone="warning">
          {view.problem === 'not_set_up'
            ? S.notSetUp
            : view.problem === 'session'
              ? S.sessionExpired
              : S.unavailable}{' '}
          <Button size="sm" onClick={refresh}>
            {S.tryAgain}
          </Button>
        </Banner>
      ) : null}
      <SkeletonGate
        loading={view.state === 'loading'}
        skeleton={<HomeSkeleton pro={pro} />}
        label={S.loading}
      >
        <div className="hm-stack hm-c">
          {props.getStarted ?? null}
          {props.ownerNotice ?? null}
          <HomeApprovals
            items={approvals}
            owner={owner}
            client={clients.approvals}
            sheet={sheet}
            pro={pro}
            onChanged={() => void loadApprovals()}
          />
          {notice === undefined ? null : (
            <p role="status" className="hm-notice al-text-body-sm">
              {notice}
            </p>
          )}
          {pro ? null : (
            <a
              className="al-btn al-btn-primary al-btn-lg al-btn-block hm-invite al-press"
              href={INVITE_HREF}
            >
              <Icon name="user-plus" size={22} />
              <span>{S.inviteSomeone}</span>
            </a>
          )}
          <section aria-labelledby="hm-people-h" className="hm-people hm-c">
            {peopleHead}
            {data !== undefined &&
            data.people.length === 0 &&
            pending.length === 0 &&
            props.pendingRows === undefined ? (
              <EmptyState
                title={S.noPeople}
                icon="users"
                action={<p className="al-text-body-sm al-muted">{S.noPeopleHint}</p>}
              />
            ) : (
              <div className="hm-list">
                {/* Under the hood, People is a table to assistive technology (rows and cells). */}
                <div
                  role={pro ? 'table' : undefined}
                  aria-label={pro ? S.people : undefined}
                  className="hm-table"
                >
                  {pro ? (
                    <div
                      className="hm-prow hm-prow-head al-text-label"
                      data-people-head=""
                      role="row"
                    >
                      <span role="columnheader">{S.colPerson}</span>
                      <span role="columnheader" className="hm-opt">
                        {S.colHandledBy}
                      </span>
                      <span role="columnheader">{S.colLastMessage}</span>
                      <span role="columnheader" className="hm-opt">
                        {S.colDelivery}
                      </span>
                      <span role="columnheader" className="hm-opt">
                        {S.colProofs}
                      </span>
                      <span role="columnheader" className="hm-opt">
                        {S.colFiles}
                      </span>
                      <span role="columnheader">
                        <span className="al-visually-hidden">{S.colOpen}</span>
                      </span>
                    </div>
                  ) : null}
                  {people.map((person) => {
                    const summary = summaries.get(person.contactId);
                    const isOpen = open === person.contactId;
                    const problem = summary?.delivery === 'not_delivered';
                    const delivery =
                      summary?.delivery === undefined
                        ? ''
                        : (DELIVERY_WORD[summary.delivery] ?? '');
                    return (
                      <div
                        key={person.contactId}
                        className="hm-person"
                        role={pro ? 'rowgroup' : undefined}
                        data-person={person.contactId}
                        data-open={isOpen ? 'true' : undefined}
                      >
                        {pro ? (
                          <div className="hm-prow hm-row" role="row">
                            <span role="cell" className="hm-cellbox hm-f">
                              <button
                                type="button"
                                className="hm-row-toggle hm-f"
                                aria-expanded={isOpen}
                                onClick={(e) =>
                                  toggle(person.contactId, e.currentTarget.closest('.hm-person'))
                                }
                              >
                                <Avatar name={person.name} small />
                                <PersonName name={person.name} />
                              </button>
                            </span>
                            <span role="cell" className="hm-opt hm-cell hm-f">
                              <span className="hm-ellipsis">{agentLabel}</span>
                            </span>
                            <span role="cell" className="hm-cellbox hm-f">
                              <LastText person={person} summary={summary} />
                            </span>
                            <span
                              role="cell"
                              className="hm-opt hm-cell hm-f"
                              data-delivery={summary?.delivery ?? 'none'}
                            >
                              {delivery}
                            </span>
                            <span role="cell" className="hm-opt al-text-code">
                              {summary === undefined ? '' : String(summary.proofs)}
                            </span>
                            <span role="cell" className="hm-opt al-text-code">
                              {summary === undefined ? '' : String(summary.files)}
                            </span>
                            <span role="cell" className="hm-cellbox hm-f">
                              <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={16} />
                            </span>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="hm-row"
                            aria-expanded={isOpen}
                            onClick={(e) =>
                              toggle(person.contactId, e.currentTarget.closest('.hm-person'))
                            }
                          >
                            <Avatar name={person.name} />
                            <span className="hm-row-main hm-c">
                              <PersonName name={person.name} />
                              <span className="hm-sub al-text-body-sm">
                                {person.lastAt > 0
                                  ? fmt(S.lastMessage, { when: ago(person.lastAt, now) })
                                  : S.noMessagesYet}
                                {summary === undefined ? '' : ` · ${filesText(summary.files)}`}
                                {many && agentLabel !== '' ? ` · ${agentLabel}` : ''}
                              </span>
                            </span>
                            {problem ? (
                              <span className="hm-problem hm-f">
                                <Icon name="triangle-alert" size={14} />
                                <span>{S.notDelivered}</span>
                              </span>
                            ) : null}
                            <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={18} />
                          </button>
                        )}
                        {isOpen && data !== undefined ? (
                          <OpenRow pro={pro}>
                            <PersonOpen
                              person={person}
                              contact={data.contacts.get(person.contactId)}
                              data={data}
                              clients={clients}
                              agent={agentLabel}
                              pro={pro}
                              tick={tick}
                              passkey={passkey}
                              refresh={refresh}
                              props={props}
                              {...(props.folderNote === undefined
                                ? {}
                                : { folderNote: props.folderNote })}
                              onChanged={(what) => {
                                if (what === 'remove') setOpen(undefined);
                                if (what === 'remove')
                                  setNotice(fmt(S.removed, { name: person.name }));
                                refresh();
                              }}
                            />
                          </OpenRow>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {data !== undefined && people.length === 0 && data.people.length > 0 ? (
                  <div className="hm-nomatch hm-f">
                    <p className="al-text-body-sm al-muted">{S.noMatch}</p>
                    {otherAgent === undefined ? null : (
                      <Button size="sm" onClick={() => void switchAgent(otherAgent.name)}>
                        {fmt(S.openAgent, { name: otherAgent.label })}
                      </Button>
                    )}
                  </div>
                ) : null}
                {props.pendingRows ??
                  pending.map((invite) => (
                    <PendingInviteRow
                      key={invite.inviteId}
                      invite={invite}
                      pro={pro}
                      agent={agentLabel}
                      api={clients.invites}
                      onCancelled={refresh}
                    />
                  ))}
              </div>
            )}
          </section>
        </div>
      </SkeletonGate>
    </div>
  );
}
