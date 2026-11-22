// RELAY-SHARED-CONN L2: an in-memory stand-in for the local channel between a program and the shared
// relay link (L3 supplies the real one: a Unix socket or a named pipe). Frames are delivered on a
// microtask, as a socket would, so ordering bugs show up in tests. Excluded from the build; only tests
// import it.
import type { SharedLinkMux, SharedLinkClient } from '../shared-link-mux.js';
import type {
  SharedLinkChannel,
  SharedLinkChannelHandlers,
  SharedLinkDialer,
} from '../shared-relay-connector.js';

const microtask = (fn: () => void): void => {
  void Promise.resolve().then(fn);
};

/** One in-memory channel: what the client sent and the server answered, for assertions. */
export interface MemoryLink {
  readonly toServer: string[];
  readonly toClient: string[];
  closed: boolean;
  client: SharedLinkClient | undefined;
}

/** A dialer that attaches each dial to `mux`. `links` records every channel it made. */
export function memoryDialer(mux: SharedLinkMux): { dial: SharedLinkDialer; links: MemoryLink[] } {
  const links: MemoryLink[] = [];
  const dial: SharedLinkDialer = (handlers: SharedLinkChannelHandlers): SharedLinkChannel => {
    const link: MemoryLink = { toServer: [], toClient: [], closed: false, client: undefined };
    links.push(link);
    // A close is delivered after the frames already sent, as a socket flushes before it ends.
    let ending = false;
    const shut = (): void => {
      if (ending) return;
      ending = true;
      microtask(() => {
        link.closed = true;
        link.client?.detach();
        handlers.onClose();
      });
    };
    link.client = mux.attach({
      send: (frame) => {
        if (ending) throw new Error('channel closed');
        link.toClient.push(frame);
        microtask(() => {
          if (!link.closed) handlers.onFrame(frame);
        });
      },
      close: shut,
    });
    return {
      send: (frame) => {
        if (ending) throw new Error('channel closed');
        link.toServer.push(frame);
        microtask(() => {
          if (!link.closed) link.client?.receive(frame);
        });
      },
      close: shut,
    };
  };
  return { dial, links };
}

/** A dialer whose channel accepts frames and never answers (a stalled shared link). */
export function stalledDialer(): { dial: SharedLinkDialer; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    dial: () => ({
      send: (frame) => {
        sent.push(frame);
      },
      close: () => undefined,
    }),
  };
}
