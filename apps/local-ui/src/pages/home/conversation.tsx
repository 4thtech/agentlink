// W4-HOME: one person's conversation, opened in place under their row (prototype v23 A4/A10; W4 UX
// v2 "Conversation"; ux-inventory §9 item 1). Both directions, oldest first:
//
// - what your AI sent: its words, and a plain delivery word: Sent / Waiting to send (shown pending,
//   U0's optimistic style, until the relay takes it) / Not delivered, with what to do next;
// - what their AI sent: ONLY inside the untrusted container (I-5), never in a heading, a button or
//   a status line;
// - Copy text on every message; earlier messages page in with the cursor ("Load earlier messages").
//
// Under the hood adds each message's ID, exact time, size, sending agent, delivery receipt and
// proof. Reading here sends GETs only and never marks anything read for the AI.
import { Banner, Button, Icon, SkeletonLine, UntrustedContent } from '@4thtech-io/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { sizeText } from '../files/io.js';
import type { MessageItem, MessagePage, MessagesApi } from '../messages/api.js';
import { mergeThread } from './people-api.js';
import { HOME_STRINGS as S, fmt } from './people-strings.js';

const COPIED_MS = 1600;
const SHORT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const EXACT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** "14:02" today, "29 Oct, 18:20" before. */
export function shortTime(at: number, now = Date.now()): string {
  const d = new Date(at * 1000);
  const today = new Date(now);
  return d.toDateString() === today.toDateString() ? SHORT.format(d) : DAY.format(d);
}

export const exactTime = (at: number): string => EXACT.format(new Date(at * 1000));

interface Box {
  readonly items: readonly MessageItem[];
  /** The cursor of the next older page; undefined when there is none. */
  readonly next?: string;
  /** An older page was read: the first page's own cursor no longer applies. */
  readonly paged: boolean;
}

type Thread =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly inbox: Box; readonly sent: Box };

/** Newest first, one copy per ID: the fresh first page wins over what was there. */
function mergeNewest(fresh: readonly MessageItem[], kept: readonly MessageItem[]): MessageItem[] {
  const ids = new Set(fresh.map((m) => m.id));
  return [...fresh, ...kept.filter((m) => !ids.has(m.id))].sort((a, b) => b.at - a.at);
}

function refreshBox(prev: Box | undefined, page: MessagePage): Box {
  if (prev === undefined || !prev.paged) {
    return {
      items: page.items,
      ...(page.next === undefined ? {} : { next: page.next }),
      paged: false,
    };
  }
  return { ...prev, items: mergeNewest(page.items, prev.items) };
}

function olderBox(prev: Box, page: MessagePage): Box {
  return {
    items: mergeNewest(prev.items, page.items),
    ...(page.next === undefined ? {} : { next: page.next }),
    paged: true,
  };
}

/** The messages both ways, read again on every `tick`; earlier pages stay. */
export function useThread(
  api: MessagesApi,
  contactId: string,
  tick: number,
): { thread: Thread; loadEarlier: () => Promise<void> } {
  const [thread, setThread] = useState<Thread>({ state: 'loading' });
  const current = useRef<Thread>(thread);
  current.current = thread;
  useEffect(() => {
    let live = true;
    void (async () => {
      const [inbox, sent] = await Promise.all([
        api.messages(contactId, 'in'),
        api.messages(contactId, 'out'),
      ]);
      if (!live) return;
      if (!inbox.ok || !sent.ok) {
        setThread((prev) => (prev.state === 'ready' ? prev : { state: 'failed' }));
        return;
      }
      setThread((prev) => ({
        state: 'ready',
        inbox: refreshBox(prev.state === 'ready' ? prev.inbox : undefined, inbox.value),
        sent: refreshBox(prev.state === 'ready' ? prev.sent : undefined, sent.value),
      }));
    })();
    return () => {
      live = false;
    };
  }, [api, contactId, tick]);

  const loadEarlier = useCallback(async (): Promise<void> => {
    const t = current.current;
    if (t.state !== 'ready') return;
    const [inbox, sent] = await Promise.all([
      t.inbox.next === undefined ? undefined : api.messages(contactId, 'in', t.inbox.next),
      t.sent.next === undefined ? undefined : api.messages(contactId, 'out', t.sent.next),
    ]);
    setThread((prev) => {
      if (prev.state !== 'ready') return prev;
      return {
        state: 'ready',
        inbox: inbox?.ok === true ? olderBox(prev.inbox, inbox.value) : prev.inbox,
        sent: sent?.ok === true ? olderBox(prev.sent, sent.value) : prev.sent,
      };
    });
  }, [api, contactId]);

  return { thread, loadEarlier };
}

/** The delivery word of a message your AI sent. */
function Delivery({ status }: { readonly status: MessageItem['status'] }): ReactElement | null {
  if (status === 'sent') {
    return (
      <span className="hm-dl hm-f is-sent al-pop">
        <Icon name="check" size={13} />
        <span>{S.sent}</span>
      </span>
    );
  }
  if (status === 'queued') {
    return (
      <span className="hm-dl hm-f is-waiting">
        <Icon name="clock" size={13} />
        <span>{S.waitingToSend}</span>
      </span>
    );
  }
  if (status === 'not_delivered') {
    return (
      <>
        <span className="hm-dl hm-f is-failed">
          <Icon name="triangle-alert" size={13} />
          <span>{S.notDelivered}</span>
        </span>
        <span className="hm-dl-hint">{S.notDeliveredRetry}</span>
      </>
    );
  }
  return null;
}

function CopyText({ text }: { readonly text: string }): ReactElement {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state !== 'copied') return undefined;
    const timer = setTimeout(() => setState('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = (): void => {
    try {
      const clip = navigator.clipboard as Clipboard | undefined;
      if (clip === undefined) {
        setState('failed');
        return;
      }
      void clip.writeText(text).then(
        () => setState('copied'),
        () => setState('failed'),
      );
    } catch {
      setState('failed');
    }
  };
  return (
    <>
      <button
        type="button"
        className="al-btn al-btn-ghost al-btn-sm hm-copy"
        aria-label={S.copyLabel}
        onClick={copy}
      >
        {state === 'copied' ? (
          <span className="hm-copied hm-f al-pop">
            <Icon name="check" size={13} />
            <span>{S.copied}</span>
          </span>
        ) : (
          <>
            <Icon name="copy" size={13} />
            <span>{S.copy}</span>
          </>
        )}
      </button>
      <span className="al-visually-hidden" aria-live="polite">
        {state === 'copied' ? S.copied : ''}
      </span>
      {state === 'failed' ? (
        <span role="status" className="hm-dl-hint">
          {S.copyFailed}
        </span>
      ) : null}
    </>
  );
}

function Details({
  item,
  out,
  agent,
  name,
}: {
  readonly item: MessageItem;
  readonly out: boolean;
  readonly agent: string;
  readonly name: string;
}): ReactElement {
  const receipt = !out
    ? S.receiptTheirs
    : item.status === 'queued'
      ? S.receiptPending
      : item.receipt
        ? S.receiptYes
        : S.receiptNo;
  return (
    <p className="hm-msg-meta hm-f al-text-code al-reveal">
      <span>
        {S.msgId} <span className="hm-v">{item.id}</span>
      </span>
      <span>{exactTime(item.at)}</span>
      <span>{sizeText(item.size)}</span>
      <span>
        {S.msgBy} <span className="hm-v">{out ? agent : fmt(S.theirAgent, { name })}</span>
      </span>
      <span>
        {S.receipt} <span className="hm-v">{receipt}</span>
      </span>
      <span>
        {S.proof}{' '}
        <span className={item.proof ? 'hm-v is-proof' : 'hm-v'}>
          {item.proof ? S.proofYes : S.proofNo}
        </span>
      </span>
    </p>
  );
}

/** The time from which every box with more pages is loaded (newest first, so its last item). */
export function coveredFrom(boxes: readonly Box[]): number {
  let from = -Infinity;
  for (const b of boxes) {
    const oldest = b.items[b.items.length - 1];
    if (b.next !== undefined && oldest !== undefined) from = Math.max(from, oldest.at);
  }
  return from;
}

export function Conversation({
  name,
  agent,
  pro,
  thread,
  loadEarlier,
}: {
  /** The person's name, as the name rule shows it (text only). */
  readonly name: string;
  /** The open agent's label (your AI). */
  readonly agent: string;
  readonly pro: boolean;
  readonly thread: Thread;
  readonly loadEarlier: () => Promise<void>;
}): ReactElement {
  const [loading, setLoading] = useState(false);
  if (thread.state === 'loading') {
    return (
      <div className="hm-thread hm-c" role="status" aria-busy="true">
        <span className="al-visually-hidden">{S.loadingConversation}</span>
        <SkeletonLine width={40} size="caption" />
        <SkeletonLine width={70} size="pill" />
        <SkeletonLine width={55} size="pill" />
      </div>
    );
  }
  if (thread.state === 'failed') {
    return <Banner tone="warning">{S.conversationUnavailable}</Banner>;
  }
  // IR-W4-HOME-1: each box pages on its own, so show only the stretch both cover: nothing older
  // than the oldest loaded message of a box that still has older ones (else that box's side of the
  // stretch would be missing). Load earlier moves the line back.
  const cutoff = coveredFrom([thread.inbox, thread.sent]);
  const items = mergeThread(thread.inbox.items, thread.sent.items).filter(
    ({ item }) => item.text !== '' && item.at >= cutoff,
  );
  const more = thread.inbox.next !== undefined || thread.sent.next !== undefined;
  const ours = agent === '' ? S.yourAgent : fmt(S.yourAi, { name: agent });
  return (
    <div className="hm-thread hm-c">
      {more ? (
        <Button
          variant="ghost"
          size="sm"
          icon="clock"
          className="hm-earlier"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void loadEarlier().finally(() => setLoading(false));
          }}
        >
          {S.loadEarlier}
        </Button>
      ) : null}
      {items.length === 0 ? (
        <p className="al-text-body-sm al-muted">{fmt(S.noMessages, { name })}</p>
      ) : (
        <ol className="hm-msgs hm-c">
          {items.map(({ item, out }) => (
            <li
              key={`${out ? 'o' : 'i'}-${item.id}`}
              // UI-REFRESH-k: what another party wrote never moves in; your AI's words may.
              className={out ? 'hm-msg hm-c is-out al-reveal' : 'hm-msg hm-c is-in'}
            >
              {out ? (
                <>
                  <span className="hm-msg-who">
                    {ours} · {shortTime(item.at)}
                  </span>
                  <div
                    className="hm-bubble al-optimistic"
                    data-state={item.status === 'queued' ? 'pending' : 'confirmed'}
                  >
                    {item.text}
                  </div>
                </>
              ) : (
                <>
                  <span className="hm-msg-who">
                    {fmt(S.theirAi, { name })} · {shortTime(item.at)}
                  </span>
                  <UntrustedContent from={name} kind="message">
                    {item.text}
                  </UntrustedContent>
                </>
              )}
              <div className="hm-msg-actions hm-f">
                {out ? <Delivery status={item.status} /> : null}
                <CopyText text={item.text} />
              </div>
              {pro ? <Details item={item} out={out} agent={agent} name={name} /> : null}
            </li>
          ))}
        </ol>
      )}
      <p className="hm-note al-text-body-sm">{fmt(S.encrypted, { name })}</p>
      <p className="hm-note al-text-body-sm">{S.replyHint}</p>
    </div>
  );
}

export type { Thread };
