// The Inbox, the home of the wave-4 app (W4-INBOX; Decision 40; 08 §1 Inbox; b11 §34.4, styled from
// d2 `console/negotiation-thread--waiting-for-approval` and `console/home--approvals-waiting`; D-116).
//
// - "Needs you" on top: requests waiting for the owner's approval (each a card with Approve and Deny
//   and the presence step inline: "Confirm with your passkey" or the backup code), new messages, and
//   files that arrived and are not saved (with "Save to Inbox"). "All caught up" when it is empty.
// - Conversations per contact below. A conversation shows the messages both ways and their files
//   inline (a received file with its state and Save), with that contact's approvals as cards beside
//   it, and "To reply, ask your AI."
//
// Security (04 §2.5, §4; D-118; I-4, I-5, I-7):
// - Approving uses the existing approval routes (approvals/client.ts decide: the digest header and
//   the owner's presence in the body), through approvals/card.tsx SingleApproval: no new way to
//   approve, and never without presence. Paid requests open the confirmation sheet as on Approvals.
// - Save sends only the item's ID (save-api.ts); core saves into the Inbox folder.
// - Everything another party wrote (message text, file names) is shown only inside the untrusted
//   container, as plain text with inert links: never in a heading, a status line or a button.
// - Reading here is only GETs. The "seen" marker is this browser's (messages/seen.ts): opening a
//   conversation never marks anything read for the AI.
//
// Until the shell routes `/inbox` (D1 owns the router and the sidebar), the page is reachable from
// tests by rendering it directly; it reads its selection from `?c=<contactId>` on its own path and
// goes back to the list on the router's navigate event (a click on the sidebar's Inbox).
import { Banner, Button, EmptyState, Skeleton, Surface, UntrustedContent } from '@4thtech-io/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { AddContactAction } from '../home/start-here-empty.js';
import { SingleApproval, type OwnerState } from '../approvals/card.js';
import {
  createApprovalsClient,
  type ApprovalItem,
  type ApprovalsClient,
  type DecisionPasskey,
} from '../approvals/client.js';
import { parseReceived, type ReceivedItem } from '../files/io-api.js';
import { sizeText } from '../files/io.js';
import {
  createMessagesApi,
  type Conversation,
  type MessageItem,
  type MessagesApi,
  type Problem,
} from '../messages/api.js';
import { loadSeen, markSeen, SEEN_EVENT, type Seen } from '../messages/seen.js';
import { createSaveApi, type SaveApi } from './save-api.js';
import { SaveFile } from './save.js';
import { INBOX_STRINGS as S, fmt } from './strings.js';
import './inbox.css';

const RECEIVED_PATH = '/api/ui/files/received?limit=100';
/** How often the Inbox looks again while the tab is visible. */
const POLL_MS = 5_000;
/** At most this many new conversations get a preview read per refresh. */
const MAX_PREVIEWS = 5;
const NAVIGATE_EVENT = 'agentlink:navigate';
const CONTACT_PARAM = 'c';
const CONTACT_ID = /^[A-Za-z0-9._:~-]{1,128}$/;

const DAY = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function When({ at }: { readonly at: number }): ReactElement | null {
  if (at <= 0) return null;
  const d = new Date(at * 1000);
  return <time dateTime={d.toISOString()}>{DAY.format(d)}</time>;
}

/** The contact the address names, when it is a well-formed ID; never anything else. */
function contactInAddress(): string | undefined {
  if (typeof location === 'undefined') return undefined;
  const value = new URLSearchParams(location.search).get(CONTACT_PARAM);
  return value !== null && CONTACT_ID.test(value) ? value : undefined;
}

/**
 * The display name an approval names (`"Ana" (self-declared)` → `Ana`), to place its card in that
 * conversation too. Display only: the card itself is the same everywhere.
 */
const whoOf = (item: ApprovalItem): string =>
  (item.details?.who ?? '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .replace(/^["\u201c\u2018']+|["\u201d\u2019']+$/g, '');

const fileId = (envelopeId: string, index: number): string =>
  `${envelopeId}.${String(index).padStart(2, '0')}`;

interface Snapshot {
  readonly conversations: readonly Conversation[];
  readonly received: readonly ReceivedItem[];
  readonly approvals: readonly ApprovalItem[];
  readonly owner: OwnerState;
  /** The newest inbound message of each conversation with something new. */
  readonly latest: Readonly<Record<string, MessageItem>>;
}

type View =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly problem: Problem }
  | { readonly state: 'ready'; readonly data: Snapshot; readonly stale?: Problem };

export interface InboxPageProps {
  /** Test seams: the fetch, session token and passkey container; the page's own when absent. */
  readonly fetch?: typeof fetch;
  readonly token?: string;
  readonly credentials?: CredentialsContainer;
}

interface Clients {
  readonly api: ApiClient;
  readonly messages: MessagesApi;
  readonly approvals: ApprovalsClient;
  readonly save: SaveApi;
}

function useClients({ fetch: givenFetch, token, credentials }: InboxPageProps): Clients {
  return useMemo(() => {
    const opts = {
      ...(givenFetch === undefined ? {} : { fetch: givenFetch }),
      ...(token === undefined ? {} : { token }),
    };
    const api = createApiClient(opts);
    return {
      api,
      messages: createMessagesApi(api),
      approvals: createApprovalsClient({
        ...opts,
        ...(credentials === undefined ? {} : { credentials }),
      }),
      save: createSaveApi({ ...opts, ...(credentials === undefined ? {} : { credentials }) }),
    };
  }, [givenFetch, token, credentials]);
}

async function readSnapshot(c: Clients, seen: Seen): Promise<Snapshot | Problem> {
  const [conversations, received, approvals, passkey] = await Promise.all([
    c.messages.conversations(),
    c.api.get<unknown>(RECEIVED_PATH),
    c.approvals.list(),
    c.approvals.passkey(),
  ]);
  if (!conversations.ok) return conversations.problem;
  const feed = received.kind === 'ok' ? parseReceived(received.data) : undefined;
  const owner: OwnerState =
    passkey.kind === 'ready'
      ? { ready: true, ...(passkey.passkey === undefined ? {} : { passkey: passkey.passkey }) }
      : { ready: false };
  const fresh = conversations.value
    .filter((x) => x.lastInAt > (seen[x.contactId] ?? 0))
    .slice(0, MAX_PREVIEWS);
  const latest: Record<string, MessageItem> = {};
  await Promise.all(
    fresh.map(async (x) => {
      const page = await c.messages.messages(x.contactId, 'in');
      const first = page.ok ? page.value.items[0] : undefined;
      if (first !== undefined) latest[x.contactId] = first;
    }),
  );
  return {
    conversations: [...conversations.value].sort((a, b) => b.lastAt - a.lastAt),
    received: feed?.items ?? [],
    approvals: approvals.kind === 'ok' ? approvals.items : [],
    owner,
    latest,
  };
}

/** One approval as a card (an article), the presence step inline. */
function ApprovalCard({
  item,
  owner,
  client,
  onDecided,
}: {
  readonly item: ApprovalItem;
  readonly owner: OwnerState;
  readonly client: ApprovalsClient;
  readonly onDecided: () => void;
}): ReactElement {
  return (
    <article className="ib-approval" aria-label={S.approvalLabel}>
      <p className="ib-kicker al-text-label">{S.approvalLabel}</p>
      <SingleApproval
        item={item}
        owner={owner}
        client={client}
        sheet={{}}
        passkeyLabel={S.confirmPasskey}
        compact
        onDecided={onDecided}
      />
    </article>
  );
}

/** A received file's state and, while it waits, Save. */
function ReceivedFileState({
  file,
  save,
  passkey,
  onSaved,
}: {
  readonly file: ReceivedItem | undefined;
  readonly save: SaveApi;
  readonly passkey: () => Promise<DecisionPasskey | undefined>;
  readonly onSaved: () => void;
}): ReactElement | null {
  if (file === undefined) return null;
  if (file.state === 'saved') {
    return (
      <p className="ib-file-state al-text-body-sm">
        {S.savedAs}{' '}
        {file.savedName === null ? null : (
          <UntrustedContent from={file.from} fileName={file.savedName} />
        )}
      </p>
    );
  }
  if (file.state === 'expired') {
    return <p className="ib-file-state al-text-body-sm al-muted">{S.expired}</p>;
  }
  if (file.state !== 'not_saved') return null;
  return (
    <>
      <p className="ib-file-state al-text-body-sm al-muted">{S.arrivedNotSaved}</p>
      <SaveFile id={file.id} api={save} passkey={passkey} onSaved={onSaved} />
    </>
  );
}

function NeedsYou({
  data,
  seen,
  clients,
  passkey,
  refresh,
  open,
}: {
  readonly data: Snapshot;
  readonly seen: Seen;
  readonly clients: Clients;
  readonly passkey: () => Promise<DecisionPasskey | undefined>;
  readonly refresh: () => void;
  readonly open: (contactId: string) => void;
}): ReactElement {
  const fresh = data.conversations.filter((c) => c.lastInAt > (seen[c.contactId] ?? 0));
  // A file stays here after Save until the page is left, so its "Saved as" shows.
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const files = data.received.filter((f) => f.state === 'not_saved' || kept.has(f.id));
  const empty = data.approvals.length === 0 && fresh.length === 0 && files.length === 0;
  return (
    <section className="ib-section" data-section="needs-you" aria-labelledby="ib-needs-you">
      <h2 id="ib-needs-you" className="al-text-label ib-section-title">
        {S.needsYou}
      </h2>
      {empty ? (
        <EmptyState
          title={S.allCaughtUp}
          icon="check"
          action={<p className="al-text-body-sm al-muted">{S.allCaughtUpHint}</p>}
        />
      ) : (
        <ul className="ib-needs">
          {data.approvals.map((item) => (
            <li key={item.approvalId}>
              <ApprovalCard
                item={item}
                owner={data.owner}
                client={clients.approvals}
                onDecided={refresh}
              />
            </li>
          ))}
          {fresh.map((c) => {
            const latest = data.latest[c.contactId];
            return (
              <li key={`m-${c.contactId}`}>
                {/* The whole row opens the conversation; the button is its keyboard target. */}
                <Surface level={1} className="ib-row" data-row="message">
                  <div
                    className="ib-row-body"
                    onClick={() => open(c.contactId)}
                    data-contact={c.contactId}
                  >
                    <p className="ib-row-head al-text-body-sm">
                      <span className="al-chip al-tone-info al-text-label">{S.newMessage}</span>
                      <bdi>{c.name}</bdi>
                      <When at={c.lastInAt} />
                    </p>
                    {latest === undefined || latest.text === '' ? null : (
                      <UntrustedContent from={c.name} kind="message" className="ib-preview">
                        {latest.text}
                      </UntrustedContent>
                    )}
                  </div>
                  <Button size="sm" onClick={() => open(c.contactId)}>
                    {fmt(S.conversationWith, { name: c.name })}
                  </Button>
                </Surface>
              </li>
            );
          })}
          {files.map((f) => (
            <li key={`f-${f.id}`}>
              <Surface level={1} className="ib-row" data-row="file">
                <p className="ib-row-head al-text-body-sm">
                  <bdi>{fmt(S.fileFrom, { name: f.from })}</bdi>
                  <When at={f.at} />
                  <span className="al-muted">{sizeText(f.size)}</span>
                </p>
                <UntrustedContent from={f.from} fileName={f.name} />
                <ReceivedFileState
                  file={f}
                  save={clients.save}
                  passkey={passkey}
                  onSaved={() => {
                    setKept((k) => new Set([...k, f.id]));
                    refresh();
                  }}
                />
              </Surface>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConversationList({
  list,
  seen,
  open,
}: {
  readonly list: readonly Conversation[];
  readonly seen: Seen;
  readonly open: (contactId: string) => void;
}): ReactElement {
  return (
    <section className="ib-section" data-section="conversations" aria-labelledby="ib-conv">
      <h2 id="ib-conv" className="al-text-label ib-section-title">
        {S.conversations}
      </h2>
      {list.length === 0 ? (
        <EmptyState
          title={S.noConversations}
          icon="users"
          action={
            <>
              <p className="al-text-body-sm al-muted">{S.noConversationsHint}</p>
              <AddContactAction />
            </>
          }
        />
      ) : (
        <Surface level={1} className="ib-list">
          <ul>
            {list.map((c) => {
              const isNew = c.lastInAt > (seen[c.contactId] ?? 0);
              return (
                <li key={c.contactId}>
                  <button
                    type="button"
                    className="ib-conv"
                    data-contact={c.contactId}
                    onClick={() => open(c.contactId)}
                  >
                    <span className={isNew ? 'al-text-body ib-new' : 'al-text-body'}>
                      <bdi>{c.name}</bdi>
                    </span>
                    <span className="al-text-body-sm al-muted">
                      <When at={c.lastAt} />
                    </span>
                    {isNew ? (
                      <span className="al-chip al-tone-info al-text-label">{S.newMessage}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </Surface>
      )}
    </section>
  );
}

type Thread =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly problem: Problem }
  | {
      readonly state: 'ready';
      readonly items: readonly { readonly item: MessageItem; readonly out: boolean }[];
    };

function ConversationView({
  contact,
  data,
  clients,
  passkey,
  tick,
  refresh,
  back,
}: {
  readonly contact: Conversation;
  readonly data: Snapshot;
  readonly clients: Clients;
  readonly passkey: () => Promise<DecisionPasskey | undefined>;
  readonly tick: number;
  readonly refresh: () => void;
  readonly back: () => void;
}): ReactElement {
  const [thread, setThread] = useState<Thread>({ state: 'loading' });
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [contact.contactId]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const [inbox, sent] = await Promise.all([
        clients.messages.messages(contact.contactId, 'in'),
        clients.messages.messages(contact.contactId, 'out'),
      ]);
      if (!live) return;
      if (!inbox.ok || !sent.ok) {
        const problem = !inbox.ok ? inbox.problem : sent.ok ? 'error' : sent.problem;
        setThread((prev) => (prev.state === 'ready' ? prev : { state: 'failed', problem }));
        return;
      }
      // Each page is newest first: reversed, then a stable sort by time keeps the order of messages
      // sent in the same second. A message with no text and no file (a bare offer or answer) shows as
      // its approval card instead.
      const items = [
        ...[...inbox.value.items].reverse().map((item) => ({ item, out: false })),
        ...[...sent.value.items].reverse().map((item) => ({ item, out: true })),
      ]
        .filter(({ item }) => item.text !== '' || item.files.length > 0)
        .sort((a, b) => a.item.at - b.item.at);
      setThread({ state: 'ready', items });
    })();
    return () => {
      live = false;
    };
  }, [clients, contact.contactId, tick]);

  const files = useMemo(() => new Map(data.received.map((f) => [f.id, f])), [data.received]);
  const approvals = data.approvals.filter((a) => whoOf(a) === contact.name);

  return (
    <section className="ib-thread" data-section="conversation">
      <div className="ib-thread-head">
        <Button size="sm" onClick={back}>
          {S.backToInbox}
        </Button>
        <h2 ref={heading} tabIndex={-1} className="al-text-title">
          {fmt(S.conversationWith, { name: contact.name })}
        </h2>
      </div>
      <div className="ib-thread-layout">
        <div className="ib-thread-main">
          {thread.state === 'loading' ? <Skeleton loading label={S.loading} lines={3} /> : null}
          {thread.state === 'failed' ? <Banner tone="warning">{S.unavailable}</Banner> : null}
          {thread.state === 'ready' && thread.items.length === 0 ? (
            <p className="al-text-body al-muted">{fmt(S.noMessages, { name: contact.name })}</p>
          ) : null}
          {thread.state === 'ready' ? (
            <ol className="ib-messages">
              {thread.items.map(({ item, out }) => (
                <Surface
                  as="li"
                  level={1}
                  key={`${out ? 'o' : 'i'}-${item.id}`}
                  className={out ? 'ib-msg is-out' : 'ib-msg'}
                >
                  <p className="ib-msg-meta al-text-body-sm al-muted">
                    <span>{out ? S.fromYou : fmt(S.fromThem, { name: contact.name })}</span>
                    <When at={item.at} />
                  </p>
                  {item.text === '' ? null : (
                    <UntrustedContent from={out ? S.fromYou : contact.name} kind="message">
                      {item.text}
                    </UntrustedContent>
                  )}
                  {item.files.map((file, i) => (
                    <div className="ib-file" key={i}>
                      <UntrustedContent
                        from={out ? S.fromYou : contact.name}
                        fileName={file.name}
                      />
                      <span className="al-text-body-sm al-muted">{sizeText(file.size)}</span>
                      {out ? (
                        <p className="ib-file-state al-text-body-sm al-muted">{S.sentFile}</p>
                      ) : (
                        <ReceivedFileState
                          file={files.get(fileId(item.id, i))}
                          save={clients.save}
                          passkey={passkey}
                          onSaved={refresh}
                        />
                      )}
                    </div>
                  ))}
                </Surface>
              ))}
            </ol>
          ) : null}
          <p className="ib-reply al-text-body-sm al-muted">{S.replyHint}</p>
        </div>
        {approvals.length === 0 ? null : (
          <aside className="ib-thread-aside">
            {approvals.map((item) => (
              <ApprovalCard
                key={item.approvalId}
                item={item}
                owner={data.owner}
                client={clients.approvals}
                onDecided={refresh}
              />
            ))}
          </aside>
        )}
      </div>
    </section>
  );
}

export function InboxPage(props: InboxPageProps = {}): ReactElement {
  const clients = useClients(props);
  const [view, setView] = useState<View>({ state: 'loading' });
  const [seen, setSeen] = useState<Seen>(() => loadSeen());
  const [selected, setSelected] = useState<string | undefined>(() => contactInAddress());
  const [tick, setTick] = useState(0);
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const live = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    const result = await readSnapshot(clients, seenRef.current);
    if (!live.current) return;
    setView((prev) =>
      typeof result === 'string'
        ? prev.state === 'ready'
          ? { ...prev, stale: result }
          : { state: 'failed', problem: result }
        : { state: 'ready', data: result },
    );
  }, [clients]);

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

  // Look again every few seconds while visible, and once when the tab comes back.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refresh();
    }, POLL_MS);
    const onShown = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onShown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onShown);
    };
  }, [refresh]);

  // The address is the selection: the sidebar's Inbox link (the router's navigate event) and Back
  // (popstate) bring the list back; another tab's "seen" updates the badges.
  useEffect(() => {
    const sync = (): void => setSelected(contactInAddress());
    const reseen = (): void => setSeen(loadSeen());
    window.addEventListener(NAVIGATE_EVENT, sync);
    window.addEventListener('popstate', sync);
    window.addEventListener(SEEN_EVENT, reseen);
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, sync);
      window.removeEventListener('popstate', sync);
      window.removeEventListener(SEEN_EVENT, reseen);
    };
  }, []);

  const data = view.state === 'ready' ? view.data : undefined;
  const contact =
    selected === undefined ? undefined : data?.conversations.find((c) => c.contactId === selected);

  // Opening a conversation marks its inbound messages seen in this browser only.
  useEffect(() => {
    if (contact !== undefined && contact.lastInAt > 0) {
      setSeen(markSeen(contact.contactId, contact.lastInAt));
    }
  }, [contact]);

  const open = useCallback((contactId: string): void => {
    if (!CONTACT_ID.test(contactId)) return;
    const query = new URLSearchParams({ [CONTACT_PARAM]: contactId });
    history.pushState(null, '', `${location.pathname}?${query.toString()}`);
    setSelected(contactId);
  }, []);

  const back = useCallback((): void => {
    history.pushState(null, '', location.pathname);
    setSelected(undefined);
  }, []);

  const passkey = useCallback(async (): Promise<DecisionPasskey | undefined> => {
    const answer = await clients.approvals.passkey();
    return answer.kind === 'ready' ? answer.passkey : undefined;
  }, [clients]);

  return (
    <div className="ib-page">
      <header className="ib-head">
        <h1 className="al-text-display">{S.title}</h1>
      </header>
      {view.state === 'loading' ? <Skeleton loading label={S.loading} lines={4} /> : null}
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
      {data === undefined ? null : contact !== undefined ? (
        <ConversationView
          contact={contact}
          data={data}
          clients={clients}
          passkey={passkey}
          tick={tick}
          refresh={refresh}
          back={back}
        />
      ) : (
        <>
          <NeedsYou
            data={data}
            seen={seen}
            clients={clients}
            passkey={passkey}
            refresh={refresh}
            open={open}
          />
          <ConversationList list={data.conversations} seen={seen} open={open} />
        </>
      )}
    </div>
  );
}
