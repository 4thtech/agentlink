// Test double for the relay pool's I/O seams (relay-io.ts): mock relays, a stub resolver and a stub
// NIP-11 fetcher in one object, with no network. Excluded from the build (tsconfig.json); only tests
// import it. A mock relay speaks enough NIP-01, NIP-11 and NIP-42 for the M1-5b acceptance tests.
import { NOSTR_KIND_AUTH, encodeUtf8, verifyNostrEvent, type NostrEvent } from '@agentlink/crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type {
  HostResolver,
  Nip11Fetcher,
  RelayConnector,
  RelaySocket,
  RelaySocketHandlers,
  RelayTarget,
} from '../relay-io.js';

/** How one mock relay behaves. */
export interface MockRelayConfig {
  /** Never completes the WebSocket upgrade (a black hole). */
  blackHole?: boolean;
  /** Accepts the connection but never answers an EVENT. */
  silent?: boolean;
  /** Sends an AUTH challenge on connect and refuses EVENT until a valid AUTH (NIP-42). */
  requireAuth?: boolean;
  /** Advertised in NIP-11 and enforced on EVENT frames. */
  maxMessageLength?: number;
  /** Answers every EVENT with OK false. */
  reject?: boolean;
  /** The text after OK (a relay sends whatever it likes). */
  okMessage?: string;
  /** Overrides the NIP-11 body; `null` makes the fetch fail. */
  nip11Body?: string | null;
}

const microtask = (fn: () => void): void => {
  void Promise.resolve().then(fn);
};

export const PUBLIC_ADDRESS = '93.184.216.34';

export class MockSocket implements RelaySocket {
  authed = false;
  closed = false;
  readonly challenge: string;

  constructor(
    readonly network: MockNetwork,
    readonly target: RelayTarget,
    readonly handlers: RelaySocketHandlers,
  ) {
    this.challenge = `challenge-${network.sockets.length}`;
    const config = this.config;
    if (config.blackHole === true) return;
    microtask(() => {
      if (this.closed) return;
      handlers.onOpen();
      if (config.requireAuth === true) this.push(JSON.stringify(['AUTH', this.challenge]));
    });
  }

  /** The relay sends `text` to the client. */
  push(text: string): void {
    if (this.closed) return;
    microtask(() => {
      if (!this.closed) this.handlers.onMessage(text);
    });
  }

  /** The relay drops the connection. */
  dropFromRelay(): void {
    if (this.closed) return;
    this.closed = true;
    microtask(() => this.handlers.onClose());
  }

  /** Read live, so a test can change a relay's behaviour between sends. */
  get config(): MockRelayConfig {
    return this.network.relays.get(this.target.url) ?? {};
  }

  send(text: string): void {
    if (this.closed) throw new Error('socket closed');
    this.network.received.push({ relay: this.target.url, frame: text });
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(frame)) return;
    const config = this.config;
    if (frame[0] === 'AUTH') {
      const event = frame[1] as NostrEvent;
      const tags = event.tags;
      const valid =
        verifyNostrEvent(event) &&
        event.kind === NOSTR_KIND_AUTH &&
        tags.some((t) => t[0] === 'relay' && t[1] === this.target.url) &&
        tags.some((t) => t[0] === 'challenge' && t[1] === this.challenge);
      this.authed = valid;
      this.push(JSON.stringify(['OK', event.id, valid, valid ? '' : 'invalid: bad auth']));
      return;
    }
    if (frame[0] !== 'EVENT') return;
    const event = frame[1] as NostrEvent;
    if (config.silent === true) return;
    if (config.requireAuth === true && !this.authed) {
      this.push(JSON.stringify(['OK', event.id, false, 'auth-required: log in first']));
      return;
    }
    if (
      config.maxMessageLength !== undefined &&
      encodeUtf8(text).length > config.maxMessageLength
    ) {
      this.push(JSON.stringify(['OK', event.id, false, 'invalid: message too large']));
      return;
    }
    if (config.reject === true) {
      this.push(JSON.stringify(['OK', event.id, false, config.okMessage ?? 'blocked: no']));
      return;
    }
    this.network.stored.push({ relay: this.target.url, event });
    this.push(JSON.stringify(['OK', event.id, true, config.okMessage ?? '']));
  }

  close(): void {
    this.closed = true;
    this.network.closedCount += 1;
  }
}

export class MockNetwork implements RelayConnector, HostResolver, Nip11Fetcher {
  readonly relays = new Map<string, MockRelayConfig>();
  /** Host to the addresses the resolver answers. Hosts not listed resolve to PUBLIC_ADDRESS. */
  readonly dns = new Map<string, string[]>();
  /** Per host, successive answers; each resolve takes the next one, then the last repeats. */
  readonly dnsSequence = new Map<string, string[][]>();
  readonly resolves: string[] = [];
  readonly opens: RelayTarget[] = [];
  readonly nip11Fetches: RelayTarget[] = [];
  readonly sockets: MockSocket[] = [];
  readonly received: { relay: string; frame: string }[] = [];
  readonly stored: { relay: string; event: NostrEvent }[] = [];
  closedCount = 0;

  configure(url: string, config: MockRelayConfig = {}): string {
    this.relays.set(url, config);
    return url;
  }

  /** The last socket opened to `url`. */
  socket(url: string): MockSocket | undefined {
    return this.sockets.filter((s) => s.target.url === url).at(-1);
  }

  /** Relays that stored `event`. */
  storedOn(eventId: string): string[] {
    return this.stored.filter((s) => s.event.id === eventId).map((s) => s.relay);
  }

  /** Every distinct relay URL a socket was opened to. */
  openedUrls(): string[] {
    return [...new Set(this.opens.map((t) => t.url))];
  }

  open(target: RelayTarget, handlers: RelaySocketHandlers): MockSocket {
    this.opens.push(target);
    const socket = new MockSocket(this, target, handlers);
    this.sockets.push(socket);
    return socket;
  }

  resolve(host: string): Promise<readonly string[]> {
    this.resolves.push(host);
    const sequence = this.dnsSequence.get(host);
    if (sequence !== undefined && sequence.length > 0) {
      const count = this.resolves.filter((h) => h === host).length;
      return Promise.resolve(sequence[Math.min(count, sequence.length) - 1] as string[]);
    }
    return Promise.resolve(this.dns.get(host) ?? [PUBLIC_ADDRESS]);
  }

  fetch(target: RelayTarget): Promise<string> {
    this.nip11Fetches.push(target);
    const config = this.relays.get(target.url) ?? {};
    if (config.nip11Body === null) return Promise.reject(new Error('nip11 unavailable'));
    if (config.nip11Body !== undefined) return Promise.resolve(config.nip11Body);
    const doc =
      config.maxMessageLength === undefined
        ? { name: 'mock' }
        : { name: 'mock', limitation: { max_message_length: config.maxMessageLength } };
    return Promise.resolve(JSON.stringify(doc));
  }
}

/** `count` valid, distinct relay URLs (lower-case names, no numeric label, not a denied suffix). */
export function relayUrls(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `wss://${prefix}-${i}.nostr-test.dev`);
}

/** A validly signed kind 1059 event for a fresh recipient: all the pool and the outbox look at. */
export function makeWrapEvent(
  options: { content?: string; recipient?: string; createdAt?: number } = {},
): NostrEvent {
  const recipient = options.recipient ?? getPublicKey(generateSecretKey());
  return finalizeEvent(
    {
      kind: 1059,
      created_at: options.createdAt ?? 1_700_000_000,
      tags: [['p', recipient]],
      content: options.content ?? 'AAAA',
    },
    generateSecretKey(),
  ) as unknown as NostrEvent;
}
