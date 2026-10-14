// Test servers for the Node relay connector tests (M1-5b-b). Not part of the build (tsconfig.json
// excludes *.fixture.ts). Everything listens on 127.0.0.1 with a throwaway certificate made by the
// `openssl` command line for this run only (no key is committed), so no test touches the network.
import { createGiftWrap, type NostrEvent } from '@agentlink/crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { WebSocketServer, type WebSocket } from 'ws';
import { KeychainKeyStore, createKeychainAgent } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';

/** The relay host name the test certificate is issued for (`.test` never resolves publicly). */
export const RELAY_HOST = 'relay.agentlink.test';

export interface TestCertificate {
  readonly cert: string;
  readonly key: string;
}

/** A self-signed certificate for `hosts` (SAN DNS names), valid for two days. */
export function makeTestCertificate(hosts: readonly string[] = [RELAY_HOST]): TestCertificate {
  const dir = mkdtempSync(join(tmpdir(), 'agentlink-relay-cert-'));
  try {
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '2',
        '-subj',
        `/CN=${hosts[0] ?? RELAY_HOST}`,
        '-addext',
        `subjectAltName=${hosts.map((h) => `DNS:${h}`).join(',')}`,
      ],
      { stdio: 'ignore' },
    );
    return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What a test server saw of one HTTP request (upgrade or plain). */
export interface SeenRequest {
  readonly kind: 'upgrade' | 'http';
  readonly servername: string | false;
  readonly host: string | undefined;
  readonly accept: string | undefined;
  readonly path: string | undefined;
  readonly remoteAddress: string | undefined;
  readonly extensions: string | undefined;
}

export interface TestRelayOptions {
  /** Plain HTTP requests (NIP-11). Default: 404. */
  readonly http?: (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * Upgrade requests. Return false to answer them yourself on the raw socket (a redirect, say);
   * default: accept the WebSocket.
   */
  readonly upgrade?: (req: IncomingMessage, socket: Socket) => boolean;
  /** Called for every accepted WebSocket. */
  readonly onSocket?: (ws: WebSocket) => void;
}

export interface TestRelay {
  readonly port: number;
  readonly seen: SeenRequest[];
  readonly sockets: WebSocket[];
  close(): Promise<void>;
}

function seenOf(kind: SeenRequest['kind'], req: IncomingMessage): SeenRequest {
  const socket = req.socket as TLSSocket;
  return {
    kind,
    servername: socket.servername ?? false,
    host: req.headers.host,
    accept: typeof req.headers.accept === 'string' ? req.headers.accept : undefined,
    path: req.url,
    remoteAddress: socket.remoteAddress,
    extensions:
      typeof req.headers['sec-websocket-extensions'] === 'string'
        ? req.headers['sec-websocket-extensions']
        : undefined,
  };
}

/** A test agent: a KeychainKeyStore over an in-memory keychain backend (no OS keychain). */
export async function makeTestAgent(): Promise<KeychainKeyStore> {
  const items = new Map<string, Uint8Array>();
  const backend: KeychainBackend = {
    get: (account) => {
      const value = items.get(account);
      return Promise.resolve(value === undefined ? null : Uint8Array.from(value));
    },
    set: (account, value) => {
      items.set(account, Uint8Array.from(value));
      return Promise.resolve();
    },
    delete: (account) => Promise.resolve(items.delete(account)),
  };
  const agentId = await createKeychainAgent(backend);
  return KeychainKeyStore.open(backend, agentId);
}

/** A validly signed kind 1059 gift wrap addressed to the agent itself, with `padding` filler. */
export async function makeSignedWrap(keys: KeychainKeyStore, padding = 0): Promise<NostrEvent> {
  const now = Math.floor(Date.now() / 1000);
  const seal = await keys.signNostr({
    kind: 13,
    created_at: now,
    tags: [],
    content: 'A'.repeat(16 + padding),
  });
  return createGiftWrap(seal, seal.pubkey, now - 60);
}

/** A TLS WebSocket and HTTPS server on 127.0.0.1 with `certificate`. */
export async function startTestRelay(
  certificate: TestCertificate,
  options: TestRelayOptions = {},
): Promise<TestRelay> {
  const seen: SeenRequest[] = [];
  const sockets: WebSocket[] = [];
  const server: HttpsServer = createHttpsServer({ cert: certificate.cert, key: certificate.key });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    seen.push(seenOf('http', req));
    if (options.http !== undefined) options.http(req, res);
    else res.writeHead(404).end();
  });
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    seen.push(seenOf('upgrade', req));
    if (options.upgrade !== undefined && !options.upgrade(req, socket)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      options.onSocket?.(ws);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    seen,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of sockets) ws.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A TCP listener that only counts connections: a stand-in proxy that must never be used. */
export async function startCountingListener(): Promise<{
  readonly port: number;
  connections(): number;
  close(): Promise<void>;
}> {
  let count = 0;
  const open = new Set<Socket>();
  const server: NetServer = createNetServer((socket) => {
    count += 1;
    open.add(socket);
    socket.on('close', () => open.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    connections: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
