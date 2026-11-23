// RELAY-SHARED-CONN L3 (D-159; 04 §4 "Local relay link"; 07 §4.2 "One relay link per computer"):
// the per-user endpoint (Unix socket or Windows named pipe), the token file, the election, the
// server that hosts the mux, the client dialer, the hand-over and the off switch. Every test uses a
// temporary home and an in-memory relay: no network, never the real ~/.agentlink.
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { lstat } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FallbackConnector,
  LinkFrameReader,
  SHARED_LINK_MAX_FRAME_BYTES,
  decodeServerFrame,
  encodeLinkFrame,
  linkFrameBytes,
  type AddressCheck,
  type RelayConnector,
  type RelaySocket,
  type RelaySocketHandlers,
  type RelayTarget,
} from '@4thtech-io/transport-nostr';
import { randomBytes } from '@4thtech-io/crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RELAY_RUN_DIR,
  RELAY_SOCKET_FILE,
  RELAY_TOKEN_FILE,
  SOCKET_PATH_MAX_BYTES,
  checkSocket,
  ensureLinkToken,
  resolveEndpoint,
} from './shared-relay-endpoint.js';
import {
  SHARED_LINK_REPROBE_MS,
  SHARED_RELAYS_DEFAULT,
  SHARED_RELAYS_ENV,
  SharedRelayLink,
  createRelayConnectorWith,
  sharedRelaysEnabled,
  type SharedRelayLinkOptions,
} from './shared-relay-link.js';

const POSIX = process.platform !== 'win32';
const RELAY = 'wss://relay.example.com';
const TARGET: RelayTarget = {
  url: RELAY,
  host: 'relay.example.com',
  port: 443,
  address: '93.184.216.34',
};
const addressCheck: AddressCheck = {
  resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
};
const CLI = '0.5.18';

const homes: string[] = [];
const links: SharedRelayLink[] = [];
const raw: Socket[] = [];

function tempHome(prefix = 'al-l3-'): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  return home;
}

afterEach(async () => {
  for (const socket of raw.splice(0)) socket.destroy();
  for (const link of links.splice(0)) await link.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** An in-memory relay: answers every REQ with EOSE; records what it was asked to open. */
function fakeRelay(): { connector: RelayConnector; opens: RelayTarget[]; sent: string[] } {
  const opens: RelayTarget[] = [];
  const sent: string[] = [];
  const connector: RelayConnector = {
    open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
      opens.push(target);
      let closed = false;
      setTimeout(() => {
        if (!closed) handlers.onOpen();
      }, 1);
      return {
        send(text: string) {
          sent.push(text);
          const message = JSON.parse(text) as unknown[];
          if (message[0] === 'REQ') {
            setTimeout(() => {
              if (!closed) handlers.onMessage(JSON.stringify(['EOSE', message[1]]));
            }, 1);
          }
        },
        close() {
          if (closed) return;
          closed = true;
          setTimeout(() => handlers.onClose(), 1);
        },
      };
    },
  };
  return { connector, opens, sent };
}

interface Captured {
  lines: string[];
  logger: NonNullable<SharedRelayLinkOptions['logger']>;
}

function captureLogger(): Captured {
  const lines: string[] = [];
  const write =
    (level: string) =>
    (msg: string, fields?: unknown): void => {
      lines.push(JSON.stringify({ level, msg, fields }));
    };
  const logger = {
    level: 'debug',
    isEnabled: () => true,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => logger,
    withCodes: () => logger,
  } as unknown as NonNullable<SharedRelayLinkOptions['logger']>;
  return { lines, logger };
}

function makeLink(
  home: string,
  token: Uint8Array,
  extra: Partial<SharedRelayLinkOptions> = {},
): { link: SharedRelayLink; relay: ReturnType<typeof fakeRelay> } {
  const relay = fakeRelay();
  const link = new SharedRelayLink({
    home,
    cliVersion: CLI,
    token,
    direct: relay.connector,
    addressCheck,
    ...extra,
  });
  links.push(link);
  return { link, relay };
}

/** Opens a socket through `connector`, sends one REQ and waits for its EOSE. */
async function roundTrip(connector: RelayConnector, sub: string): Promise<string[]> {
  const messages: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no EOSE')), 3_000);
    let socket: RelaySocket | undefined = undefined;
    socket = connector.open(TARGET, {
      onOpen: () => socket?.send(JSON.stringify(['REQ', sub, { kinds: [1059] }])),
      onMessage: (data) => {
        messages.push(String(data));
        if (String(data).includes('EOSE')) {
          clearTimeout(timer);
          resolve();
        }
      },
      onClose: () => undefined,
    });
  });
  return messages;
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<number> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Date.now() - start;
}

function socketPath(home: string): string {
  return join(home, '.agentlink', RELAY_RUN_DIR, RELAY_SOCKET_FILE);
}

/** A raw connection to the endpoint: frames in, frames out, and whether it closed. */
async function rawClient(path: string): Promise<{
  socket: Socket;
  frames: string[];
  closed: () => boolean;
}> {
  const socket = connect(path);
  raw.push(socket);
  const frames: string[] = [];
  let closed = false;
  const reader = new LinkFrameReader();
  socket.on('data', (chunk: Buffer) => frames.push(...reader.push(new Uint8Array(chunk)).frames));
  socket.on('close', () => {
    closed = true;
  });
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  return { socket, frames, closed: () => closed };
}

const token = (): Uint8Array => randomBytes(32);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('token file (04 §4 "Local relay link")', () => {
  it('creates a 32-byte token in run/relay-link.json, mode 0600, in a 0700 folder, and reuses it', async () => {
    const home = tempHome();
    const first = await ensureLinkToken(home);
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first?.length).toBe(32);
    const file = join(home, '.agentlink', RELAY_RUN_DIR, RELAY_TOKEN_FILE);
    if (POSIX) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, '.agentlink', RELAY_RUN_DIR)).mode & 0o777).toBe(0o700);
    }
    const second = await ensureLinkToken(home);
    expect(hex(second as Uint8Array)).toBe(hex(first as Uint8Array));
  });

  it('is created atomically: racing processes all get the same token and no temporary file is left', async () => {
    const home = tempHome();
    const tokens = await Promise.all(Array.from({ length: 8 }, () => ensureLinkToken(home)));
    const unique = new Set(tokens.map((t) => hex(t as Uint8Array)));
    expect(unique.size).toBe(1);
    expect(readdirSync(join(home, '.agentlink', RELAY_RUN_DIR))).toEqual([RELAY_TOKEN_FILE]);
  });

  it('is regenerated when it is corrupt or a link', async () => {
    const home = tempHome();
    const first = (await ensureLinkToken(home)) as Uint8Array;
    const file = join(home, '.agentlink', RELAY_RUN_DIR, RELAY_TOKEN_FILE);
    writeFileSync(file, 'not json', { mode: 0o600 });
    const second = (await ensureLinkToken(home)) as Uint8Array;
    expect(second.length).toBe(32);
    expect(hex(second)).not.toBe(hex(first));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, token: hex(second) });
    if (POSIX) {
      rmSync(file);
      const elsewhere = join(home, 'elsewhere.json');
      writeFileSync(elsewhere, JSON.stringify({ v: 1, token: hex(first) }), { mode: 0o600 });
      symlinkSync(elsewhere, file);
      const third = (await ensureLinkToken(home)) as Uint8Array;
      expect(hex(third)).not.toBe(hex(first)); // a link is never followed
      expect(lstatSync(file).isSymbolicLink()).toBe(false);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});

describe('endpoint path', () => {
  it.runIf(POSIX)('is <home>/.agentlink/run/relay.sock when it fits', () => {
    const home = tempHome();
    const endpoint = resolveEndpoint(home, { platform: process.platform });
    expect(endpoint).toEqual({
      kind: 'unix',
      path: socketPath(home),
      dir: join(home, '.agentlink', RELAY_RUN_DIR),
    });
  });

  it('falls back to a short per-user path under the temporary folder past the sun_path limit', () => {
    const short = tempHome('al-tmp-');
    const home = join(tempHome(), 'x'.repeat(120));
    const endpoint = resolveEndpoint(home, {
      platform: 'darwin',
      tmpdir: () => short,
      uid: () => 501,
    });
    expect(endpoint?.kind).toBe('unix');
    if (endpoint?.kind !== 'unix') return;
    expect(Buffer.byteLength(endpoint.path)).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES.darwin);
    expect(endpoint.dir).toBe(join(short, 'agentlink-501'));
    expect(endpoint.path).toMatch(/r[0-9a-f]{16}\.sock$/);
    // Stable for one home, different for another.
    expect(
      resolveEndpoint(home, { platform: 'darwin', tmpdir: () => short, uid: () => 501 }),
    ).toEqual(endpoint);
    expect(
      resolveEndpoint(`${home}y`, { platform: 'darwin', tmpdir: () => short, uid: () => 501 }),
    ).not.toEqual(endpoint);
  });

  it('is a named pipe from a hash of the home folder on Windows', () => {
    const endpoint = resolveEndpoint('C:\\Users\\someone', { platform: 'win32' });
    expect(endpoint?.kind).toBe('pipe');
    expect(endpoint?.path).toMatch(/^\\\\\.\\pipe\\agentlink-relay-[0-9a-f]{16}$/);
    expect(resolveEndpoint('C:\\Users\\other', { platform: 'win32' })?.path).not.toBe(
      endpoint?.path,
    );
  });

  it.runIf(POSIX)('a long home works end to end through the fallback path', async () => {
    const short = tempHome('al-tmp-');
    const home = join(tempHome(), 'y'.repeat(120));
    mkdirSync(home, { recursive: true });
    const t = token();
    const a = makeLink(home, t, { tmpdir: () => short });
    const b = makeLink(home, t, { tmpdir: () => short });
    expect(await a.link.start()).toBe('winner');
    expect(await b.link.start()).toBe('client');
    if (POSIX)
      expect(statSync(join(short, `agentlink-${process.getuid?.()}`)).mode & 0o777).toBe(0o700);
  });
});

describe.runIf(POSIX)('election and sharing (Unix socket)', () => {
  it('two programs share one upstream: client dialer -> endpoint -> mux -> relay', async () => {
    const home = tempHome();
    const t = token();
    const a = makeLink(home, t);
    const b = makeLink(home, t);
    expect(await a.link.start()).toBe('winner');
    expect(await b.link.start()).toBe('client');
    const sharedA = new FallbackConnector(a.link.connector(), a.relay.connector);
    const sharedB = new FallbackConnector(b.link.connector(), b.relay.connector);
    const fromA = await roundTrip(sharedA, 'sub-a');
    const fromB = await roundTrip(sharedB, 'sub-b');
    expect(fromA).toEqual([JSON.stringify(['EOSE', 'sub-a'])]);
    expect(fromB).toEqual([JSON.stringify(['EOSE', 'sub-b'])]);
    expect(a.relay.opens).toHaveLength(1); // one connection per relay for the computer
    expect(b.relay.opens).toHaveLength(0);
    expect(a.link.stats()?.clients).toBe(2);
  });

  it('removes a stale socket (no answer) after the checks, then binds', async () => {
    const home = tempHome();
    const dir = join(home, '.agentlink', RELAY_RUN_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const other = join(dir, 'other.sock');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(other, resolve));
    linkSync(other, socketPath(home));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(lstatSync(socketPath(home)).isSocket()).toBe(true);
    const a = makeLink(home, token());
    expect(await a.link.start()).toBe('winner');
    const probe = await rawClient(socketPath(home));
    expect(probe.closed()).toBe(false);
  });

  it('the winner exits: a new winner within 2 s, and the other client reconnects to it', async () => {
    const home = tempHome();
    const t = token();
    const a = makeLink(home, t);
    const b = makeLink(home, t);
    const c = makeLink(home, t);
    expect(await a.link.start()).toBe('winner');
    expect(await b.link.start()).toBe('client');
    expect(await c.link.start()).toBe('client');
    const connB = b.link.connector();
    const connC = c.link.connector();
    await roundTrip(connB, 'b1');
    await roundTrip(connC, 'c1');
    await a.link.close(); // the winner's program exits
    const elapsed = await waitFor(
      () => b.link.role === 'winner' || c.link.role === 'winner',
      2_000,
    );
    expect(elapsed).toBeLessThan(2_000);
    const winner = b.link.role === 'winner' ? b : c;
    const loser = winner === b ? c : b;
    await waitFor(() => loser.link.role === 'client');
    await roundTrip(winner === b ? connB : connC, 'w2');
    await roundTrip(winner === b ? connC : connB, 'l2');
    expect(winner.relay.opens).toHaveLength(1);
    expect(loser.relay.opens).toHaveLength(0);
    expect(winner.link.stats()?.clients).toBe(2);
  });

  it('hand-over: the host asks the winner to yield, binds without delay, the old winner becomes a client', async () => {
    const home = tempHome();
    const t = token();
    const mcp = makeLink(home, t);
    const host = makeLink(home, t);
    expect(await mcp.link.start()).toBe('winner');
    expect(await host.link.requestYield()).toBe(true);
    expect(await host.link.start()).toBe('winner');
    await waitFor(() => mcp.link.role === 'client');
    await roundTrip(mcp.link.connector(), 'm');
    expect(host.relay.opens).toHaveLength(1);
    expect(mcp.relay.opens).toHaveLength(0);
  });

  it('the winner can yield on its own (L4 API): it stops accepting, closes its clients and unbinds', async () => {
    const home = tempHome();
    const t = token();
    const a = makeLink(home, t);
    const b = makeLink(home, t);
    expect(await a.link.start()).toBe('winner');
    expect(await b.link.start()).toBe('client');
    expect(await a.link.yieldLink()).toBe(true);
    expect(a.link.role).not.toBe('winner');
    await waitFor(() => a.link.role === 'winner' || b.link.role === 'winner');
  });

  it('status for doctor: on, role and the number of programs, from the winner or a client', async () => {
    const home = tempHome();
    const t = token();
    const a = makeLink(home, t);
    const b = makeLink(home, t);
    await a.link.start();
    await b.link.start();
    await roundTrip(a.link.connector(), 'a');
    await roundTrip(b.link.connector(), 'b');
    expect(await a.link.status()).toEqual({ on: true, role: 'winner', programs: 2 });
    expect(await b.link.status()).toEqual({ on: true, role: 'client', programs: 2 });
  });
});

describe.runIf(POSIX)('channel authentication (token proof both ways)', () => {
  it('a wrong proof closes the channel; the frame after it is never read', async () => {
    const home = tempHome();
    const a = makeLink(home, token());
    await a.link.start();
    const client = await rawClient(socketPath(home));
    client.socket.write(
      linkFrameBytes(encodeLinkFrame({ t: 'hello', v: 1, cli: CLI, nonce: '11'.repeat(32) })),
    );
    await waitFor(() => client.frames.length === 1);
    const challenge = decodeServerFrame(client.frames[0]);
    expect(challenge.ok && challenge.frame.t).toBe('challenge');
    const wrong = linkFrameBytes(encodeLinkFrame({ t: 'prove', proof: '00'.repeat(32) }));
    const after = linkFrameBytes(encodeLinkFrame({ t: 'open', link: 1, url: RELAY }));
    client.socket.write(Buffer.concat([wrong, after]));
    await waitFor(() => client.closed());
    expect(a.relay.opens).toHaveLength(0);
    expect(a.link.stats()).toMatchObject({ rejectedHandshakes: 1, clients: 0 });
    expect(a.link.stats()?.dropped).toEqual({
      too_large: 0,
      malformed: 0,
      unknown: 0,
      unrouted: 0,
    });
  });

  it('a missing proof (a relay frame first) closes the channel before any relay frame is read', async () => {
    const home = tempHome();
    const a = makeLink(home, token());
    await a.link.start();
    const client = await rawClient(socketPath(home));
    client.socket.write(linkFrameBytes(encodeLinkFrame({ t: 'open', link: 1, url: RELAY })));
    await waitFor(() => client.closed());
    expect(a.relay.opens).toHaveLength(0);
  });

  it('a program with another token is refused and uses its own connection', async () => {
    const home = tempHome();
    const a = makeLink(home, token());
    const b = makeLink(home, token());
    await a.link.start();
    expect(await b.link.start()).toBe('client');
    const conn = new FallbackConnector(b.link.connector(), b.relay.connector);
    await roundTrip(conn, 'x');
    expect(b.relay.opens).toHaveLength(1);
    expect(a.relay.opens).toHaveLength(0);
  });

  it('a frame over the size limit, or too many bytes before the proof, closes the channel', async () => {
    const home = tempHome();
    const a = makeLink(home, token());
    await a.link.start();
    const big = await rawClient(socketPath(home));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(SHARED_LINK_MAX_FRAME_BYTES + 1);
    big.socket.write(header);
    await waitFor(() => big.closed());
    const chatty = await rawClient(socketPath(home));
    const junk = Buffer.alloc(8 * 1024, 0x20);
    const frame = Buffer.alloc(4);
    frame.writeUInt32BE(junk.length);
    chatty.socket.write(Buffer.concat([frame, junk]));
    await waitFor(() => chatty.closed());
    expect(a.relay.opens).toHaveLength(0);
  });
});

describe.runIf(POSIX)('endpoint checks refuse the link and the program uses its own pool', () => {
  it('a run folder that is not 0700', async () => {
    const home = tempHome();
    const dir = join(home, '.agentlink', RELAY_RUN_DIR);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const a = makeLink(home, token());
    expect(await a.link.start()).toBe('unavailable');
    const conn = new FallbackConnector(a.link.connector(), a.relay.connector);
    await roundTrip(conn, 'x');
    expect(a.relay.opens).toHaveLength(1); // direct
  });

  it('a symlink in place of the socket', async () => {
    const home = tempHome();
    const dir = join(home, '.agentlink', RELAY_RUN_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    symlinkSync(join(home, 'nowhere.sock'), socketPath(home));
    const a = makeLink(home, token());
    expect(await a.link.start()).toBe('unavailable');
    expect(lstatSync(socketPath(home)).isSymbolicLink()).toBe(true); // never removed
  });

  it('a socket owned by another user (simulated stat) is never connected to', async () => {
    const home = tempHome();
    const t = token();
    const a = makeLink(home, t);
    expect(await a.link.start()).toBe('winner');
    const foreign = async (path: string): Promise<Stats> => {
      const info = await lstat(path);
      if (path === socketPath(home)) {
        return Object.assign(Object.create(Object.getPrototypeOf(info) as object) as Stats, info, {
          uid: (info.uid + 1) % 65_536,
        });
      }
      return info;
    };
    const b = makeLink(home, t, { lstat: foreign });
    expect(await b.link.start()).toBe('unavailable');
    const conn = new FallbackConnector(b.link.connector(), b.relay.connector);
    await roundTrip(conn, 'x');
    expect(b.relay.opens).toHaveLength(1);
    expect(a.link.stats()?.clients).toBe(0);
  });

  it('a run folder owned by another user (simulated uid) is refused', async () => {
    const home = tempHome();
    const a = makeLink(home, token(), { uid: () => (process.getuid?.() ?? 0) + 1 });
    expect(await a.link.start()).toBe('unavailable');
  });

  it('losing races do not spin: an unusable endpoint is not re-checked on every dial', async () => {
    const home = tempHome();
    const dir = join(home, '.agentlink', RELAY_RUN_DIR);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    let stats = 0;
    const counting = (path: string): Promise<Stats> => {
      stats += 1;
      return lstat(path);
    };
    const a = makeLink(home, token(), { lstat: counting });
    expect(await a.link.start()).toBe('unavailable');
    const before = stats;
    for (let i = 0; i < 50; i += 1) {
      expect(() => a.link.dial({ onFrame: () => undefined, onClose: () => undefined })).toThrow();
    }
    expect(stats).toBe(before);
  });
});

describe.runIf(POSIX)('logging (I-7)', () => {
  it('no token, frame, subscription id, relay URL or path appears in any log line', async () => {
    const home = tempHome();
    const t = token();
    const log = captureLogger();
    const a = makeLink(home, t, { logger: log.logger });
    const b = makeLink(home, t, { logger: log.logger });
    const c = makeLink(home, token(), { logger: log.logger }); // wrong token
    await a.link.start();
    await b.link.start();
    await c.link.start();
    await roundTrip(b.link.connector(), 'secret-sub-id');
    await roundTrip(new FallbackConnector(c.link.connector(), c.relay.connector), 'other-sub');
    await a.link.close();
    await waitFor(() => b.link.role === 'winner' || c.link.role === 'winner');
    const text = log.lines.join('\n');
    expect(log.lines.length).toBeGreaterThan(0);
    for (const secret of [
      hex(t),
      'secret-sub-id',
      'other-sub',
      'relay.example.com',
      home,
      'EOSE',
      'REQ',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('off switch (D-159 (11))', () => {
  it('reads AGENTLINK_SHARED_RELAYS: off by default in 0.5.18, 1 turns it on, 0 off', () => {
    expect(SHARED_RELAYS_ENV).toBe('AGENTLINK_SHARED_RELAYS');
    expect(SHARED_RELAYS_DEFAULT).toBe(false);
    expect(sharedRelaysEnabled({})).toBe(false);
    expect(sharedRelaysEnabled({ AGENTLINK_SHARED_RELAYS: '1' })).toBe(true);
    expect(sharedRelaysEnabled({ AGENTLINK_SHARED_RELAYS: 'on' })).toBe(true);
    expect(sharedRelaysEnabled({ AGENTLINK_SHARED_RELAYS: '0' })).toBe(false);
    expect(sharedRelaysEnabled({ AGENTLINK_SHARED_RELAYS: 'off' })).toBe(false);
    expect(sharedRelaysEnabled({ AGENTLINK_SHARED_RELAYS: 'bogus' })).toBe(false);
  });

  it('createRelayConnector: the direct connector when off; shared with direct fallback when on', async () => {
    const home = tempHome();
    const relay = fakeRelay();
    const off = await createRelayConnectorWith({
      home,
      cliVersion: CLI,
      env: {},
      direct: relay.connector,
      addressCheck,
    });
    expect(off.connector).toBe(relay.connector);
    expect(off.link).toBeUndefined();
    const on = await createRelayConnectorWith({
      home,
      cliVersion: CLI,
      env: { AGENTLINK_SHARED_RELAYS: '1' },
      direct: relay.connector,
      addressCheck,
    });
    expect(on.connector).toBeInstanceOf(FallbackConnector);
    expect(on.link).toBeInstanceOf(SharedRelayLink);
    if (on.link !== undefined) links.push(on.link);
    await roundTrip(on.connector, 'x');
    expect(relay.opens).toHaveLength(1);
  });
});

describe.runIf(process.platform === 'win32')(
  'Windows named pipe (token proof is the guard)',
  () => {
    it('two programs share one upstream through the pipe', async () => {
      const home = tempHome();
      const t = token();
      const a = makeLink(home, t);
      const b = makeLink(home, t);
      expect(await a.link.start()).toBe('winner');
      expect(await b.link.start()).toBe('client');
      await roundTrip(a.link.connector(), 'a');
      await roundTrip(b.link.connector(), 'b');
      expect(a.relay.opens).toHaveLength(1);
      expect(b.relay.opens).toHaveLength(0);
    });

    it('a program without the token is refused and uses its own connection', async () => {
      const home = tempHome();
      const a = makeLink(home, token());
      const b = makeLink(home, token());
      await a.link.start();
      await b.link.start();
      await roundTrip(new FallbackConnector(b.link.connector(), b.relay.connector), 'x');
      expect(b.relay.opens).toHaveLength(1);
      expect(a.relay.opens).toHaveLength(0);
    });

    it('a wrong proof on the pipe closes the channel', async () => {
      const home = tempHome();
      const a = makeLink(home, token());
      await a.link.start();
      const endpoint = resolveEndpoint(home, { platform: 'win32' });
      const client = await rawClient(endpoint?.path as string);
      client.socket.write(linkFrameBytes(encodeLinkFrame({ t: 'open', link: 1, url: RELAY })));
      await waitFor(() => client.closed());
      expect(a.relay.opens).toHaveLength(0);
    });
  },
);

// RELAY-SHARED-CONN fix round (D-159 build decisions 8 to 11; 04 §4 "Local relay link").
describe.runIf(POSIX)('shared link hardening (Unix socket)', () => {
  it('a hung endpoint: after one stalled handshake, further sockets and checks go direct at once', async () => {
    const home = tempHome();
    const dir = join(home, '.agentlink', RELAY_RUN_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const accepted: Socket[] = [];
    const hung = createServer((socket) => accepted.push(socket)); // accepts, never answers
    await new Promise<void>((resolve) => hung.listen(socketPath(home), resolve));
    try {
      const b = makeLink(home, token());
      expect(await b.link.start()).toBe('client');
      const first = new FallbackConnector(b.link.newConnector(), b.relay.connector);
      await roundTrip(first, 'stall-1'); // waits out one handshake, then direct
      const t0 = Date.now();
      const second = new FallbackConnector(b.link.newConnector(), b.relay.connector);
      await roundTrip(second, 'stall-2');
      expect(Date.now() - t0).toBeLessThan(500);
      const t1 = Date.now();
      expect(await b.link.newConnector().checkServed(RELAY, 'aa'.repeat(32))).toBe('unavailable');
      expect(Date.now() - t1).toBeLessThan(500);
      expect(b.link.role).toBe('unavailable');
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => hung.close(() => resolve()));
    }
  }, 10_000);

  it('a socket that refused once is probed again after a short delay before it is removed', async () => {
    const home = tempHome();
    const dir = join(home, '.agentlink', RELAY_RUN_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // A live program holds the endpoint, but the first probe sees a refusal (it was restarting).
    const live = makeLink(home, token());
    expect(await live.link.start()).toBe('winner');
    let probes = 0;
    const b = makeLink(home, token(), {
      probeEndpoint: async (path, real) => {
        probes += 1;
        return probes === 1 ? 'refused' : real(path);
      },
    });
    expect(await b.link.start()).toBe('client');
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(lstatSync(socketPath(home)).isSocket()).toBe(true);
    expect(live.link.role).toBe('winner');
    const probe = await rawClient(socketPath(home));
    expect(probe.closed()).toBe(false);
  });

  it('the bound socket is mode 0600', async () => {
    const home = tempHome();
    const a = makeLink(home, token());
    expect(await a.link.start()).toBe('winner');
    expect(statSync(socketPath(home)).mode & 0o777).toBe(0o600);
  });

  it('winner and client report the same count: ID clients only, no server-test connectors', async () => {
    const home = tempHome();
    const t = token();
    const a = makeLink(home, t);
    const b = makeLink(home, t);
    await a.link.start();
    await b.link.start();
    await roundTrip(a.link.connector(), 'a');
    await roundTrip(b.link.connector(), 'b');
    const test = b.link.newConnector(() => false, { transient: true });
    await test.checkServed(RELAY, 'aa'.repeat(32));
    const unproved = await rawClient(socketPath(home)); // connected, never proves
    expect(unproved.closed()).toBe(false);
    expect(await a.link.status()).toEqual({ on: true, role: 'winner', programs: 2 });
    expect(await b.link.status()).toEqual({ on: true, role: 'client', programs: 2 });
    test.close();
  });
});

// SHARED-LINK-HARDEN (0.5.19; D-159 build decisions 12 to 14; 04 §4 "Local relay link").
describe.runIf(POSIX)('shared link hardening, 0.5.19', () => {
  it('a winner that opens more IDs at once than the pre-proof cap shares every one of them', async () => {
    const home = tempHome();
    const a = makeLink(home, token());
    expect(await a.link.start()).toBe('winner');
    const connectors = Array.from(
      { length: 12 },
      () => new FallbackConnector(a.link.newConnector(), a.relay.connector),
    );
    await Promise.all(connectors.map((conn, i) => roundTrip(conn, `id-${i}`)));
    expect(a.relay.opens).toHaveLength(1); // one shared upstream, none direct
    expect(a.link.stats()?.ids).toBe(12);
  });

  it('a refused program re-elects on a timer and rejoins a healthy link after the winner restarts', async () => {
    const home = tempHome();
    const fileToken = await ensureLinkToken(home);
    if (fileToken === undefined) throw new Error('link token unavailable');
    const scheduled: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const timers = {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const entry = { fn, ms, cleared: false };
        scheduled.push(entry);
        return entry;
      },
      clearTimeout: (handle: unknown): void => {
        (handle as { cleared: boolean }).cleared = true;
      },
    };
    const old = makeLink(home, token()); // a winner this program cannot prove the token to
    expect(await old.link.start()).toBe('winner');
    const b = makeLink(home, fileToken, { reprobeTimers: timers });
    expect(await b.link.start()).toBe('client');
    const conn = new FallbackConnector(b.link.connector(), b.relay.connector);
    await roundTrip(conn, 'refused');
    expect(b.relay.opens).toHaveLength(1); // direct
    await waitFor(() => scheduled.some((e) => !e.cleared));
    const pending = scheduled.filter((e) => !e.cleared);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.ms).toBeGreaterThanOrEqual(SHARED_LINK_REPROBE_MS);
    expect(pending[0]?.ms).toBeLessThan(SHARED_LINK_REPROBE_MS * 1.5);
    await old.link.close(); // the winner exits; this program holds no channel and sees nothing
    const healthy = makeLink(home, fileToken);
    expect(await healthy.link.start()).toBe('winner');
    expect(b.link.role).toBe('client');
    pending[0]?.fn(); // the re-probe time comes
    await waitFor(() => b.link.role === 'client');
    await roundTrip(conn, 'rejoined');
    expect(healthy.relay.opens).toHaveLength(1); // b's traffic now rides the healthy link
    expect(b.relay.opens).toHaveLength(1);
    expect(healthy.link.stats()?.ids).toBe(1);
    // Ready again: no further re-probe is pending.
    expect(scheduled.filter((e) => !e.cleared && e !== pending[0])).toHaveLength(0);
  });

  it('a failed chmod on the socket is logged with a fixed code and no path', async () => {
    const home = tempHome();
    const { lines, logger } = captureLogger();
    const a = makeLink(home, token(), {
      logger,
      chmod: () => Promise.reject(new Error(`EPERM: chmod ${socketPath(home)}`)),
    });
    const role = await a.link.start();
    expect(lines.filter((l) => l.includes('"reason":"socket_mode"')).length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(home);
      expect(line).not.toContain('EPERM');
    }
    // Held only when the socket is private anyway (the mode check decides).
    if (role === 'winner') expect(statSync(socketPath(home)).mode & 0o077).toBe(0);
    else expect(role).toBe('unavailable');
  });

  it('the socket check refuses a socket with group or other permission', async () => {
    const home = tempHome();
    const a = makeLink(home, token());
    expect(await a.link.start()).toBe('winner');
    const withMode =
      (mode: number) =>
      async (path: string): Promise<Stats> => {
        const info = await lstat(path);
        return Object.assign(Object.create(Object.getPrototypeOf(info) as object) as Stats, info, {
          mode: (info.mode & ~0o777) | mode,
        });
      };
    const strict = { privateMode: true };
    expect(await checkSocket(socketPath(home), withMode(0o600), undefined, strict)).toBe('ok');
    expect(await checkSocket(socketPath(home), withMode(0o660), undefined, strict)).toBe('unsafe');
    expect(await checkSocket(socketPath(home), withMode(0o606), undefined, strict)).toBe('unsafe');
    // A program whose own socket is not private after the bind does not hold the link.
    await a.link.close();
    const b = makeLink(home, token(), {
      lstat: (path) => (path === socketPath(home) ? withMode(0o666)(path) : lstat(path)),
    });
    expect(await b.link.start()).toBe('unavailable');
    expect(b.link.stats()).toBeUndefined();
  });
});
