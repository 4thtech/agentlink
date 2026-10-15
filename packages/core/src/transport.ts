// The Transport adapter over @agentlink/transport-nostr (07 §4.1, §4.2; M1-7k).
//
// 07 §4.1 sketches `publish(envelope, recipients, keys)` as one step. The outbox needs it in two
// (07 §3.2 "Transaction"): the core wraps first, stores the envelope with every signed wrap as
// outbox rows in one store transaction, and only then publishes the stored events. So this
// interface splits it: `wrap` makes one NIP-59 gift wrap per distinct recipient key and publishes
// nothing; `publish` sends one stored, signed wrap to exactly the relays its row lists (07 §4.3: a
// wrap never goes to a relay outside its row's list). `subscribe` and `sync` join with M1-7h.
//
// The runtime supplies the relay I/O (connector, address check, NIP-11; packages/node for Node,
// 07 §4.2), so the core opens no socket itself. The core supplies the keys: the agent's KeyStore
// signs the seals and, only on the agent's own relays, NIP-42 AUTH (07 §4.3: deny by default).
import type { Envelope, EnvelopeKeys, NostrEvent } from '@agentlink/crypto';
import type { Logger } from '@agentlink/log';
import {
  RelayPool,
  wrapEnvelope,
  type AddressCheck,
  type Nip11Fetcher,
  type PublishOutcome,
  type RelayConnector,
  type Timers,
  type WrappedEnvelope,
} from '@agentlink/transport-nostr';

/** The transport as the core's send pipeline and outbox use it (07 §4.1, split as above). */
export interface Transport {
  /**
   * One gift wrap per distinct key in `recipients` (64 lowercase hex Nostr keys), sealed with
   * `keys`, whose seal key must be `envelope.from`. Publishes nothing.
   */
  wrap(
    envelope: Envelope,
    recipients: readonly string[],
    keys: EnvelopeKeys,
  ): Promise<WrappedEnvelope>;
  /** Publishes one stored, signed wrap to exactly `relays` (1 to 32). Never to any other relay. */
  publish(event: NostrEvent, relays: readonly string[]): Promise<PublishOutcome>;
}

/** What the core hands a transport factory when it opens a client. */
export interface TransportDeps {
  /** The agent's KeyStore: seals and NIP-42 AUTH (04 §3.1.1). */
  readonly keys: EnvelopeKeys;
  /** The store's clock, Unix seconds (07 §3.1). Gift-wrap timestamps are back-dated from it. */
  readonly now: () => number;
  /** True for a relay in the agent's own list, the only relays where AUTH may be signed (07 §4.3). */
  readonly mayAuthenticate: (relayUrl: string) => boolean;
  readonly logger?: Logger;
}

/** Builds the client's Transport. `AgentLinkClient.create({ transport })` takes one of these. */
export type TransportFactory = (deps: TransportDeps) => Transport;

/** The runtime's relay I/O for the Nostr transport (07 §4.2). packages/node supplies them. */
export interface NostrTransportOptions {
  readonly connector: RelayConnector;
  /** How relay addresses are checked (07 §4.2). Required: skipping the check is a named choice. */
  readonly addressCheck: AddressCheck;
  readonly nip11?: Nip11Fetcher;
  readonly timers?: Timers;
}

/** The Nostr Transport: transport-nostr's wrapEnvelope and RelayPool (07 §4.2). */
export function nostrTransport(options: NostrTransportOptions): TransportFactory {
  return (deps) => {
    const pool = new RelayPool({
      connector: options.connector,
      addressCheck: options.addressCheck,
      ...(options.nip11 === undefined ? {} : { nip11: options.nip11 }),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      authKeys: deps.keys,
      mayAuthenticate: deps.mayAuthenticate,
    });
    return {
      wrap: (envelope, recipients, keys) =>
        wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
      publish: (event, relays) => pool.publish(event, relays),
    };
  };
}
