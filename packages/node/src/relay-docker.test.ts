// M1-5b-b: the relay pool and outbox of @agentlink/transport-nostr, through the Node relay connector,
// against real relays in Docker (IR-M1-5b-1 M-1). Three containers from two relay implementations,
// pinned by digest:
//   - relay-open:  strfry with its default limits;
//   - relay-small: strfry with a 1 024-byte `maxWebsocketPayloadSize`, which its NIP-11 document
//                  reports as `limitation.max_message_length`, so the pool must skip it;
//   - relay-auth:  rnostr with `[auth.event] pubkey_whitelist`, which answers an EVENT from a
//                  connection that has not logged in with `OK false "auth-required: ..."`, so the
//                  pool must complete NIP-42 AUTH.
// The relays listen in plain WebSocket on 127.0.0.1; a TLS terminator in this file puts the test
// certificate in front of each, because the connector only speaks wss (04 §4). The pool checks a
// public answer from a stub resolver, and the connector's `route` seam sends that checked address
// to the local terminator: everything else (TLS, SNI, Host, the message cap, NIP-11) is the
// production code path.
//
// Opt-in, and never silently skipped where it is required: it runs only with
// AGENTLINK_REQUIRE_DOCKER=1, and with that flag a missing or broken Docker FAILS the run (as
// AGENTLINK_REQUIRE_KEYCHAIN=1 does for the keychain suite). CI sets the flag in the job that runs it.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as netConnect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { promisify } from 'node:util';
import type { NostrEvent } from '@agentlink/crypto';
import {
  OUTBOX_GIVE_UP_SECONDS,
  OutboxWorker,
  RelayPool,
  type OutboxAttempt,
  type OutboxPersistence,
  type OutboxRow,
} from '@agentlink/transport-nostr';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KeychainKeyStore } from './keychain-keystore.js';
import {
  makeSignedWrap,
  makeTestAgent,
  makeTestCertificate,
  type TestCertificate,
} from './relay-io.fixture.js';
import { createNip11FetcherWith, createRelayConnectorWith } from './relay-io.js';

const execFileAsync = promisify(execFile);
/** One label value per run: afterAll removes every container of this run, even after a failed start. */
const RUN_LABEL = `agentlink-test=relay-docker-${process.pid}-${Date.now()}`;
const required = process.env['AGENTLINK_REQUIRE_DOCKER'] === '1';

/** Relay images, pinned by digest (the PR body records why these two implementations). */
const RELAY_IMAGES = {
  // dockurr/strfry 1.1.3 (multi-arch index: linux/amd64, linux/arm64).
  strfry: 'dockurr/strfry@sha256:599ab3500dbfbe6cb78c668e1892cd9802c192d066df4660e8e3175034a8344d',
  // rnostr/rnostr v0.4.9 (index; linux/amd64 only, so the run asks for that platform).
  rnostr: 'rnostr/rnostr@sha256:c022e4384f8fe1eb6023d497fe0c5cf9cd13d239f62160713546de4522f69214',
} as const;

/** strfry does not create its database directory; the image has no entrypoint, so start it from a shell. */
const STRFRY_COMMAND = [
  'sh',
  '-c',
  'mkdir -p /app/strfry-db && exec /app/strfry --config=/etc/strfry.conf relay',
];

const OPEN = 'wss://relay-open.nostr-test.dev';
const SMALL = 'wss://relay-small.nostr-test.dev';
const AUTH = 'wss://relay-auth.nostr-test.dev';
const HOSTS = [
  'relay-open.nostr-test.dev',
  'relay-small.nostr-test.dev',
  'relay-auth.nostr-test.dev',
];
/** The stub resolver's public answers; `route` maps each to its local TLS terminator. */
const ANSWERS: Record<string, string> = {
  'relay-open.nostr-test.dev': '93.184.215.11',
  'relay-small.nostr-test.dev': '93.184.215.12',
  'relay-auth.nostr-test.dev': '93.184.215.13',
};

interface RunningRelay {
  readonly container: string;
  readonly wsPort: number;
  readonly tlsPort: number;
  readonly terminator: Server;
}

const docker = async (...args: string[]): Promise<string> =>
  (
    await execFileAsync('docker', args, { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })
  ).stdout.trim();

const strfryConfig = (maxPayload: number): string => `db = "/app/strfry-db/"
relay {
    bind = "0.0.0.0"
    port = 7777
    nofiles = 0
    maxWebsocketPayloadSize = ${maxPayload}
    info {
        name = "agentlink test relay"
    }
}
`;

const rnostrConfig = (pubkey: string): string => `[information]
name = "agentlink test relay (auth)"

[data]
path = "./data"

[network]
host = "0.0.0.0"
port = 8080

[auth]
enabled = true

[auth.event]
pubkey_whitelist = ["${pubkey}"]
`;

/** Plain HTTP NIP-11 GET straight to the container, for readiness only. */
function nip11Ready(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        headers: { Accept: 'application/nostr+json' },
        timeout: 2_000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitReady(port: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await nip11Ready(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`relay on port ${port} did not become ready`);
}

/** A TLS terminator on 127.0.0.1 in front of a plain relay port. */
async function terminate(
  certificate: TestCertificate,
  port: number,
): Promise<{ server: Server; port: number }> {
  const server = createTlsServer({ cert: certificate.cert, key: certificate.key }, (tls) => {
    const upstream = netConnect(port, '127.0.0.1');
    tls.pipe(upstream).pipe(tls);
    const end = () => {
      tls.destroy();
      upstream.destroy();
    };
    tls.on('error', end);
    upstream.on('error', end);
    tls.on('close', end);
    upstream.on('close', end);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, port: address.port };
}

async function startRelay(
  certificate: TestCertificate,
  options: {
    image: string;
    platform?: string;
    containerPort: number;
    config: string;
    configPath: string;
    command: string[];
  },
  dir: string,
): Promise<RunningRelay> {
  const configFile = join(dir, `config-${Math.random().toString(36).slice(2)}`);
  writeFileSync(configFile, options.config, { mode: 0o644 });
  const container = await docker(
    'create',
    ...(options.platform === undefined ? [] : ['--platform', options.platform]),
    '--label',
    RUN_LABEL,
    '-p',
    `127.0.0.1::${options.containerPort}`,
    options.image,
    ...options.command,
  );
  try {
    await docker('cp', configFile, `${container}:${options.configPath}`);
    await docker('start', container);
    const mapped = await docker('port', container, `${options.containerPort}/tcp`);
    const wsPort = Number(/:(\d+)\s*$/m.exec(mapped.split('\n')[0] ?? '')?.[1]);
    if (!Number.isInteger(wsPort)) throw new Error('no mapped port');
    await waitReady(wsPort);
    const { server, port } = await terminate(certificate, wsPort);
    return { container, wsPort, tlsPort: port, terminator: server };
  } catch (error) {
    await docker('rm', '-f', container).catch(() => undefined);
    throw error;
  }
}

/** Asks a relay directly (plain ws to the container) for an event by id. */
function fetchEventById(wsPort: number, id: string): Promise<NostrEvent | undefined> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/`);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(undefined);
    }, 10_000);
    let found: NostrEvent | undefined;
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'q', { ids: [id] }])));
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as unknown[];
      if (frame[0] === 'EVENT' && frame[1] === 'q') found = frame[2] as NostrEvent;
      if (frame[0] === 'EOSE' || frame[0] === 'CLOSED') {
        clearTimeout(timer);
        ws.close();
        resolve(found);
      }
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

/** The outbox table in a JSON file: a "restart" is a new instance over the same file. */
class FileOutbox implements OutboxPersistence {
  constructor(private readonly path: string) {}
  private read(): (OutboxRow & { state: string })[] {
    return JSON.parse(readFileSync(this.path, 'utf8')) as (OutboxRow & { state: string })[];
  }
  private write(rows: (OutboxRow & { state: string })[]): void {
    writeFileSync(this.path, JSON.stringify(rows));
  }
  static create(path: string, rows: OutboxRow[]): FileOutbox {
    writeFileSync(path, JSON.stringify(rows.map((row) => ({ ...row, state: 'pending' }))));
    return new FileOutbox(path);
  }
  row(wrapId: string): (OutboxRow & { state: string }) | undefined {
    return this.read().find((row) => row.wrapId === wrapId);
  }
  listDue(nowSeconds: number): Promise<readonly OutboxRow[]> {
    return Promise.resolve(
      this.read().filter((row) => row.state === 'pending' && row.nextAttemptAt <= nowSeconds),
    );
  }
  isPending(wrapId: string): Promise<boolean> {
    return Promise.resolve(this.row(wrapId)?.state === 'pending');
  }
  private update(wrapId: string, change: Partial<OutboxRow & { state: string }>): Promise<boolean> {
    const rows = this.read();
    const at = rows.findIndex((row) => row.wrapId === wrapId && row.state === 'pending');
    if (at === -1) return Promise.resolve(false);
    rows[at] = { ...(rows[at] as OutboxRow & { state: string }), ...change };
    this.write(rows);
    return Promise.resolve(true);
  }
  recordAttempt(wrapId: string, attempt: OutboxAttempt): Promise<boolean> {
    return this.update(wrapId, { ...attempt });
  }
  markSent(wrapId: string, acks: Readonly<Record<string, number>>): Promise<boolean> {
    return this.update(wrapId, { acks, state: 'sent' });
  }
  markNotDelivered(wrapId: string): Promise<boolean> {
    return this.update(wrapId, { state: 'not_delivered' });
  }
}

describe.skipIf(!required)(
  'real relays in Docker (M1-5b-b; skipped unless AGENTLINK_REQUIRE_DOCKER=1, which also makes a missing Docker fail the run)',
  () => {
    let certificate: TestCertificate;
    let dir: string;
    let keys: KeychainKeyStore;
    let authPubkey: string;
    const running: Record<string, RunningRelay> = {};
    let dockerError: unknown;
    /** Relay hosts whose checked address is routed to a closed port (an unreachable relay). */
    const blocked = new Set<string>();

    const route = (address: string, port: number) => {
      const host = Object.keys(ANSWERS).find((name) => ANSWERS[name] === address);
      const relay = host === undefined ? undefined : running[host];
      if (host === undefined || relay === undefined || blocked.has(host)) {
        return { address: '127.0.0.1', port: 1 };
      }
      return { address: '127.0.0.1', port: port === 443 ? relay.tlsPort : 1 };
    };

    const newPool = (withAuth: boolean) =>
      new RelayPool({
        connector: createRelayConnectorWith({ ca: certificate.cert, route }),
        nip11: createNip11FetcherWith({ ca: certificate.cert, route }),
        addressCheck: {
          resolver: {
            resolve: (host) => Promise.resolve(ANSWERS[host] === undefined ? [] : [ANSWERS[host]]),
          },
        },
        ...(withAuth ? { authKeys: keys, mayAuthenticate: (url: string) => url === AUTH } : {}),
      });

    beforeAll(async () => {
      try {
        await docker('info', '--format', '{{.ServerVersion}}');
      } catch (error) {
        dockerError = error;
        return;
      }
      certificate = makeTestCertificate(HOSTS);
      dir = mkdtempSync(join(tmpdir(), 'agentlink-relay-docker-'));
      keys = await makeTestAgent();
      authPubkey = (await keys.signNostr({ kind: 13, created_at: 0, tags: [], content: '' }))
        .pubkey;
      const [open, small, auth] = await Promise.all([
        startRelay(
          certificate,
          {
            image: RELAY_IMAGES.strfry,
            containerPort: 7777,
            config: strfryConfig(131_072),
            configPath: '/etc/strfry.conf',
            command: STRFRY_COMMAND,
          },
          dir,
        ),
        startRelay(
          certificate,
          {
            image: RELAY_IMAGES.strfry,
            containerPort: 7777,
            config: strfryConfig(1_024),
            configPath: '/etc/strfry.conf',
            command: STRFRY_COMMAND,
          },
          dir,
        ),
        startRelay(
          certificate,
          {
            image: RELAY_IMAGES.rnostr,
            platform: 'linux/amd64',
            containerPort: 8080,
            config: rnostrConfig(authPubkey),
            configPath: '/rnostr/config/rnostr.toml',
            command: ['relay', '-c', '/rnostr/config/rnostr.toml'],
          },
          dir,
        ),
      ]);
      running['relay-open.nostr-test.dev'] = open;
      running['relay-small.nostr-test.dev'] = small;
      running['relay-auth.nostr-test.dev'] = auth;
    }, 900_000);

    afterAll(async () => {
      for (const relay of Object.values(running)) relay.terminator.close();
      // Every container of this run, including those of a start that failed half-way (IR-M1-5b-b-1 I-1).
      const ids = await docker('ps', '-aq', '--filter', `label=${RUN_LABEL}`).catch(() => '');
      const containers = new Set([
        ...Object.values(running).map((relay) => relay.container),
        ...ids.split('\n').filter((id) => id.length > 0),
      ]);
      if (containers.size > 0) await docker('rm', '-f', ...containers).catch(() => undefined);
      await keys?.close();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }, 120_000);

    it('Docker is available (with AGENTLINK_REQUIRE_DOCKER=1 a missing Docker fails here)', () => {
      expect(
        dockerError,
        'AGENTLINK_REQUIRE_DOCKER=1 is set but `docker info` failed',
      ).toBeUndefined();
      expect(Object.keys(running).sort()).toEqual([...HOSTS].sort());
    });

    it('publishes with 2 OKs: the small relay is skipped and AUTH completes on the auth relay', async () => {
      const pool = newPool(true);
      try {
        const event = await makeSignedWrap(keys, 2_048);
        const outcome = await pool.publish(event, [OPEN, SMALL, AUTH]);
        expect(Object.fromEntries(outcome.results.map((r) => [r.relay, r.reason]))).toEqual({
          [OPEN]: 'ok',
          [SMALL]: 'too_large',
          [AUTH]: 'ok',
        });
        expect(outcome.sent).toBe(true);
        expect(pool.relayHealth().find((h) => h.relay === SMALL)?.maxMessageLength).toBe(1_024);
        const openRelay = running['relay-open.nostr-test.dev'] as RunningRelay;
        const authRelay = running['relay-auth.nostr-test.dev'] as RunningRelay;
        expect((await fetchEventById(openRelay.wsPort, event.id))?.id).toBe(event.id);
        expect((await fetchEventById(authRelay.wsPort, event.id))?.id).toBe(event.id);
      } finally {
        pool.close();
      }
    }, 120_000);

    it('is not sent with only 1 OK, and the auth relay refuses a pool that may not log in', async () => {
      const pool = newPool(false);
      try {
        const event = await makeSignedWrap(keys, 2_048);
        const outcome = await pool.publish(event, [OPEN, SMALL, AUTH]);
        expect(Object.fromEntries(outcome.results.map((r) => [r.relay, r.reason]))).toEqual({
          [OPEN]: 'ok',
          [SMALL]: 'too_large',
          [AUTH]: 'auth_failed',
        });
        expect(outcome.acked).toEqual([OPEN]);
        expect(outcome.sent).toBe(false);
      } finally {
        pool.close();
      }
    }, 120_000);

    it('an outbox row survives a restart and the stored wrap is republished', async () => {
      const event = await makeSignedWrap(keys, 512);
      const createdAt = Math.floor(Date.now() / 1000);
      const file = join(dir, 'outbox.json');
      const row: OutboxRow = {
        wrapId: event.id,
        envelopeId: 'env-1',
        recipientKey: (event.tags.find((tag) => tag[0] === 'p') ?? [])[1] as string,
        wrapJson: JSON.stringify(event),
        relays: [OPEN, AUTH],
        acks: {},
        attempts: 0,
        nextAttemptAt: createdAt,
        createdAt,
        giveUpAt: createdAt + OUTBOX_GIVE_UP_SECONDS,
        role: 'contact',
      };
      FileOutbox.create(file, [row]);

      // First run: relay-open is unreachable, so only relay-auth acknowledges; the row stays pending.
      blocked.add('relay-open.nostr-test.dev');
      const pool1 = newPool(true);
      try {
        const first = await new OutboxWorker({
          persistence: new FileOutbox(file),
          pool: pool1,
        }).processDue();
        expect(first).toMatchObject({ sent: 0, retrying: 1 });
      } finally {
        pool1.close();
        blocked.delete('relay-open.nostr-test.dev');
      }
      const pending = new FileOutbox(file).row(event.id);
      expect(pending?.state).toBe('pending');
      expect(Object.keys(pending?.acks ?? {})).toEqual([AUTH]);
      const openRelay = running['relay-open.nostr-test.dev'] as RunningRelay;
      expect(await fetchEventById(openRelay.wsPort, event.id)).toBeUndefined();

      // Restart: a new persistence instance over the same file, a new pool and a new worker, at the
      // row's next attempt time.
      const pool2 = newPool(true);
      try {
        const second = await new OutboxWorker({
          persistence: new FileOutbox(file),
          pool: pool2,
          now: () => ((pending?.nextAttemptAt ?? createdAt) + 1) * 1000,
        }).processDue();
        expect(second).toMatchObject({ sent: 1, retrying: 0 });
      } finally {
        pool2.close();
      }
      const sent = new FileOutbox(file).row(event.id);
      expect(sent?.state).toBe('sent');
      expect(Object.keys(sent?.acks ?? {}).sort()).toEqual([AUTH, OPEN].sort());
      expect(sent?.wrapJson).toBe(JSON.stringify(event));
      const republished = await fetchEventById(openRelay.wsPort, event.id);
      expect(republished).toEqual(event);
    }, 120_000);
  },
);
