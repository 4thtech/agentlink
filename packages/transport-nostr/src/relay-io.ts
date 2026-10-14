// M1-5b: the I/O seams of the relay pool. This package builds for Node, browsers and Workers and may
// not import Node built-ins (tools/deps-check/policy.mjs), so everything that touches a socket, DNS or
// HTTP is injected. packages/node (and the desktop app) implement them with sockets they control; a
// browser or Worker implements RelayConnector over its own WebSocket and passes `platform` for the
// address check (07 §4.2 "Residual risk"). Tests implement them with mock relays: no network.

/** One relay connection target, after the address check (07 §4.2, steps 1 to 3). */
export interface RelayTarget {
  /** The validated relay URL, verbatim (04 §4: the transport connects to exactly this string). */
  readonly url: string;
  /** The host name: TLS SNI, certificate verification and the HTTP `Host` header use it. */
  readonly host: string;
  /** The port (443 when the URL has none). */
  readonly port: number;
  /**
   * The checked address to open the TCP connection to, never the host name again (DNS rebinding,
   * 07 §4.2 step 3). Undefined only when the runtime does not control its sockets (`platform`).
   */
  readonly address: string | undefined;
}

/** What a socket reports back to the pool. */
export interface RelaySocketHandlers {
  /** The WebSocket upgrade completed. */
  onOpen(): void;
  /** One text frame. Anything that is not a string (a binary frame) is dropped by the pool. */
  onMessage(data: unknown): void;
  /** The connection ended, for any reason (including a failed upgrade). The pool tolerates repeats. */
  onClose(): void;
}

/** An open (or opening) WebSocket to one relay. */
export interface RelaySocket {
  send(text: string): void;
  close(): void;
}

/**
 * Opens a WebSocket to `target`. The implementation must (07 §4.2): connect to `target.address` when
 * it is set, with SNI, certificate verification and `Host` from `target.host`; never follow a
 * redirect on the upgrade; ignore HTTPS_PROXY, ALL_PROXY and the like.
 */
export interface RelayConnector {
  open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket;
}

/** Resolves a host name to its A and AAAA answers (07 §4.2 step 1). */
export interface HostResolver {
  resolve(host: string): Promise<readonly string[]>;
}

/**
 * Fetches the NIP-11 relay information document: an HTTPS GET of the relay's host with
 * `Accept: application/nostr+json`, to the same checked address, no redirects. Returns the body text.
 * The pool bounds its size and reads only `limitation.max_message_length` from it.
 */
export interface Nip11Fetcher {
  fetch(target: RelayTarget): Promise<string>;
}

/**
 * How the pool checks relay addresses (07 §4.2).
 * - `{ resolver }`: runtimes that own their sockets (Node, the desktop app). Every answer must be
 *   globally routable, and the connector gets the checked address.
 * - `'platform'`: browsers and Workers, which cannot resolve or pin an address. The schema rule and
 *   the platform apply (the residual risk of 07 §4.2). It is a named choice, never a default.
 */
export type AddressCheck = { readonly resolver: HostResolver } | 'platform';

/** Timers, injected so tests drive the 10 s, 5 min and 24 h rules with a fake clock. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
