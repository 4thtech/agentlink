// M2-3a: relay sockets from the Worker (07 §4.2; 08 §3.1; D-131 (f), spike S-5).
//
// WorkerRelayConnector is transport-nostr's RelayConnector on the Workers runtime: an outbound
// WebSocket through `fetch` with `Upgrade: websocket`. Workers cannot resolve or pin an address, so
// the pool runs with `addressCheck: 'platform'` (07 §4.2 residual: the schema rule of 04 §4 and
// Cloudflare's egress, which does not reach private ranges). A redirect is never followed
// (`redirect: 'manual'`, and anything but 101 with a socket is a close). Text frames over the pool's
// 128 KiB bound close the socket here too; binary frames are dropped. Nothing here logs; relay text
// and URLs never reach an error (I-5, I-7).
//
// RunSocketBudget caps the sockets of one alarm run at MAX_SOCKETS_PER_RUN (5): an open beyond it is
// refused at once (the pool sees a failed connect and skips that relay for the run), and
// `closeAll()` closes every socket the run opened, so no relay socket outlives its run (no
// always-open socket: outbound sockets keep the object in memory and billed, spike S-5).
import {
  MAX_FRAME_BYTES,
  type RelayConnector,
  type RelaySocket,
  type RelaySocketHandlers,
  type RelayTarget,
} from '@4thtech-io/transport-nostr';

/** D-131 (f), spike S-5: at most 5 relay sockets per alarm run. */
export const MAX_SOCKETS_PER_RUN = 5;

/** The `fetch` the connector uses. The runtime's own by default; tests pass one that upgrades. */
export type UpgradeFetch = (input: string, init: RequestInit) => Promise<Response>;

const encoder = new TextEncoder();

/** wss://host[:port][/path] as the https URL of its upgrade request; anything else is undefined. */
function upgradeUrl(target: RelayTarget): string | undefined {
  if (typeof target.url !== 'string' || !target.url.startsWith('wss://')) return undefined;
  return `https://${target.url.slice('wss://'.length)}`;
}

export class WorkerRelayConnector implements RelayConnector {
  readonly #fetch: UpgradeFetch;

  constructor(options: { readonly fetch?: UpgradeFetch } = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
    let socket: WebSocket | undefined;
    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      try {
        socket?.close();
      } catch {
        // already closing
      }
      handlers.onClose();
    };
    const url = upgradeUrl(target);
    if (url === undefined) {
      queueMicrotask(finish);
      return { send: () => undefined, close: finish };
    }
    const pending: string[] = [];
    void this.#fetch(url, { headers: { Upgrade: 'websocket' }, redirect: 'manual' })
      .then((response) => {
        const ws = response.status === 101 ? response.webSocket : null;
        if (ws === null || closed) {
          if (ws !== null) {
            try {
              ws.accept();
              ws.close();
            } catch {
              // nothing to close
            }
          }
          finish();
          return;
        }
        ws.accept();
        socket = ws;
        ws.addEventListener('message', (event: MessageEvent) => {
          const data: unknown = event.data;
          if (typeof data !== 'string') return;
          if (data.length > MAX_FRAME_BYTES || encoder.encode(data).length > MAX_FRAME_BYTES) {
            finish();
            return;
          }
          handlers.onMessage(data);
        });
        ws.addEventListener('close', finish);
        ws.addEventListener('error', finish);
        handlers.onOpen();
        for (const text of pending.splice(0)) ws.send(text);
      })
      .catch(finish);
    return {
      send: (text: string) => {
        if (closed) return;
        if (socket === undefined) {
          pending.push(text);
          return;
        }
        try {
          socket.send(text);
        } catch {
          finish();
        }
      },
      close: finish,
    };
  }
}

/** One alarm run's sockets: at most `max`, and all of them closed by `closeAll()`. */
export class RunSocketBudget implements RelayConnector {
  readonly #inner: RelayConnector;
  readonly #max: number;
  readonly #open = new Set<{ socket?: RelaySocket }>();
  #opened = 0;
  #ended = false;

  constructor(inner: RelayConnector, max = MAX_SOCKETS_PER_RUN) {
    this.#inner = inner;
    this.#max = max;
  }

  /** Sockets this run opened (or tried to). For the run summary: a count only. */
  get opened(): number {
    return this.#opened;
  }

  open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
    if (this.#ended || this.#opened >= this.#max) {
      queueMicrotask(() => handlers.onClose());
      return { send: () => undefined, close: () => undefined };
    }
    this.#opened += 1;
    // `entry.socket` is set right after open; a close reported during open still removes the entry.
    const entry: { socket?: RelaySocket } = {};
    this.#open.add(entry);
    entry.socket = this.#inner.open(target, {
      onOpen: () => handlers.onOpen(),
      onMessage: (data) => handlers.onMessage(data),
      onClose: () => {
        this.#open.delete(entry);
        handlers.onClose();
      },
    });
    return {
      send: (text) => entry.socket?.send(text),
      close: () => {
        this.#open.delete(entry);
        entry.socket?.close();
      },
    };
  }

  /** Ends the run: closes every socket still open and refuses new ones. */
  closeAll(): void {
    this.#ended = true;
    const entries = [...this.#open];
    this.#open.clear();
    for (const entry of entries) entry.socket?.close();
  }

  /** Sockets of this run still open (0 after `closeAll`). */
  get openCount(): number {
    return this.#open.size;
  }
}
