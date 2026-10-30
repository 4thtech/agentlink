// W4-LIVE-STATUS (D-143; 08 §1 `GET /api/ui/events`; 04 §2.5 "Live status and Pause"; proposed, owner
// confirms at merge): the live event stream of AI app status changes.
//
// The route is a read (`presence: false`) behind the unchanged gate of every `/api/ui/` read (page
// session cookie, CSRF header, exact Host, Origin when present, Sec-Fetch-Site, loopback), plus
// `Accept: text/event-stream` and no query (approval-server.ts eventsGate). This file holds the
// route entry and the hub that feeds the streams:
//
// - Events: `snapshot` `{generation, current, agents, at}` (the first event of every stream unless
//   its Last-Event-ID is still in the replay buffer), `agents` `{agents, gone?, at}` (only the agents
//   whose allowlisted fields changed, each whole, plus the names no longer listed) and `generation`
//   `{generation, current, at}` after a switch. `data` is one line of JSON. Every agent passes the
//   one allowlist (live-status.ts liveAgentRecord) again here.
// - Changes only: while a stream is open the hub reads every 2 s (and at once on `poke`, after a
//   switch), compares the allowlisted state with the last one sent, and emits only on a change.
// - IDs and replay: `id: <boot>.<seq>`; `boot` is 8 random base64url characters chosen when the host
//   starts. The last 64 events are kept; a Last-Event-ID of at most 32 characters, of this boot and
//   still in the buffer (or the latest), replays the later events; anything else starts with a
//   snapshot. A snapshot's id is the latest event's, so it can be resumed from too.
// - Limits: `retry: 2000` first; `: ping` every 15 s; at most 4 streams per page session and 8 in all
//   (one more is `busy`, 429); a stream ends after 30 min, when its page session ends, when its reader
//   falls more than 64 KiB behind, and when the host stops.
// - It writes nothing, takes no lock, never opens an agent and never takes the lease (the read is the
//   host's read-only peek). Nothing here logs; the caller logs counts only.
import { encodeBase64url, randomBytes } from '@4thtech-io/crypto';
import type { LocalUiReadRoute, LocalUiRoute } from '../route-types.js';
import { liveAgentRecord, type LiveAgentRecord } from '../live-status.js';

export const EVENTS_PATH = '/api/ui/events';

/** The spec values (08 §1). */
export const LIVE_EVENTS_LIMITS = Object.freeze({
  readIntervalMs: 2_000,
  pingMs: 15_000,
  retryMs: 2_000,
  perSession: 4,
  total: 8,
  lifetimeMs: 1_800_000,
  backlogBytes: 65_536,
  replay: 64,
  maxLastEventIdLength: 32,
});

/** What one read of the host gives: the generation, the open agent and every listed agent. */
export interface LiveSnapshot {
  readonly generation: number;
  readonly current: string | null;
  readonly agents: readonly LiveAgentRecord[];
}

/** One open stream's writer (the server adapts its response). */
export interface LiveEventSink {
  write(chunk: string): void;
  end(): void;
  /** Bytes written and not yet taken by the reader. */
  readonly buffered: number;
  /** Called once when the reader goes away. */
  onClose(fn: () => void): void;
}

export interface LiveEventsTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LiveEventsOptions {
  /** The host's read (allowlisted records); undefined when it cannot be read now. */
  readonly read: () => Promise<LiveSnapshot | undefined>;
  /** Milliseconds. Default Date.now. */
  readonly now?: () => number;
  /** True while the page session a stream was opened with still exists. */
  readonly sessionLive: (session: string) => boolean;
  /** 8 base64url characters. Default: 6 random bytes. */
  readonly boot?: () => string;
  readonly timers?: LiveEventsTimers;
  /** Tests: a shorter read interval. */
  readonly readIntervalMs?: number;
}

interface Stream {
  readonly sink: LiveEventSink;
  readonly session: string;
  readonly openedAt: number;
  lastWriteAt: number;
  closed: boolean;
  /** Opened before any state could be read: the snapshot follows the first read. */
  snapshotDue: boolean;
}

interface Buffered {
  readonly seq: number;
  readonly text: string;
}

const nodeTimers: LiveEventsTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

const BOOT = /^[A-Za-z0-9_-]{8}$/;
const SEQ = /^(0|[1-9][0-9]{0,15})$/;

/** The hub: one read loop for all open streams, the replay buffer and the limits. */
export class LiveEvents {
  readonly #read: LiveEventsOptions['read'];
  readonly #now: () => number;
  readonly #sessionLive: (session: string) => boolean;
  readonly #boot: string;
  readonly #timers: LiveEventsTimers;
  readonly #intervalMs: number;
  readonly #streams = new Set<Stream>();
  readonly #buffer: Buffered[] = [];
  #seq = 0;
  #last: LiveSnapshot | undefined;
  #lastText = new Map<string, string>();
  #timer: unknown;
  #reading: Promise<void> | undefined;
  #closed = false;

  constructor(options: LiveEventsOptions) {
    this.#read = options.read;
    this.#now = options.now ?? Date.now;
    this.#sessionLive = options.sessionLive;
    const boot = options.boot?.() ?? encodeBase64url(randomBytes(6));
    if (!BOOT.test(boot)) throw new Error('live events: boot');
    this.#boot = boot;
    this.#timers = options.timers ?? nodeTimers;
    this.#intervalMs = options.readIntervalMs ?? LIVE_EVENTS_LIMITS.readIntervalMs;
  }

  /** Open streams. */
  get size(): number {
    return this.#streams.size;
  }

  /**
   * Opens a stream for `session` (the page session it was gated with). The caller wrote the answer
   * headers. `busy` when a limit is reached or the hub is closed; the caller answers 429.
   */
  async open(sink: LiveEventSink, session: string, lastEventId?: string): Promise<'ok' | 'busy'> {
    if (!this.#room(session)) return 'busy';
    // With no stream open the state may be stale: read first, so a resumed stream also gets what
    // changed meanwhile (the read emits it into the buffer before this stream is added).
    if (this.#timer === undefined || this.#last === undefined) await this.#refresh();
    if (!this.#room(session)) return 'busy';
    const at = this.#now();
    const stream: Stream = {
      sink,
      session,
      openedAt: at,
      lastWriteAt: at,
      closed: false,
      snapshotDue: false,
    };
    this.#streams.add(stream);
    sink.onClose(() => {
      this.#drop(stream);
    });
    this.#write(stream, `retry: ${String(LIVE_EVENTS_LIMITS.retryMs)}\n\n`);
    const replay = this.#replayFrom(lastEventId);
    if (replay !== undefined) {
      for (const event of replay) this.#write(stream, event.text);
    } else {
      stream.snapshotDue = true;
      this.#snapshot(stream);
    }
    this.#arm();
    return 'ok';
  }

  /** Below both stream limits for `session`, and the hub is open. */
  #room(session: string): boolean {
    if (this.#closed || this.#streams.size >= LIVE_EVENTS_LIMITS.total) return false;
    let mine = 0;
    for (const s of this.#streams) if (s.session === session) mine += 1;
    return mine < LIVE_EVENTS_LIMITS.perSession;
  }

  /** Sends the snapshot a stream is still due, once a state was read. */
  #snapshot(stream: Stream): void {
    const last = this.#last;
    if (!stream.snapshotDue || last === undefined) return;
    stream.snapshotDue = false;
    this.#write(
      stream,
      block(this.#id(this.#seq), 'snapshot', {
        generation: last.generation,
        current: last.current,
        agents: last.agents,
        at: this.#seconds(),
      }),
    );
  }

  /** Reads at once (after a switch). */
  poke(): void {
    if (this.#streams.size > 0) void this.tick();
  }

  /** One read: emits changes, pings, and ends streams past a limit. Never rejects. */
  async tick(): Promise<void> {
    if (this.#streams.size === 0) return;
    await this.#refresh();
    const now = this.#now();
    for (const stream of [...this.#streams]) {
      if (
        now - stream.openedAt >= LIVE_EVENTS_LIMITS.lifetimeMs ||
        !this.#sessionLive(stream.session)
      ) {
        this.#end(stream);
        continue;
      }
      if (now - stream.lastWriteAt >= LIVE_EVENTS_LIMITS.pingMs) this.#write(stream, ': ping\n\n');
    }
  }

  /** Ends every stream; no stream opens after this (the host stops). */
  close(): void {
    this.#closed = true;
    for (const stream of [...this.#streams]) this.#end(stream);
    this.#disarm();
  }

  async #refresh(): Promise<void> {
    if (this.#reading !== undefined) return this.#reading;
    this.#reading = (async () => {
      let next: LiveSnapshot | undefined;
      try {
        next = await this.#read();
      } catch {
        next = undefined;
      }
      if (next !== undefined) this.#apply(next);
    })().finally(() => {
      this.#reading = undefined;
    });
    return this.#reading;
  }

  /** Compares the allowlisted state with the last one and emits the changes. */
  #apply(raw: LiveSnapshot): void {
    const agents = raw.agents.map(liveAgentRecord);
    const next: LiveSnapshot = {
      generation: raw.generation,
      current: raw.current,
      agents: Object.freeze(agents),
    };
    const texts = new Map(agents.map((a) => [a.name, JSON.stringify(a)]));
    const prev = this.#last;
    this.#last = next;
    const prevTexts = this.#lastText;
    this.#lastText = texts;
    for (const stream of [...this.#streams]) this.#snapshot(stream);
    if (prev === undefined) return;
    const at = this.#seconds();
    if (prev.generation !== next.generation || prev.current !== next.current) {
      this.#emit('generation', { generation: next.generation, current: next.current, at });
    }
    const changed = agents.filter((a) => prevTexts.get(a.name) !== texts.get(a.name));
    const gone = [...prevTexts.keys()].filter((name) => !texts.has(name));
    if (changed.length > 0 || gone.length > 0) {
      this.#emit('agents', { agents: changed, ...(gone.length > 0 ? { gone } : {}), at });
    }
  }

  #emit(event: string, data: Record<string, unknown>): void {
    this.#seq += 1;
    const text = block(this.#id(this.#seq), event, data);
    this.#buffer.push({ seq: this.#seq, text });
    while (this.#buffer.length > LIVE_EVENTS_LIMITS.replay) this.#buffer.shift();
    for (const stream of [...this.#streams]) this.#write(stream, text);
  }

  /** The events after `lastEventId`, or undefined when it is not resumable (then: a snapshot). */
  #replayFrom(lastEventId: string | undefined): readonly Buffered[] | undefined {
    if (lastEventId === undefined || lastEventId.length > LIVE_EVENTS_LIMITS.maxLastEventIdLength) {
      return undefined;
    }
    const dot = lastEventId.indexOf('.');
    if (dot < 0) return undefined;
    const boot = lastEventId.slice(0, dot);
    const seqText = lastEventId.slice(dot + 1);
    if (boot !== this.#boot || !SEQ.test(seqText)) return undefined;
    const seq = Number(seqText);
    if (seq > this.#seq) return undefined;
    const oldest = this.#buffer[0]?.seq ?? this.#seq + 1;
    if (seq < oldest - 1) return undefined;
    // No state could be read yet: a snapshot follows the first read.
    if (this.#last === undefined) return undefined;
    return this.#buffer.filter((event) => event.seq > seq);
  }

  #write(stream: Stream, text: string): void {
    if (stream.closed) return;
    try {
      stream.sink.write(text);
    } catch {
      this.#end(stream);
      return;
    }
    stream.lastWriteAt = this.#now();
    if (stream.sink.buffered > LIVE_EVENTS_LIMITS.backlogBytes) this.#end(stream);
  }

  #end(stream: Stream): void {
    if (stream.closed) return;
    this.#drop(stream);
    try {
      stream.sink.end();
    } catch {
      // The reader is gone already.
    }
  }

  #drop(stream: Stream): void {
    stream.closed = true;
    this.#streams.delete(stream);
    if (this.#streams.size === 0) this.#disarm();
  }

  #arm(): void {
    if (this.#timer !== undefined || this.#streams.size === 0) return;
    this.#timer = this.#timers.setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
  }

  #disarm(): void {
    if (this.#timer === undefined) return;
    this.#timers.clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #id(seq: number): string {
    return `${this.#boot}.${String(seq)}`;
  }

  #seconds(): number {
    return Math.floor(this.#now() / 1000);
  }
}

/** One event block: id, event name and one line of JSON data. */
function block(id: string, event: string, data: Record<string, unknown>): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The route entry: the server runs its own gate and the hub (approval-server.ts eventsGate); the
 * handler is never called through the read path and answers `bad_request` if it ever is.
 */
const eventsRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: EVENTS_PATH,
  presence: false,
  stream: true,
  handler: () => Promise.resolve({ status: 400, body: { error: 'bad_request' } }),
});

export const eventsRoutes: readonly LocalUiRoute[] = Object.freeze([eventsRoute]);
