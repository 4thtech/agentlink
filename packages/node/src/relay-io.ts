// M1-5b-b: the Node implementations of the relay I/O seams of @agentlink/transport-nostr
// (RelayConnector, HostResolver, Nip11Fetcher; 07 §4.2 "Relay connections", 04 §4 "Transport, at
// connect"). The pool resolves the host, requires every answer to be globally routable and hands
// this code the checked address; this code keeps the rest of the promise:
//   - the TCP connection goes to that address, never to a second lookup of the name (DNS
//     rebinding); TLS SNI, certificate verification and the HTTP Host header use the host name;
//   - a redirect is never followed, on the WebSocket upgrade or on the NIP-11 GET;
//   - no proxy is used: every socket comes from our own `createConnection`, with no http Agent, so
//     HTTPS_PROXY, ALL_PROXY, NODE_USE_ENV_PROXY and the like have nothing to act on;
//   - inbound WebSocket messages are capped at 131 072 bytes inside `ws` (maxPayload), so an
//     oversized message closes the socket and never reaches the pool; per-message compression is
//     not offered, so no inflated size has to be trusted;
//   - the NIP-11 read is capped at 65 536 bytes and has its own deadline (NIP11_TIMEOUT_MS),
//     separate from the pool's 10 s connect budget.
// Nothing here logs. Failures become a close (connector) or a fixed error message (resolver,
// fetcher): relay-sent text, addresses and URLs never reach an error (I-5, I-7).
import dns from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls';
import {
  CONNECT_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  NIP11_MAX_BYTES,
  type HostResolver,
  type Nip11Fetcher,
  type RelayConnector,
  type RelaySocket,
  type RelaySocketHandlers,
  type RelayTarget,
} from '@agentlink/transport-nostr';
import WebSocket from 'ws';

/** The NIP-11 read's own deadline, for the whole response; shorter than the 10 s connect budget. */
export const NIP11_TIMEOUT_MS = 5_000;
/** How long a closing handshake may take before the socket is destroyed. */
const CLOSE_TIMEOUT_MS = 2_000;
const MAX_HEADER_BYTES = 16 * 1024;
/** A validated relay URL: `wss://` host [":" port] [path] (the schema of 04 §4 ran before). */
const RELAY_PARTS = /^wss:\/\/([a-z0-9.-]+)(?::([0-9]+))?(\/[^?#]*)?$/;

/** Where the TCP connection for a checked address goes. Identity in production. */
export type RelayRoute = (address: string, port: number) => { address: string; port: number };

/**
 * Test seams, never exported from the package entry (fence.test.ts): `ca` replaces the system trust
 * roots with a test certificate, `route` sends the checked address to a local port. Production code
 * uses the factories below, which take no options.
 */
export interface RelayIoOptions {
  readonly ca?: string;
  readonly route?: RelayRoute;
}

export interface Nip11FetcherOptions extends RelayIoOptions {
  readonly timeoutMs?: number;
}

/** The parts of a target this module accepts, or undefined: fail closed on anything else. */
function checkedTarget(target: RelayTarget): { address: string; path: string } | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const { url, host, port, address } = target;
  if (typeof url !== 'string' || typeof host !== 'string' || typeof address !== 'string') {
    return undefined;
  }
  // Only a plain IPv4 or IPv6 address (no zone id, no name): the pool's check approved exactly it.
  if (isIP(address) === 0 || address.includes('%')) return undefined;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
  const match = RELAY_PARTS.exec(url);
  if (match === null) return undefined;
  // The Host header comes from the URL and SNI from `host`: they must name the same relay and port.
  if (match[1] !== host || Number(match[2] ?? 443) !== port) return undefined;
  return { address, path: match[3] ?? '/' };
}

/** A TLS socket to the checked address, with SNI and certificate checks on the host name. */
function pinnedTls(target: RelayTarget, address: string, options: RelayIoOptions): TLSSocket {
  const routed =
    options.route === undefined
      ? { address, port: target.port }
      : options.route(address, target.port);
  const socket = tlsConnect({
    host: routed.address,
    port: routed.port,
    servername: target.host,
    ALPNProtocols: ['http/1.1'],
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, cert) => checkServerIdentity(target.host, cert),
    ...(options.ca === undefined ? {} : { ca: options.ca }),
  });
  // A relay can reset the connection at any moment. The request or WebSocket that owns the socket
  // handles its errors; this listener only makes sure a late one (after they let go of the socket)
  // can never become an uncaught exception that ends the agent.
  socket.on('error', () => undefined);
  return socket;
}

/** A socket that never opened: reports one close, asynchronously, as a failed connection does. */
function refused(handlers: RelaySocketHandlers): RelaySocket {
  queueMicrotask(() => {
    try {
      handlers.onClose();
    } catch {
      // the pool's handler fault is not ours to report
    }
  });
  return { send: () => undefined, close: () => undefined };
}

/** The connector with test seams. Production: nodeRelayConnector(). */
export function createRelayConnectorWith(options: RelayIoOptions = {}): RelayConnector {
  return {
    open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
      const checked = checkedTarget(target);
      if (checked === undefined) return refused(handlers);
      let ws: WebSocket;
      try {
        ws = new WebSocket(target.url, {
          createConnection: () => pinnedTls(target, checked.address, options),
          followRedirects: false,
          maxRedirects: 0,
          maxPayload: MAX_FRAME_BYTES,
          perMessageDeflate: false,
          handshakeTimeout: CONNECT_TIMEOUT_MS,
          closeTimeout: CLOSE_TIMEOUT_MS,
          maxHeaderSize: MAX_HEADER_BYTES,
          skipUTF8Validation: false,
        } as WebSocket.ClientOptions);
      } catch {
        return refused(handlers);
      }
      let closed = false;
      // Errors carry relay text and addresses: they are swallowed here and end as a close. A non-101
      // answer to the upgrade (a redirect, say) makes `ws` abort the handshake, because nothing
      // listens for 'unexpected-response' and followRedirects is off: never read, never followed.
      ws.on('error', () => undefined);
      ws.on('open', () => {
        if (!closed) handlers.onOpen();
      });
      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (closed || isBinary) return; // Nostr frames are text; binary frames are dropped here
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data).toString('utf8');
        handlers.onMessage(text);
      });
      ws.on('close', () => {
        if (closed) return;
        closed = true;
        handlers.onClose();
      });
      return {
        send(text: string): void {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(text, { binary: false });
        },
        close(): void {
          if (ws.readyState === WebSocket.OPEN) ws.close(1000);
          else ws.terminate();
        },
      };
    },
  };
}

/** The Node relay connector (07 §4.2): pinned address, no redirects, no proxy, 131 072-byte cap. */
export function nodeRelayConnector(): RelayConnector {
  return createRelayConnectorWith();
}

/** `dns.lookup` with `all: true`, injectable for tests. */
export type LookupAll = (
  host: string,
  options: { all: true; order: 'verbatim' },
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: readonly { address: string; family: number }[],
  ) => void,
) => void;

/** The resolver with an injected lookup. Production: nodeHostResolver(). */
export function createHostResolverWith(options: { readonly lookup: LookupAll }): HostResolver {
  return {
    resolve(host: string): Promise<readonly string[]> {
      return new Promise((resolve, reject) => {
        try {
          options.lookup(host, { all: true, order: 'verbatim' }, (error, addresses) => {
            if (error !== null || !Array.isArray(addresses)) {
              reject(new Error('relay host lookup failed')); // no host name, no resolver text
              return;
            }
            resolve(addresses.map((entry) => entry.address));
          });
        } catch {
          reject(new Error('relay host lookup failed'));
        }
      });
    },
  };
}

/**
 * The Node host resolver (07 §4.2 step 1): every A and AAAA answer of the system resolver. Read
 * through the module object at call time, so the pool's check and nothing else does the lookup.
 */
export function nodeHostResolver(): HostResolver {
  return createHostResolverWith({
    lookup: (host, options, callback) =>
      dns.lookup(host, options, (error, addresses) => callback(error, addresses)),
  });
}

/** The NIP-11 fetcher with test seams. Production: nodeNip11Fetcher(). */
export function createNip11FetcherWith(options: Nip11FetcherOptions = {}): Nip11Fetcher {
  const timeoutMs = options.timeoutMs ?? NIP11_TIMEOUT_MS;
  return {
    fetch(target: RelayTarget): Promise<string> {
      return new Promise((resolve, reject) => {
        const checked = checkedTarget(target);
        if (checked === undefined) {
          reject(new Error('relay information unavailable'));
          return;
        }
        let done = false;
        const fail = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error('relay information unavailable')); // fixed text: nothing from the relay
        };
        const req = httpsRequest({
          method: 'GET',
          host: target.host,
          port: target.port,
          defaultPort: 443,
          path: checked.path,
          headers: { Accept: 'application/nostr+json', Connection: 'close' },
          // Our own socket and no agent: no proxy, no pooled connection to another address.
          agent: undefined,
          createConnection: () => pinnedTls(target, checked.address, options),
          maxHeaderSize: MAX_HEADER_BYTES,
        });
        // One deadline for the whole exchange, from the first byte to the last.
        const timer = setTimeout(fail, timeoutMs);
        req.on('error', fail);
        req.on('response', (res) => {
          // 200 only: a redirect (3xx) is never followed, an error page is never read.
          if (res.statusCode !== 200) {
            res.resume();
            fail();
            return;
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > NIP11_MAX_BYTES) {
            fail();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            if (done) return;
            size += chunk.length;
            if (size > NIP11_MAX_BYTES) {
              fail();
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', fail);
          res.on('aborted', fail);
          res.on('end', () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            req.destroy();
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        });
        req.end();
      });
    },
  };
}

/** The Node NIP-11 fetcher: pinned HTTPS GET, 200 only, 65 536-byte cap, NIP11_TIMEOUT_MS deadline. */
export function nodeNip11Fetcher(): Nip11Fetcher {
  return createNip11FetcherWith();
}
