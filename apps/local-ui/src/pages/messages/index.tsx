// Messages (MSG-FILES-IO-e; 08 §1; 11 §5.7; design b11 §17.2; D-116, D-133).
//
// What the AI sent and received, per contact: a contacts list and the conversation in two tabs, Inbox
// and Sent. Read only. There is no compose control: the footer says "To reply, ask your AI."
//
// I-5: every word another party wrote (and every file name) is shown only through UntrustedContent,
// as plain text with inert link chips, and never anywhere else: not in the page title, a toast or a
// status line. I-4: only GETs; reading here asks the server for nothing that marks a message read for
// the AI. The "seen" marker is per browser (seen.ts). Under the hood shows metadata only.
import {
  Banner,
  Button,
  EmptyState,
  ProofBadge,
  Segmented,
  StatusChip,
  UntrustedContent,
} from '@4thtech-io/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import {
  createMessagesApi,
  type Conversation,
  type MessageBox,
  type MessageItem,
  type MessagePage,
  type MessagesApi,
  type Problem,
} from './api.js';
import './messages.css';
import { countUnseen, loadSeen, markSeen, type Seen } from './seen.js';
import { MESSAGES_STRINGS as S } from './strings.js';

const DAY = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const LONG_CHARS = 400;
const LONG_LINES = 6;

const isLong = (text: string): boolean =>
  text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

const SENT_CHIP: Readonly<Record<string, ReactElement>> = {
  sent: <StatusChip status="sent">{S.statusSent}</StatusChip>,
  queued: <StatusChip status="waiting-to-post">{S.statusQueued}</StatusChip>,
  not_delivered: <StatusChip status="failed">{S.statusNotDelivered}</StatusChip>,
};

function ProblemView({
  problem,
  onRetry,
  asOf,
}: {
  problem: Problem;
  onRetry: () => void;
  asOf?: string;
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
          {asOf === undefined ? '' : ` ${S.asOf(asOf)}`}
        </Banner>
      );
    case 'error':
      return (
        <Banner tone="warning" title={S.errorTitle} action={retry}>
          {S.errorBody}
          {asOf === undefined ? '' : ` ${S.asOf(asOf)}`}
        </Banner>
      );
  }
}

function Skeleton(): ReactElement {
  return (
    <div aria-busy="true">
      <p className="al-sr-only" role="status">
        {S.loading}
      </p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="ms-skeleton" aria-hidden="true" />
      ))}
    </div>
  );
}

function Hood({ item }: { item: MessageItem }): ReactElement {
  return (
    <details className="ms-hood al-text-body-sm">
      <summary>{S.underTheHood}</summary>
      <dl>
        <dt>{S.idLabel}</dt>
        <dd className="al-text-code">{item.id}</dd>
        <dt>{S.sizeLabel}</dt>
        <dd>{sizeText(item.size)}</dd>
        <dt>{S.proofLabel}</dt>
        <dd>{item.proof ? S.proofYes : S.proofNo}</dd>
        {item.status === undefined ? null : (
          <>
            <dt>{S.receiptLabel}</dt>
            <dd>{item.receipt ? S.receiptYes : S.receiptNo}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

function Message({
  item,
  who,
  onCopy,
}: {
  item: MessageItem;
  who: string;
  onCopy: (text: string) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const long = isLong(item.text);
  const date = new Date(item.at * 1000);
  return (
    <li className="ms-item">
      <div className="ms-meta al-text-body-sm">
        <time dateTime={date.toISOString()}>{DAY.format(date)}</time>
        {item.status === undefined ? null : SENT_CHIP[item.status]}
        {item.status !== undefined && item.receipt ? (
          <StatusChip status="delivered">{S.receiptYes}</StatusChip>
        ) : null}
        {item.proof ? <ProofBadge state="recorded" /> : null}
      </div>
      {item.text === '' ? null : (
        <UntrustedContent
          from={who}
          kind="message"
          {...(long && !expanded ? { className: 'ms-clamped' } : {})}
        >
          {item.text}
        </UntrustedContent>
      )}
      {item.files.map((file, i) => (
        <div key={i}>
          <UntrustedContent from={who} fileName={file.name} />
          <span className="al-text-body-sm al-muted">{sizeText(file.size)}</span>
        </div>
      ))}
      <div className="ms-actions">
        {long ? (
          <Button size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? S.showLess : S.showAll}
          </Button>
        ) : null}
        {item.text === '' ? null : (
          <Button size="sm" onClick={() => onCopy(item.text)}>
            {S.copy}
          </Button>
        )}
      </div>
      <Hood item={item} />
    </li>
  );
}

type Detail =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly problem: Problem }
  | {
      readonly state: 'ready';
      readonly items: readonly MessageItem[];
      readonly next?: string;
      readonly more: 'idle' | 'loading' | Problem;
    };

function Conversation_({
  contact,
  messages,
  onBack,
  onOpened,
}: {
  contact: Conversation;
  messages: MessagesApi;
  onBack: () => void;
  onOpened: (contactId: string, lastInAt: number) => void;
}): ReactElement {
  const [box, setBox] = useState<MessageBox>('in');
  const [detail, setDetail] = useState<Detail>({ state: 'loading' });
  const [note, setNote] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const run = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++run.current;
    setDetail({ state: 'loading' });
    const result = await messages.messages(contact.contactId, box);
    if (mine !== run.current) return;
    setDetail(
      result.ok
        ? { state: 'ready', ...pageParts(result.value), more: 'idle' }
        : { state: 'failed', problem: result.problem },
    );
  }, [messages, contact.contactId, box]);

  useEffect(() => {
    void load();
    return () => {
      run.current++;
    };
  }, [load]);

  useEffect(() => {
    heading.current?.focus();
  }, [contact.contactId]);

  // Looking at a conversation is local: the marker stays in this browser.
  const { contactId, lastInAt } = contact;
  useEffect(() => {
    onOpened(contactId, lastInAt);
  }, [contactId, lastInAt, onOpened]);

  const more = async (current: Extract<Detail, { state: 'ready' }>): Promise<void> => {
    if (current.next === undefined) return;
    const mine = ++run.current;
    setDetail({ ...current, more: 'loading' });
    const result = await messages.messages(contact.contactId, box, current.next);
    if (mine !== run.current) return;
    setDetail(
      result.ok
        ? {
            state: 'ready',
            items: [...current.items, ...result.value.items],
            ...(result.value.next === undefined ? {} : { next: result.value.next }),
            more: 'idle',
          }
        : { ...current, more: result.problem },
    );
  };

  const copy = (text: string): void => {
    const done = (message: string): void => setNote(message);
    try {
      navigator.clipboard.writeText(text).then(
        () => done(S.copied),
        () => done(S.copyFailed),
      );
    } catch {
      done(S.copyFailed);
    }
  };

  const who = box === 'in' ? contact.name : S.yourAi;
  return (
    <section className="ms-detail" aria-labelledby="ms-detail-title">
      <div className="ms-detail-head">
        <h2 id="ms-detail-title" ref={heading} tabIndex={-1} className="al-text-title-2">
          {contact.name}
        </h2>
        <Button size="sm" className="ms-back" onClick={onBack}>
          {S.back}
        </Button>
      </div>
      <Segmented
        label={S.boxLabel}
        value={box}
        onChange={(v) => setBox(v === 'out' ? 'out' : 'in')}
        options={[
          { value: 'in', label: S.inbox },
          { value: 'out', label: S.sent },
        ]}
      />
      <p className="al-text-body-sm al-muted" role="status">
        {note}
      </p>
      {detail.state === 'loading' ? (
        <Skeleton />
      ) : detail.state === 'failed' ? (
        <ProblemView problem={detail.problem} onRetry={() => void load()} />
      ) : detail.items.length === 0 && detail.next === undefined ? (
        <EmptyState icon="inbox" title={S.nothingYet(contact.name)} />
      ) : (
        <>
          <ul className="ms-items" aria-label={box === 'in' ? S.inbox : S.sent}>
            {detail.items.map((item) => (
              <Message key={item.id} item={item} who={who} onCopy={copy} />
            ))}
          </ul>
          {detail.more !== 'idle' && detail.more !== 'loading' ? (
            <ProblemView problem={detail.more} onRetry={() => void more(detail)} />
          ) : null}
          {detail.next !== undefined ? (
            <div className="ms-more">
              <Button
                onClick={() => void more(detail)}
                disabled={detail.more === 'loading'}
                aria-busy={detail.more === 'loading'}
              >
                {detail.more === 'loading' ? S.loadingMore : S.showMore}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <p className="ms-footer al-text-body-sm">{S.reply}</p>
    </section>
  );
}

function pageParts(page: MessagePage): { items: readonly MessageItem[]; next?: string } {
  return page.next === undefined ? { items: page.items } : { items: page.items, next: page.next };
}

type ListState =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly problem: Problem }
  | {
      readonly state: 'ready';
      readonly list: readonly Conversation[];
      readonly at: Date;
      readonly stale?: Problem;
    };

export interface MessagesPageProps {
  /** The API client; the app's default one when absent (tests pass their own). */
  readonly api?: ApiClient;
}

export function MessagesPage({ api }: MessagesPageProps): ReactElement {
  const messages = useRef<MessagesApi>(createMessagesApi(api ?? createApiClient()));
  const [view, setView] = useState<ListState>({ state: 'loading' });
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [seen, setSeen] = useState<Seen>(() => loadSeen());
  const live = useRef(true);
  const listRef = useRef<HTMLUListElement>(null);
  const lastOpened = useRef<string | undefined>(undefined);

  const loadList = useCallback(async (): Promise<void> => {
    const result = await messages.current.conversations();
    if (!live.current) return;
    setView((prev) =>
      result.ok
        ? { state: 'ready', list: result.value, at: new Date() }
        : prev.state === 'ready'
          ? { ...prev, stale: result.problem }
          : { state: 'failed', problem: result.problem },
    );
  }, []);

  useEffect(() => {
    live.current = true;
    void loadList();
    return () => {
      live.current = false;
    };
  }, [loadList]);

  const opened = useCallback((contactId: string, lastInAt: number): void => {
    setSeen(markSeen(contactId, lastInAt));
  }, []);

  // Back to the list: focus returns to the row the person came from.
  useEffect(() => {
    if (selected !== undefined || lastOpened.current === undefined) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('button[data-contact]') ?? [];
    for (const row of rows) if (row.dataset['contact'] === lastOpened.current) row.focus();
  }, [selected]);

  const current =
    view.state === 'ready' ? view.list.find((c) => c.contactId === selected) : undefined;

  return (
    <>
      <div className="ms-head">
        <h1 className="al-text-title-1">{S.title}</h1>
      </div>
      {view.state === 'loading' ? (
        <Skeleton />
      ) : view.state === 'failed' ? (
        <ProblemView problem={view.problem} onRetry={() => void loadList()} />
      ) : view.list.length === 0 ? (
        <EmptyState icon="inbox" title={S.noContacts} />
      ) : (
        <div className={`ms-layout${current === undefined ? '' : ' has-selection'}`}>
          <div className="ms-list-wrap">
            {view.stale === undefined ? null : (
              <ProblemView
                problem={view.stale}
                onRetry={() => void loadList()}
                asOf={CLOCK.format(view.at)}
              />
            )}
            <div className="ms-list-bar">
              <span className="al-text-body-sm al-muted">
                {countUnseen(view.list, seen) > 0 ? S.newMessages : ''}
              </span>
              <Button size="sm" onClick={() => void loadList()}>
                {S.refresh}
              </Button>
            </div>
            <ul className="ms-list" aria-label={S.listLabel} ref={listRef}>
              {view.list.map((c) => {
                const isNew = c.lastInAt > (seen[c.contactId] ?? 0);
                const date = c.lastAt > 0 ? new Date(c.lastAt * 1000) : undefined;
                return (
                  <li key={c.contactId}>
                    <button
                      type="button"
                      className="ms-row"
                      data-contact={c.contactId}
                      aria-current={c.contactId === selected ? 'true' : undefined}
                      onClick={() => {
                        lastOpened.current = c.contactId;
                        setSelected(c.contactId);
                      }}
                    >
                      <span className="ms-row-main">
                        <span className={isNew ? 'al-text-body ms-new' : 'al-text-body'}>
                          {c.name}
                        </span>
                        <span className="al-text-body-sm al-muted">
                          {date === undefined ? '' : DAY.format(date)}
                        </span>
                      </span>
                      {isNew ? (
                        <span className="al-chip al-tone-info al-text-label">{S.newMessages}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {current === undefined ? null : (
            <Conversation_
              key={current.contactId}
              contact={current}
              messages={messages.current}
              onBack={() => setSelected(undefined)}
              onOpened={opened}
            />
          )}
        </div>
      )}
    </>
  );
}
