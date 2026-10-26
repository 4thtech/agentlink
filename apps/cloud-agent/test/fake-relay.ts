// An in-memory Nostr relay behind transport-nostr's RelayConnector seam, for the Miniflare tests of
// AgentDO (M2-3a). NIP-01 only: REQ with kinds, ids, #p, since, until and limit answers the stored
// events newest first, then EOSE; EVENT is stored and answered OK; CLOSE and AUTH are ignored. One
// module-level instance, shared by the test files and the TestAgentDO in the same isolate.
import type {
  RelayConnector,
  RelaySocket,
  RelaySocketHandlers,
  RelayTarget,
} from '@4thtech-io/transport-nostr';

export interface RelayEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

interface Filter {
  readonly ids?: readonly string[];
  readonly kinds?: readonly number[];
  readonly '#p'?: readonly string[];
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
}

function matches(event: RelayEvent, filter: Filter): boolean {
  if (filter.ids !== undefined && !filter.ids.includes(event.id)) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  const p = filter['#p'];
  if (p !== undefined && !event.tags.some((t) => t[0] === 'p' && p.includes(t[1] ?? ''))) {
    return false;
  }
  return true;
}

export class FakeRelay implements RelayConnector {
  readonly events: RelayEvent[] = [];
  readonly published: RelayEvent[] = [];
  /** Relay URLs of every open() call, in order. */
  readonly opens: string[] = [];
  reqs = 0;
  open_ = 0;
  /** When set, open() throws: a connector failure inside a run. */
  failOpen = false;

  reset(): void {
    this.events.length = 0;
    this.published.length = 0;
    this.opens.length = 0;
    this.reqs = 0;
    this.open_ = 0;
    this.failOpen = false;
  }

  /** Sockets currently open. */
  get openSockets(): number {
    return this.open_;
  }

  open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
    if (this.failOpen) throw new Error('fake relay: open failed');
    this.opens.push(target.url);
    this.open_ += 1;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      this.open_ -= 1;
      queueMicrotask(() => handlers.onClose());
    };
    const reply = (frame: unknown): void => {
      queueMicrotask(() => {
        if (!closed) handlers.onMessage(JSON.stringify(frame));
      });
    };
    queueMicrotask(() => {
      if (!closed) handlers.onOpen();
    });
    return {
      send: (text: string) => {
        if (closed) return;
        let frame: unknown;
        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }
        if (!Array.isArray(frame)) return;
        if (frame[0] === 'REQ' && typeof frame[1] === 'string') {
          this.reqs += 1;
          const subId = frame[1];
          const filters = frame.slice(2) as Filter[];
          const out = new Map<string, RelayEvent>();
          for (const filter of filters) {
            const hits = this.events
              .filter((e) => matches(e, filter))
              .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
            for (const e of hits.slice(0, filter.limit ?? hits.length)) out.set(e.id, e);
          }
          for (const event of out.values()) reply(['EVENT', subId, event]);
          reply(['EOSE', subId]);
        } else if (frame[0] === 'EVENT' && typeof frame[1] === 'object') {
          const event = frame[1] as RelayEvent;
          this.published.push(event);
          reply(['OK', event.id, true, '']);
        }
      },
      close,
    };
  }
}

export const relay = new FakeRelay();
