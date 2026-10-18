// M1-13a: the e2e relay connector. It implements @4thtech-io/transport-nostr's RelayConnector over
// Node's own WebSocket, to the local strfry containers (relays.mjs): a card's relay host maps to a
// plain ws:// port on 127.0.0.1. Everything above the socket (the pool, gift wraps, the outbox, the
// relay URL rule) is the production code path; only TLS and the address check are not exercised
// here. Those are covered by the relay-docker CI job against the production Node connector.
//
// The pool runs with `addressCheck: 'platform'` (07 §4.2: a named choice, as a browser makes), since
// no relay host resolves. A host that is not in the map is refused: the socket closes at once.

/** Reads the `{ host: port }` map from AGENTLINK_E2E_RELAYS (JSON). */
export function relayMapFromEnv(env = process.env) {
  const text = env['AGENTLINK_E2E_RELAYS'];
  if (typeof text !== 'string' || text === '') throw new Error('AGENTLINK_E2E_RELAYS is not set');
  const parsed = JSON.parse(text);
  const map = new Map();
  for (const [host, port] of Object.entries(parsed)) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('bad relay port');
    map.set(host, port);
  }
  return map;
}

/** A RelayConnector to the local relays in `map`. */
export function localRelayConnector(map) {
  return {
    open(target, handlers) {
      const port = map.get(target.host);
      let closed = false;
      const closeOnce = () => {
        if (closed) return;
        closed = true;
        handlers.onClose();
      };
      if (port === undefined) {
        queueMicrotask(closeOnce);
        return { send: () => undefined, close: () => undefined };
      }
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      ws.addEventListener('open', () => handlers.onOpen());
      ws.addEventListener('message', (message) => handlers.onMessage(message.data));
      ws.addEventListener('close', closeOnce);
      ws.addEventListener('error', closeOnce);
      return {
        send: (text) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(text);
        },
        close: () => {
          try {
            ws.close();
          } catch {
            // already closing
          }
        },
      };
    },
  };
}
