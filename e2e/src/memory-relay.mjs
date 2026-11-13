// U3-k: an in-memory Nostr relay for the local-app end-to-end test (no Docker, no sockets). It is a
// `RelayConnector` (@4thtech-io/transport-nostr): every relay host the agents' cards name goes to the
// same event store, so a gift wrap one agent publishes is found by the other, as on real relays. The
// pool, the gift wraps, the outbox and the relay URL rule above the socket are the production code.
//
// It implements the part of NIP-01 the transport uses: ["EVENT", e] (answered with "OK"),
// ["REQ", id, ...filters] (stored events first, then "EOSE", then live ones) and ["CLOSE", id]. A
// filter matches `ids`, `authors`, `kinds`, `since`, `until` and `#x` tag lists; `limit` keeps the
// newest. Nothing is logged and nothing leaves the process.
//
// W6-ACCEPT-CONNECTED: `okDelayMs` answers each "OK" that much later, while the event is stored and
// delivered at once, as with the real public relays (one slow relay holds a publish for seconds
// while the other side already has the event). Default 0: the answer comes at once.

/**
 * @param {{ okDelayMs?: number }} [options]
 * @returns {{ connector: { open: Function }, events: () => object[], count: () => number, setDown: (down: boolean) => void }}
 */
export function memoryRelays(options = {}) {
  const okDelayMs = options.okDelayMs ?? 0;
  /** @type {object[]} */
  const store = [];
  /** @type {Set<{ subs: Map<string, object[]>, deliver: (text: string) => void }>} */
  const sockets = new Set();

  const matches = (filter, event) => {
    if (filter.ids !== undefined && !filter.ids.includes(event.id)) return false;
    if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) return false;
    if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
    if (filter.since !== undefined && event.created_at < filter.since) return false;
    if (filter.until !== undefined && event.created_at > filter.until) return false;
    for (const [key, wanted] of Object.entries(filter)) {
      if (!key.startsWith('#') || !Array.isArray(wanted)) continue;
      const name = key.slice(1);
      const has = (event.tags ?? []).some((tag) => tag[0] === name && wanted.includes(tag[1]));
      if (!has) return false;
    }
    return true;
  };

  // REL051-CF2: while down, every connection is refused (closed before it opens), as on a network
  // that blocks WebSockets; going down also ends the open ones.
  let down = false;
  /** @type {Map<object, () => void>} */
  const closers = new Map();

  const connector = {
    open(_target, handlers) {
      if (down) {
        queueMicrotask(() => handlers.onClose());
        return { send: () => {}, close: () => {} };
      }
      const socket = {
        subs: new Map(),
        deliver: (text) => queueMicrotask(() => handlers.onMessage(text)),
      };
      sockets.add(socket);
      closers.set(socket, () => {
        sockets.delete(socket);
        closers.delete(socket);
        queueMicrotask(() => handlers.onClose());
      });
      queueMicrotask(() => handlers.onOpen());
      return {
        send: (text) => {
          let frame;
          try {
            frame = JSON.parse(text);
          } catch {
            return;
          }
          if (!Array.isArray(frame)) return;
          if (frame[0] === 'EVENT') {
            const event = frame[1];
            if (!store.some((e) => e.id === event.id)) {
              store.push(event);
              for (const other of sockets) {
                for (const [id, filters] of other.subs) {
                  if (filters.some((f) => matches(f, event))) {
                    other.deliver(JSON.stringify(['EVENT', id, event]));
                  }
                }
              }
            }
            const ok = JSON.stringify(['OK', event.id, true, '']);
            if (okDelayMs > 0) {
              setTimeout(() => {
                if (sockets.has(socket)) socket.deliver(ok);
              }, okDelayMs);
            } else socket.deliver(ok);
          } else if (frame[0] === 'REQ') {
            const id = frame[1];
            const filters = frame.slice(2);
            socket.subs.set(id, filters);
            for (const filter of filters) {
              let found = store.filter((e) => matches(filter, e));
              found.sort((a, b) => a.created_at - b.created_at);
              if (typeof filter.limit === 'number') found = found.slice(-filter.limit);
              for (const event of found) socket.deliver(JSON.stringify(['EVENT', id, event]));
            }
            socket.deliver(JSON.stringify(['EOSE', id]));
          } else if (frame[0] === 'CLOSE') {
            socket.subs.delete(frame[1]);
          }
        },
        close: () => {
          if (!sockets.has(socket)) return;
          sockets.delete(socket);
          closers.delete(socket);
          queueMicrotask(() => handlers.onClose());
        },
      };
    },
  };
  /** REL051-CF2: refuse (true) or accept (false) connections; going down closes the open ones. */
  const setDown = (value) => {
    down = value === true;
    if (down) for (const close of [...closers.values()]) close();
  };
  return { connector, events: () => [...store], count: () => store.length, setDown };
}
