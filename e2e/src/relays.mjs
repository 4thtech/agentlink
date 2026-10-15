// M1-13a: local Nostr relays for the e2e scenario. Each relay is a strfry container (the image the
// M1-5b-b Docker suite pins, packages/node/src/relay-docker.test.ts), listening in plain WebSocket on
// 127.0.0.1 only. The agents' cards name public-looking wss:// URLs (the relay URL rule of 04 §4
// refuses local names); the e2e connector (local-connector.mjs) maps each host to its local port.
//
// Nothing here prints: callers record what they need. Containers carry one label per run, so
// `stopRelays` removes every container of the run, also after a failed start.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** dockurr/strfry 1.1.3 (multi-arch index), pinned by digest, as in relay-docker.test.ts. */
export const STRFRY_IMAGE =
  'dockurr/strfry@sha256:599ab3500dbfbe6cb78c668e1892cd9802c192d066df4660e8e3175034a8344d';

/** The relay host names the agents' cards use (four relays: agent A on 1 and 2, agent B on 3 and 4). */
export const RELAY_HOSTS = Object.freeze([
  'relay-1.nostr-test.dev',
  'relay-2.nostr-test.dev',
  'relay-3.nostr-test.dev',
  'relay-4.nostr-test.dev',
]);

const STRFRY_CONFIG = `db = "/app/strfry-db/"
relay {
    bind = "0.0.0.0"
    port = 7777
    nofiles = 0
    info {
        name = "agentlink e2e relay"
    }
}
`;

const docker = async (...args) =>
  (
    await execFileAsync('docker', args, { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })
  ).stdout.trim();

function nip11Ready(port) {
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

async function waitReady(port) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await nip11Ready(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('a local relay did not become ready');
}

/**
 * Starts one strfry container per host in RELAY_HOSTS. Returns `{ label, map }`, where `map` is
 * `{ [host]: port }` for the e2e connector (pass it as AGENTLINK_E2E_RELAYS).
 */
export async function startRelays() {
  const label = `agentlink-e2e=${process.pid}-${Date.now()}`;
  const dir = await mkdtemp(join(tmpdir(), 'agentlink-e2e-relays-'));
  const configFile = join(dir, 'strfry.conf');
  await writeFile(configFile, STRFRY_CONFIG, { mode: 0o644 });
  /** @type {Record<string, number>} */
  const map = {};
  try {
    for (const host of RELAY_HOSTS) {
      const container = await docker(
        'create',
        '--label',
        label,
        '-p',
        '127.0.0.1::7777',
        STRFRY_IMAGE,
        'sh',
        '-c',
        'mkdir -p /app/strfry-db && exec /app/strfry --config=/etc/strfry.conf relay',
      );
      await docker('cp', configFile, `${container}:/etc/strfry.conf`);
      await docker('start', container);
      const mapped = await docker('port', container, '7777/tcp');
      const port = Number(/:(\d+)\s*$/m.exec(mapped.split('\n')[0] ?? '')?.[1]);
      if (!Number.isInteger(port)) throw new Error('a local relay has no mapped port');
      await waitReady(port);
      map[host] = port;
    }
  } catch (error) {
    await stopRelays(label);
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { label, map };
}

/** Removes every container of the run. Never throws. */
export async function stopRelays(label) {
  try {
    const ids = await docker('ps', '-aq', '--filter', `label=${label}`);
    if (ids !== '') await docker('rm', '-f', ...ids.split(/\s+/));
  } catch {
    // Best effort: the runner is ephemeral.
  }
}

/**
 * Every event a relay holds (one REQ with an empty filter, until EOSE), as raw JSON text per event.
 * Used by the relay audit: what left the agents' machines, as the relay operator sees it.
 */
export function dumpRelay(port) {
  return new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const done = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(events);
    };
    const timer = setTimeout(done, 15_000);
    ws.addEventListener('open', () => ws.send(JSON.stringify(['REQ', 'dump', {}])));
    ws.addEventListener('message', (message) => {
      const text = typeof message.data === 'string' ? message.data : '';
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (frame[0] === 'EVENT' && frame[1] === 'dump') events.push(JSON.stringify(frame[2]));
      if (frame[0] === 'EOSE' || frame[0] === 'CLOSED') done();
    });
    ws.addEventListener('error', done);
  });
}
