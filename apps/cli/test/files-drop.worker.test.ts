// M1-9d-1: the file tools end to end through the CLI's MCP server, between two real cores, with the
// real drop Worker (apps/drop, M1-27a) under Miniflare (workerd) and no own storage (D-48; 06 §2.3,
// §9). A small file travels inline (D-85), a larger one through the encrypted drop; the recipient's
// `agentlink_fetch_file` saves both into its inbox folder (D-84). Every tool result and log line of
// the run is scanned for the drop's URLs, its host and the file keys (IR-D48-1 F15f).
//
// The handlers, `coreToolClient` and the MCP server are the production modules (runtime-agnostic,
// 06 §1); the platform half (the allowed-folder check, the inbox folder) is an in-memory double
// here, and the Node one is tested in files-mcp.test.ts and src/runtime/files.test.ts.
import { SELF } from 'cloudflare:test';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import type { FilesPlatform, InboxFolder } from '@4thtech-io/core';
import type { FetchLike, TempFileHandle, TempFileOps } from '@4thtech-io/storage';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  coreToolClient,
  type AttachOutcome,
  type FileOpener,
} from '@4thtech-io/mcp-tools/context.js';
import {
  RelayNetwork,
  call,
  connect,
  fileBytes,
  logLines,
  makeAgent,
  pair,
  presence,
  results,
  setPolicy,
  toolContext,
  type Agent,
} from './files-harness.js';

const ORIGIN = 'https://drop.test';
const WORK = '/home/u/Work';
const INBOX = '/home/u/AgentLink/Inbox';
const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const now = (): number => Math.floor(Date.now() / 1000);

/** Every request that reached the drop, as the drop saw it. */
const seen: string[] = [];

let ip = 0;
function dropFetch(): FetchLike {
  ip += 1;
  const addr = `203.0.113.${String(ip)}`;
  return async (request) => {
    const body = new Uint8Array(await request.clone().arrayBuffer());
    seen.push(request.url);
    const headers = new Headers(request.headers);
    headers.set('cf-connecting-ip', addr);
    const response = await SELF.fetch(
      new Request(request.url, {
        method: request.method,
        headers,
        ...(request.method === 'GET' ? {} : { body }),
        redirect: 'manual',
      }),
    );
    // The drop's answers carry the signed upload and GET URLs: they are secrets too.
    const text = await response.clone().text();
    for (const url of text.match(/https:\/\/[^"\s]+/g) ?? []) seen.push(url);
    return response;
  };
}

/** The inbox folder in memory, with the semantics @4thtech-io/node gives it. */
class MemoryInbox implements TempFileOps {
  readonly entries = new Map<string, Uint8Array>();
  create(name: string): Promise<TempFileHandle> {
    if (this.entries.has(name)) return Promise.reject(new Error('EEXIST'));
    this.entries.set(name, new Uint8Array(0));
    return Promise.resolve({
      write: (chunk: Uint8Array) => {
        const old = this.entries.get(name) ?? new Uint8Array(0);
        const next = new Uint8Array(old.length + chunk.length);
        next.set(old);
        next.set(chunk, old.length);
        this.entries.set(name, next);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    });
  }
  rename(from: string, to: string): Promise<void> {
    const data = this.entries.get(from);
    if (data === undefined) return Promise.reject(new Error('ENOENT'));
    if (this.entries.has(to)) return Promise.reject(new Error('EEXIST'));
    this.entries.delete(from);
    this.entries.set(to, data);
    return Promise.resolve();
  }
  remove(name: string): Promise<void> {
    this.entries.delete(name);
    return Promise.resolve();
  }
  list(): Promise<readonly string[]> {
    return Promise.resolve([...this.entries.keys()]);
  }
}

/** The allowed-folder check in memory: files under WORK only; counts every open. */
class MemoryOpener implements FileOpener {
  readonly files = new Map<string, Uint8Array>();
  opens = 0;
  attach(path: string, allowedFolders: readonly string[]): Promise<AttachOutcome> {
    if (allowedFolders.length === 0) return Promise.resolve({ ok: false, reason: 'no_folder' });
    if (!path.startsWith(`${WORK}/`) || path.includes('/../')) {
      return Promise.resolve({ ok: false, reason: 'outside_folder' });
    }
    const bytes = this.files.get(path);
    if (bytes === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
    const name = path.slice(path.lastIndexOf('/') + 1);
    return Promise.resolve({
      ok: true,
      file: {
        name,
        size: bytes.length,
        file: {
          realpath: path,
          size: bytes.length,
          open: () => {
            this.opens += 1;
            return Promise.resolve(bytes.slice());
          },
        },
        plaintextSha256: () => Promise.resolve(encodeHex(sha256(bytes))),
      },
    });
  }
}

function platform(inbox: MemoryInbox, download: boolean): FilesPlatform {
  return {
    flavor: 'posix',
    allowedFolderRealpaths: () => Promise.resolve([WORK]),
    drop: { endpoint: ORIGIN, fetch: dropFetch() },
    download: (url: string) => async (maxBytes, onChunk) => {
      if (!download) throw new Error('no download');
      const response = await SELF.fetch(new Request(url, { redirect: 'manual' }));
      if (response.status !== 200 || response.body === null) throw new Error('download failed');
      const reader = response.body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        await onChunk(value);
        if (total > maxBytes) break;
      }
    },
    inbox: (): Promise<InboxFolder> => Promise.resolve({ realpath: INBOX, ops: inbox }),
  };
}

const SMALL = fileBytes(3_000, 'SMALL-INLINE-9d1');
// The smallest size class that still forces the drop: well above the 12 255-byte inline limit
// (06 §2.3, D-85). A 2 MiB file took 23.6 s on CI run 39188866293 (3.4 s locally) and timed out.
const BIG = fileBytes(64 * 1024 + 17, 'BIG-DROP-9d1');

/**
 * Per-test timeout for the drop round trips. Measured: under 1 s locally with BIG at 64 KiB; the
 * 2 MiB version needed 23.6 s on CI run 39188866293, about 7 times its local time, so 60 s leaves
 * a wide margin for a loaded runner without hiding a hang.
 */
const DROP_TEST_TIMEOUT_MS = 60_000;

let alice: Agent;
let bob: Agent;
let aliceMcp: Client;
let bobMcp: Client;
const aliceOpener = new MemoryOpener();
const bobInbox = new MemoryInbox();

beforeAll(async () => {
  const net = new RelayNetwork();
  alice = await makeAgent({
    keyStore: new MemoryKeyStore(seed(91)),
    owner: new MemoryOwnerKeyStore(seed(191), presence()),
    declaredName: 'Alice',
    relays: ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
    net,
    clock: now,
    files: platform(new MemoryInbox(), false),
    dropOrigins: [ORIGIN],
  });
  bob = await makeAgent({
    keyStore: new MemoryKeyStore(seed(92)),
    owner: new MemoryOwnerKeyStore(seed(192), presence()),
    declaredName: 'Bob',
    relays: ['wss://one.relay-beta.net', 'wss://two.relay-beta.net'],
    net,
    clock: now,
    files: platform(bobInbox, true),
    dropOrigins: [ORIGIN],
  });
  await setPolicy(bob, () => {});
  await pair(alice, bob);
  await setPolicy(alice, (p) => {
    p.files.allowedFolders = [WORK];
  });
  aliceOpener.files.set(`${WORK}/notes.txt`, SMALL);
  aliceOpener.files.set(`${WORK}/report.bin`, BIG);
  aliceMcp = await connect(
    toolContext(coreToolClient(alice.client, { files: aliceOpener }), 'alice'),
  );
  bobMcp = await connect(
    toolContext(coreToolClient(bob.client, { files: new MemoryOpener() }), 'bob'),
  );
});

interface Sent {
  readonly envelopeId: string;
}

/** Bob's inbox shows the message with this delivery; bob saves the file and gets exact bytes. */
async function receive(
  sent: Sent,
  delivery: string,
  bytes: Uint8Array,
  name: string,
): Promise<void> {
  const inbox = await call(bobMcp, 'agentlink_inbox', {});
  const messages = inbox.structured['messages'] as {
    envelopeId: string;
    files: { delivery: string }[];
  }[];
  const message = messages.find((m) => m.envelopeId === sent.envelopeId);
  expect(message?.files.map((f) => f.delivery)).toEqual([delivery]);
  const fetched = await call(bobMcp, 'agentlink_fetch_file', { envelopeId: sent.envelopeId });
  expect(fetched.structured).toMatchObject({
    status: 'ok',
    savedTo: `${INBOX}/${name}`,
    name,
    size: bytes.length,
    integrity: 'verified',
  });
  // The file name is the sender's text: only inside the untrusted block, never the summary.
  expect(fetched.structured['summary']).not.toContain(name);
  expect(fetched.text).toContain('<untrusted_content');
  expect(bobInbox.entries.get(name)).toEqual(bytes);
}

describe('agentlink_send with path and agentlink_fetch_file through the encrypted drop', () => {
  it(
    'a small file goes inline; bob saves it into his inbox',
    async () => {
      const opens = aliceOpener.opens;
      const small = await call(aliceMcp, 'agentlink_send', {
        to: 'Bob',
        text: 'the notes',
        path: `${WORK}/notes.txt`,
      });
      expect(small.structured).toMatchObject({
        status: 'ok',
        file: {
          name: 'notes.txt',
          size: SMALL.length,
          plaintextSha256: encodeHex(sha256(SMALL)),
          delivery: 'inline',
          expiresAt: null,
        },
      });
      expect(aliceOpener.opens).toBe(opens + 1);
      await receive(small.structured as unknown as Sent, 'inline', SMALL, 'notes.txt');
    },
    DROP_TEST_TIMEOUT_MS,
  );

  it(
    'a file above the inline limit goes through the drop; bob saves it into his inbox',
    async () => {
      const opens = aliceOpener.opens;
      const before = seen.length;
      const big = await call(aliceMcp, 'agentlink_send', {
        to: 'Bob',
        path: `${WORK}/report.bin`,
      });
      expect(big.structured).toMatchObject({
        status: 'ok',
        file: {
          name: 'report.bin',
          size: BIG.length,
          plaintextSha256: encodeHex(sha256(BIG)),
          delivery: 'drop',
        },
      });
      expect(typeof (big.structured['file'] as Record<string, unknown>)['expiresAt']).toBe(
        'string',
      );
      expect(aliceOpener.opens).toBe(opens + 1);
      expect(seen.length).toBeGreaterThan(before);
      await receive(big.structured as unknown as Sent, 'drop', BIG, 'report.bin');
    },
    DROP_TEST_TIMEOUT_MS,
  );

  it('no tool result or log line carries a drop URL, the drop host or a file key', async () => {
    const payloads = await bob.store.transaction((tx) =>
      tx.select('envelopes', { direction: 'in' }),
    );
    expect(payloads.length).toBeGreaterThan(0);
    const all = [...results, ...logLines].join('\n');
    expect(all).not.toContain('drop.test');
    for (const url of seen) expect(all).not.toContain(url);
    const hits = all.split('\n').filter((line) => /fileKey|ciphertextSha256|X-Amz-/i.test(line));
    expect(hits).toEqual([]);
  });
});
