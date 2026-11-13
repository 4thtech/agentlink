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
// W8-S4 (F21): an ID whose removal stopped part-way is not a chip; Home says "{label} wasn't fully
// removed" with Finish removing (the Remove sheet in finish mode, here on Home).
//
// Loading: nothing under ~300 ms, then a skeleton shaped like Home (U0 SkeletonGate). Home looks
// again every few seconds while visible. Reading sends GETs only (I-4); whatever another party wrote
// is shown only inside the untrusted container (I-5); Save and Show in Finder send only an item ID.
import {
  AgentIcon,
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
import { initials } from '../../initials.js';
import { INVITE_PATH, PEOPLE_PATH } from '../../nav.js';
import { notify, setArchived, useArchived } from '../../notices/index.js';
import { checkHref } from '../contacts/safety.js';
import { CONTACTS_CHANGED } from '../../api/contact-changes.js';
import { PasteEntryLink } from '../invite/paste-entry.js';
import { createAgentsApi, type AgentsApi } from '../agents/api.js';
import type { AgentRow } from '../agents/data.js';
import { FinishRemoveSheet, UnfinishedRemoval } from '../agents/finish-remove.js';
import { createOwnerClient, type OwnerClient } from '../contacts/owner.js';
import type { PayConfirmClient } from '../../pay-confirm/index.js';
import { usePrefs } from '../../prefs/index.js';
import type { OwnerState, SheetOptions } from '../approvals/card.js';
import {
  createApprovalsClient,
  type ApprovalItem,
  type ApprovalsClient,
  type DecisionPasskey,
} from '../approvals/client.js';
import type { ContactRow } from '../contacts/data.js';
import {
  createInviteApi,
  type ConnectingRow,
  type InviteApi,
  type OpenInvite,
} from '../contacts/invite-api.js';
import { cancelProminent, connectingLine, useConnectingView } from '../invite/connecting-stage.js';
import { FEEDBACK_STRINGS as F, linkLabel } from '../invite/strings.js';
import {
  InviteLinkButtons,
  InviteLinkReveal,
  useInviteLink,
} from '../invite/invite-link-actions.js';
import { createFilesApi } from '../files/files-api.js';
import type { Conversation as Person, MessagesApi, Problem } from '../messages/api.js';
import { createSaveApi, type SaveApi } from '../inbox/save-api.js';
import { Conversation, exactTime, useThread } from './conversation.js';
import { useTerms } from './terms-trail.js';
import type { Preview } from './file-reader.js';
import { HomeApprovals } from './home-approvals.js';
import { RenameBanner } from './rename-banner.js';
import {
  createPeopleApi,
  MAX_SUMMARIES,
  type HomeData,
  type PeopleApi,
  type PersonSummary,
} from './people-api.js';
import { HOME_STRINGS as S, fmt, idWithApp } from './people-strings.js';
import { filesOf, PersonFiles, type Reveal } from './person-files.js';
import { PersonMenu } from './person-menu.js';
import { PersonName } from './person-name.js';
import './people.css';

/** How often Home looks again while the tab is visible. */
export const HOME_POLL_MS = 5_000;
/** Invite someone: U4's Invite screen (W4-WIRE). */
export const INVITE_HREF = INVITE_PATH;

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
  /** R1-UI-01: there is no ID yet: this replaces everything else on Home (a way to create the first one). */
  readonly noId?: ReactNode;
  /** W4-WIRE: keep the skeleton while the page still reads what goes on top (the Get started card). */
  readonly holding?: boolean;
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
  /** REL051-A34: open a saved received text file in the reader, by item ID only. */
  readonly preview: Preview;
  readonly invites: InviteApi;
  /** W8-S4: Finish removing (the Remove sheet's own calls). */
  readonly agents: AgentsApi;
  readonly owner: OwnerClient;
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
      preview: (id: string) => files.preview(id),
      invites: createInviteApi(opts),
      agents: createAgentsApi(opts),
      owner: createOwnerClient(opts),
    };
  }, [givenFetch, token, credentials, approvalsClient]);
}

type View =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly problem: Problem }
  | { readonly state: 'ready'; readonly data: HomeData };

const LIVE_EMPTY = { list: undefined, agents: [], error: false };
function useLiveAgents(): {
  readonly agents: readonly LiveAgent[];
  readonly rows: readonly AgentRow[];
} {
  const snap = useSyncExternalStore(subscribeLive, getLive, () => LIVE_EMPTY);
  return { agents: snap.agents, rows: snap.list?.agents ?? [] };
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
  const letter = initials(name);
  // A tint picked from the name, so a person keeps their colour (no image, no key).
  let tint = 0;
  for (const ch of name) tint = (tint * 31 + (ch.codePointAt(0) ?? 0)) % 2;
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
  app,
  idSeed,
  pro,
  tick,
  passkey,
  refresh,
  folderNote,
  props,
  onChanged,
  archived,
}: {
  readonly person: Person;
  readonly contact: ContactRow | undefined;
  readonly data: HomeData;
  readonly clients: Clients;
  readonly agent: string;
  /** The AI app that uses the open ID (for "You (Claude Code)"). */
  readonly app?: string | undefined;
  /** W7-ID-X1: the open ID's colour seed, set only when there is more than one ID. */
  readonly idSeed?: string | undefined;
  readonly pro: boolean;
  readonly tick: number;
  readonly passkey: () => Promise<DecisionPasskey | undefined>;
  readonly refresh: () => void;
  readonly folderNote?: ReactNode;
  readonly props: HomeScreenProps;
  readonly onChanged: (what: 'check' | 'rename' | 'remove') => void;
  /** A removed connection: whether it is archived, and the switch. */
  readonly archived?: { readonly is: boolean; readonly toggle: () => void } | undefined;
}): ReactElement {
  const messages: MessagesApi = clients.people.messages;
  const { thread, loadEarlier } = useThread(messages, person.contactId, tick);
  const terms = useTerms(clients.api, person.contactId, tick);
  const files = thread.state === 'ready' ? filesOf(thread.inbox.items, thread.sent.items) : [];
  const removed = contact?.status === 'revoked';
  const fileContext = useMemo(
    () => ({
      received: data.received,
      sent: data.sent,
      folder: data.inboxFolder,
      reveal: clients.reveal,
      preview: clients.preview,
    }),
    [data.received, data.sent, data.inboxFolder, clients.reveal, clients.preview],
  );
  return (
    <div className="hm-open hm-c al-expand" data-person-open={person.contactId}>
      {/* UX 2026-11-12: one calm line here; the full explanation is on the contact's own page. */}
      {removed ? (
        <Banner
          tone="neutral"
          icon="minus"
          compact
          className="hm-gone"
          action={
            archived === undefined ? undefined : (
              <ArchiveButton name={person.name} archived={archived.is} onToggle={archived.toggle} />
            )
          }
        >
          {fmt(S.connectionRemoved, { name: person.name })}.{' '}
          <a href={checkHref(person.contactId)} className="hm-gone-link">
            {S.details}
          </a>
        </Banner>
      ) : null}
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
        app={app}
        idSeed={idSeed}
        pro={pro}
        thread={thread}
        loadEarlier={loadEarlier}
        terms={terms}
        removed={removed}
        files={fileContext}
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
        {...(data.inboxFolder === undefined ? {} : { folder: data.inboxFolder })}
        {...(folderNote === undefined ? {} : { folderNote })}
      />
    </div>
  );
}

/** Archive (or Restore) a removed connection: out of People, conversation and files kept. */
function ArchiveButton({
  name,
  archived,
  onToggle,
}: {
  readonly name: string;
  readonly archived: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="hm-archive"
      aria-label={fmt(archived ? S.restoreLabel : S.archiveLabel, { name })}
      onClick={onToggle}
    >
      {archived ? S.restore : S.archive}
    </Button>
  );
}

const DAY_MS = 86_400_000;

/**
 * An invite that waits to be accepted: who, how long the link works, Copy link, Show link and
 * Cancel. The list carries no link; Copy link and Show link read the kept one on a click
 * (REL051-B2, owner test 13 Nov: Done without Copy no longer loses it).
 */
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
  const link = useInviteLink(
    invite.inviteId,
    api.link === undefined ? undefined : (id) => api.link!(id),
  );
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
        {api.link === undefined ? null : (
          <InviteLinkReveal link={link} label={linkLabel(name ?? '')} />
        )}
      </span>
      {api.link === undefined ? null : <InviteLinkButtons link={link} />}
      <Button
        size="sm"
        variant="ghost"
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

/**
 * W5-INVITE-FEEDBACK: an accept of this agent that waits for the inviter's answer. REL051-CF1
 * (R1-CLASS-01, -06): the line follows how long it has waited (connecting-stage.ts, shared with
 * People), and every row has Cancel through the server (`POST /api/ui/invites/connecting/cancel`),
 * so a row that will never finish can be removed. A blocked person also gets Unblock, which lives on
 * People. Text only (I-5).
 */
function ConnectingRowView({
  row: given,
  api,
}: {
  readonly row: ConnectingRow;
  readonly api: InviteApi;
}): ReactElement {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const view = useConnectingView(given);
  const row = view.row;
  const now = view.now;
  if (hidden) return <></>;
  return (
    <div className="hm-invite-row hm-f" data-blocked={row.blocked === true ? 'true' : undefined}>
      <span className="al-avatar hm-avatar is-pending" aria-hidden="true">
        {[...row.name][0]?.toUpperCase() ?? '?'}
      </span>
      <span className="hm-row-main hm-c">
        <PersonName name={row.name} />
        <span className="hm-sub al-text-body-sm">{connectingLine(row, now)}</span>
        {failed ? (
          <span role="alert" className="hm-inline-error al-text-body-sm">
            {F.cancelConnectingFailed}
          </span>
        ) : null}
      </span>
      {row.blocked === true ? (
        <a className="al-btn al-btn-secondary al-btn-sm" href={PEOPLE_PATH}>
          {F.unblockAction}
        </a>
      ) : null}
      {api.cancelConnecting === undefined ? null : (
        <Button
          size="sm"
          variant={cancelProminent(row, now) ? 'secondary' : 'ghost'}
          disabled={busy}
          onClick={() => {
            const cancel = api.cancelConnecting;
            if (cancel === undefined) return;
            setBusy(true);
            setFailed(false);
            void cancel(row.ref).then((outcome) => {
              setBusy(false);
              if (outcome.kind === 'cancelled' || outcome.kind === 'not_found') setHidden(true);
              else setFailed(true);
            });
          }}
        >
          {F.cancelConnecting}
        </Button>
      )}
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
  // W8-S4 (F21; 04 §2.5 "Finishing a removal"): an ID whose removal stopped part-way is never a
  // usable ID here (no chip); Home names it with Finish removing instead.
  const liveIds = useLiveAgents();
  const agents = useMemo(() => liveIds.agents.filter((a) => !a.removing), [liveIds.agents]);
  const unfinished = liveIds.rows.filter((r) => r.removing);
  const [finishing, setFinishing] = useState<AgentRow | undefined>(undefined);
  const current = agents.find((a) => a.current);
  const appName = current?.apps[0]?.app;
  const agentLabel = idWithApp(current?.label ?? '', appName);
  const [view, setView] = useState<View>({ state: 'loading' });
  const [summaries, setSummaries] = useState<ReadonlyMap<string, PersonSummary>>(new Map());
  const [approvals, setApprovals] = useState<readonly ApprovalItem[]>([]);
  const [owner, setOwner] = useState<OwnerState>({ ready: false });
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
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
    // R1-UI-13: a failed passkey read changes nothing (the notice above says "couldn't check").
    if (passkey.kind === 'unknown') {
      setOwner((prev) => (prev.ready ? prev : { ready: true }));
      return;
    }
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

  // W5-INVITE-FEEDBACK: a contact or invite changed (the stream): read again at once.
  useEffect(() => {
    window.addEventListener(CONTACTS_CHANGED, refresh);
    return () => window.removeEventListener(CONTACTS_CHANGED, refresh);
  }, [refresh]);

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
    filter !== 'all' && current !== undefined && filter !== current.name
      ? agents.find((a) => a.name === filter)
      : undefined;
  const q = query.trim().toLowerCase();
  const archivedRefs = useArchived(current?.name);
  const isGone = (contactId: string): boolean =>
    data?.contacts.get(contactId)?.status === 'revoked';
  // UX 2026-11-12: a removed connection the owner archived leaves People for "Archived" (kept).
  const isArchived = (contactId: string): boolean =>
    isGone(contactId) && archivedRefs.has(contactId.toLowerCase());
  const matching = (data?.people ?? []).filter(
    (p) => otherAgent === undefined && (!pro || q === '' || p.name.toLowerCase().includes(q)),
  );
  const people = matching.filter((p) => !isArchived(p.contactId));
  const archivedPeople = matching.filter((p) => isArchived(p.contactId));
  // Two people with the same name look alike: their rows add the ID tag that tells them apart.
  const nameCount = new Map<string, number>();
  for (const p of [...people, ...archivedPeople]) {
    const key = p.name.trim().toLowerCase();
    nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
  }
  const sameNameNote = (p: Person): string => {
    if ((nameCount.get(p.name.trim().toLowerCase()) ?? 0) < 2) return '';
    const tag = data?.contacts.get(p.contactId)?.fingerprint;
    return tag === undefined ? '' : ` · ${S.idTag} ${tag}`;
  };
  const archiveToggle = (contactId: string) =>
    current === undefined || !isGone(contactId)
      ? undefined
      : {
          is: isArchived(contactId),
          toggle: () => {
            if (open === contactId) setOpen(undefined);
            setArchived(current.name, contactId, !isArchived(contactId));
          },
        };
  const pending = props.pendingRows === undefined ? (data?.invites ?? []) : [];
  const connectingRows = props.pendingRows === undefined ? (data?.connecting ?? []) : [];
  const now = Date.now();

  // W7-ID-X1: with more than one ID, chips filter by ID ("All IDs · Tali · Tali work"). Only the open
  // ID's people are on this computer's page, so its chip carries their count; another ID's chip opens it.
  // Counts are what Home was told: the open ID's own list, the other IDs' from the all-IDs read.
  const countOf = (a: { readonly name: string; readonly current: boolean }): number | undefined =>
    a.current ? data?.people.length : data?.idCounts?.get(a.name);
  const allCount = ((): number | undefined => {
    const counts = agents.map(countOf);
    return data === undefined || counts.some((c) => c === undefined)
      ? undefined
      : counts.reduce<number>((n, c) => n + (c ?? 0), 0);
  })();
  const otherLine = (a: { readonly name: string; readonly label: string }): string => {
    const n = data?.idCounts?.get(a.name);
    if (n === undefined) return fmt(S.otherIdUnknown, { name: a.label });
    if (n === 0) return fmt(S.otherIdNone, { name: a.label });
    return n === 1
      ? fmt(S.otherIdOne, { name: a.label })
      : fmt(S.otherIdPeople, { name: a.label, count: String(n) });
  };
  // R1-UI-07: in "All IDs", another ID's people are not on this page (its names are sealed in its
  // own store, 04 §2.5), so each other ID that has people gets its line and an Open button. The
  // empty state is for when no ID has anyone.
  const othersWithPeople =
    filter === 'all' && many
      ? agents.filter((a) => !a.current && (data?.idCounts?.get(a.name) ?? 0) > 0)
      : [];
  const otherIdRows = othersWithPeople.map((a) => (
    <div className="hm-nomatch hm-f" data-other-id={a.name} key={`other-${a.name}`}>
      <p className="al-text-body-sm al-muted">{otherLine(a)}</p>
      <Button size="sm" onClick={() => void switchAgent(a.name)}>
        {fmt(S.openAgent, { name: a.label })}
      </Button>
    </div>
  ));
  const idChips = many ? (
    <div className="hm-id-chips hm-f" role="group" aria-label={S.idChips} data-id-chips="">
      <button
        type="button"
        className="hm-id-chip al-press"
        aria-pressed={filter === 'all'}
        onClick={() => setFilter('all')}
      >
        {S.allAgents}
        {allCount === undefined ? null : (
          <span className="hm-id-count al-text-code">{allCount}</span>
        )}
      </button>
      {agents.map((a) => (
        <button
          key={a.name}
          type="button"
          className="hm-id-chip hm-f al-press"
          data-id-chip={a.name}
          aria-pressed={filter === a.name}
          onClick={() => setFilter(a.name)}
        >
          <AgentIcon label={a.label} seed={a.name} />
          <span>{idWithApp(a.label, a.apps[0]?.app)}</span>
          {countOf(a) === undefined ? null : (
            <span className="hm-id-count al-text-code">{countOf(a)}</span>
          )}
        </button>
      ))}
    </div>
  ) : null;

  const personRow = (person: Person): ReactElement => {
    const summary = summaries.get(person.contactId);
    const isOpen = open === person.contactId;
    // W6-FLOW-FIXES: the other side removed this connection (its agent was
    // retired: contact status `revoked`). Say so on the row; nothing can be sent.
    const gone = data?.contacts.get(person.contactId)?.status === 'revoked';
    const problem = !gone && summary?.delivery === 'not_delivered';
    const delivery = summary?.delivery === undefined ? '' : (DELIVERY_WORD[summary.delivery] ?? '');
    const archive = archiveToggle(person.contactId);
    const archiveButton =
      archive === undefined ? null : (
        <ArchiveButton name={person.name} archived={archive.is} onToggle={archive.toggle} />
      );
    const simpleRow = (
      <button
        type="button"
        className="hm-row"
        aria-expanded={isOpen}
        onClick={(e) => toggle(person.contactId, e.currentTarget.closest('.hm-person'))}
      >
        <Avatar name={person.name} />
        <span className="hm-row-main hm-c">
          <PersonName name={person.name} />
          <span className="hm-sub hm-f al-text-body-sm">
            {many && current !== undefined ? (
              <AgentIcon label={current.label} seed={current.name} />
            ) : null}
            {gone
              ? fmt(S.connectionRemoved, { name: person.name })
              : person.lastAt > 0
                ? fmt(S.lastMessage, { when: ago(person.lastAt, now) })
                : S.noMessagesYet}
            {summary === undefined ? '' : ` · ${filesText(summary.files)}`}
            {many && agentLabel !== '' ? ` · ${agentLabel}` : ''}
            {sameNameNote(person)}
          </span>
        </span>
        {problem ? (
          <span className="hm-problem hm-f">
            <Icon name="triangle-alert" size={14} />
            <span>{S.notDelivered}</span>
          </span>
        ) : null}
        <Icon name="chevron-right" size={18} className={isOpen ? 'hm-chev is-open' : 'hm-chev'} />
      </button>
    );
    return (
      <div
        key={person.contactId}
        className="hm-person"
        role={pro ? 'rowgroup' : undefined}
        data-person={person.contactId}
        data-open={isOpen ? 'true' : undefined}
        data-removed={gone ? 'true' : undefined}
      >
        {pro ? (
          <div className="hm-prow hm-row" role="row">
            <span role="cell" className="hm-cellbox hm-f">
              <button
                type="button"
                className="hm-row-toggle hm-f"
                aria-expanded={isOpen}
                onClick={(e) => toggle(person.contactId, e.currentTarget.closest('.hm-person'))}
              >
                <Avatar name={person.name} small />
                <PersonName name={person.name} />
              </button>
            </span>
            <span role="cell" className="hm-opt hm-cell hm-f">
              {many && current !== undefined ? (
                <AgentIcon label={current.label} seed={current.name} />
              ) : null}
              <span className="hm-ellipsis">{agentLabel}</span>
            </span>
            <span role="cell" className="hm-cellbox hm-f">
              {gone ? (
                <span className="hm-sub al-text-body-sm">
                  {fmt(S.connectionRemoved, { name: person.name })}
                </span>
              ) : (
                <LastText person={person} summary={summary} />
              )}
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
              {archiveButton}
              <Icon
                name="chevron-right"
                size={16}
                className={isOpen ? 'hm-chev is-open' : 'hm-chev'}
              />
            </span>
          </div>
        ) : archiveButton === null ? (
          simpleRow
        ) : (
          <div className="hm-gone-row">
            {simpleRow}
            {archiveButton}
          </div>
        )}
        {isOpen && data !== undefined ? (
          <OpenRow pro={pro}>
            <PersonOpen
              person={person}
              contact={data.contacts.get(person.contactId)}
              data={data}
              clients={clients}
              agent={agentLabel}
              app={appName}
              idSeed={many ? current?.name : undefined}
              pro={pro}
              tick={tick}
              passkey={passkey}
              refresh={refresh}
              props={props}
              {...(props.folderNote === undefined ? {} : { folderNote: props.folderNote })}
              archived={archive}
              onChanged={(what) => {
                if (what === 'remove') setOpen(undefined);
                if (what === 'remove') notify({ text: fmt(S.removed, { name: person.name }) });
                refresh();
              }}
            />
          </OpenRow>
        ) : null}
      </div>
    );
  };

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
          <a className="al-btn al-btn-primary al-btn-sm hm-invite-sm al-press" href={INVITE_HREF}>
            <Icon name="user-plus" size={16} />
            <span>{S.inviteSomeone}</span>
          </a>
          <PasteEntryLink className="inv-link-button" />
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="hm-page hm-c" data-layer={pro ? 'pro' : 'simple'}>
      <h1 className="al-visually-hidden">{S.title}</h1>
      {/* REL051-INTFIX: an approval waits but there is no ID yet: the reason stays above the
          "Create your first ID" card, so whoever came for that approval learns why it can't be
          approved here yet. */}
      {props.noId !== undefined && approvals.length > 0 ? (props.ownerNotice ?? null) : null}
      {props.noId !== undefined ? props.noId : null}
      {props.noId === undefined && view.state === 'failed' ? (
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
      {props.noId !== undefined ? null : (
        <SkeletonGate
          loading={view.state === 'loading' || props.holding === true}
          skeleton={<HomeSkeleton pro={pro} />}
          label={S.loading}
        >
          <div className="hm-stack hm-c">
            {props.getStarted ?? null}
            {props.ownerNotice ?? null}
            {unfinished.map((row) => (
              <UnfinishedRemoval key={row.name} row={row} onFinish={setFinishing} />
            ))}
            {/* WP-1: an ID whose card still carries an older name: repaired here, one gesture. */}
            <RenameBanner
              api={clients.agents}
              owner={clients.owner}
              row={liveIds.rows.find((r) => r.current && !r.removing)}
            />
            <HomeApprovals
              items={approvals}
              owner={owner}
              client={clients.approvals}
              sheet={sheet}
              pro={pro}
              asker={
                current === undefined
                  ? undefined
                  : appName === undefined
                    ? fmt(S.askerId, { name: current.label })
                    : fmt(S.askerApp, { name: current.label, app: appName })
              }
              askerSeed={many ? current?.name : undefined}
              askerLabel={many ? agentLabel : undefined}
              onChanged={() => void loadApprovals()}
            />
            {pro ? null : (
              <a
                className="al-btn al-btn-primary al-btn-lg al-btn-block hm-invite al-press"
                href={INVITE_HREF}
              >
                <Icon name="user-plus" size={22} />
                <span>{S.inviteSomeone}</span>
              </a>
            )}
            {/* W5-PASTE-ENTRY: the other way in, right next to Invite someone. */}
            {pro ? null : <PasteEntryLink className="inv-link-button" />}
            <section aria-labelledby="hm-people-h" className="hm-people hm-c">
              {peopleHead}
              {idChips}
              {many && current !== undefined && people.length > 0 ? (
                <h3 className="hm-id-group hm-f al-text-label" data-id-group={current.name}>
                  <AgentIcon label={current.label} seed={current.name} />
                  <span>{agentLabel}</span>
                </h3>
              ) : null}
              {otherAgent !== undefined ? (
                <div className="hm-nomatch hm-f" data-other-id="">
                  <p className="al-text-body-sm al-muted">{otherLine(otherAgent)}</p>
                  <Button size="sm" onClick={() => void switchAgent(otherAgent.name)}>
                    {fmt(S.openAgent, { name: otherAgent.label })}
                  </Button>
                </div>
              ) : data !== undefined &&
                data.people.length === 0 &&
                pending.length === 0 &&
                connectingRows.length === 0 &&
                othersWithPeople.length === 0 &&
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
                    {people.map(personRow)}
                  </div>
                  {data !== undefined &&
                  people.length === 0 &&
                  archivedPeople.length === 0 &&
                  data.people.length > 0 ? (
                    <div className="hm-nomatch hm-f">
                      <p className="al-text-body-sm al-muted">{S.noMatch}</p>
                    </div>
                  ) : null}
                  {connectingRows.map((row) => (
                    <ConnectingRowView key={`c-${row.ref}`} row={row} api={clients.invites} />
                  ))}
                  {otherIdRows}
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
              {archivedPeople.length === 0 ? null : (
                <details className="hm-archived" data-archived="">
                  <summary className="hm-kicker al-text-label">
                    {fmt(S.archivedCount, { count: archivedPeople.length })}
                  </summary>
                  <p className="al-text-body-sm al-muted">{S.archivedHint}</p>
                  <div className="hm-list">
                    <div
                      role={pro ? 'table' : undefined}
                      aria-label={pro ? S.archived : undefined}
                      className="hm-table"
                    >
                      {archivedPeople.map(personRow)}
                    </div>
                  </div>
                </details>
              )}
            </section>
          </div>
        </SkeletonGate>
      )}
      {finishing === undefined ? null : (
        <FinishRemoveSheet
          row={finishing}
          api={clients.agents}
          owner={clients.owner}
          onClose={() => setFinishing(undefined)}
        />
      )}
    </div>
  );
}
