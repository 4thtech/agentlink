// Test helpers for files (M1-7f). Not part of the build (tsconfig.json excludes src/testing).
//
// - openFileAgent: an AgentLinkClient with a relay spy, a policy mark and a files platform, so two
//   agents can send a file and fetch it in one process.
// - MemoryInbox: the inbox folder's TempFileOps in memory, with the semantics @4thtech-io/node gives
//   them (exclusive create that never follows a link, rename that never overwrites); a planted
//   symbolic link is an entry that refuses both.
// - MemoryOwnStorage: an S3-like StorageAdapter in memory whose presigned URL carries a secret, and
//   whose download can be tampered with or truncated.
import {
  encodeHex,
  randomBytes,
  sha256,
  type EnvelopeKeys,
  type JsonObject,
  type KeyStore,
  type NostrEvent,
} from '@4thtech-io/crypto';
import { createLogger } from '@4thtech-io/log';
import {
  type CiphertextSource,
  type PutOptions,
  type StorageAdapter,
  type StoredObject,
  type TempFileHandle,
  type TempFileOps,
} from '@4thtech-io/storage';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
import { unwrapGiftWrap, wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { AgentLinkClient } from '../client.js';
import type { FilesPlatform, InboxFolder, OutgoingFile } from '../files/platform.js';
import type { ProofsPlatform } from '../proofs/platform.js';
import { MemoryStore } from '../store/memory-store.js';
import type { TransportFactory } from '../transport.js';
import { FakeClock, RecordingApprovalChannel, TestStoreCipher, passphrase } from './fixtures.js';
import { pairWith, type TestOwner } from './envelopes.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from './owner.js';

export const WORK = '/home/u/Work';
export const INBOX = '/home/u/AgentLink/Inbox';

/** Records every publish and acks every relay. */
export class PublishSpy {
  readonly published: { event: NostrEvent; relays: string[] }[] = [];
  readonly factory: TransportFactory = (deps) => ({
    wrap: (envelope, recipients, keys) =>
      wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
    publish: (event, relays) => {
      this.published.push({ event, relays: [...relays] });
      return Promise.resolve({
        results: relays.map((relay) => ({ relay, ok: true, reason: 'ok' as const })),
        acked: [...relays],
        sent: relays.length >= 2,
      } as PublishOutcome);
    },
  });
}

interface Entry {
  kind: 'file' | 'symlink';
  data: Uint8Array;
  mode: number;
}

/** The inbox folder in memory (see the header). */
export class MemoryInbox implements TempFileOps {
  readonly entries = new Map<string, Entry>();
  /** Every name ever created, in order (the quarantine names included). */
  readonly created: string[] = [];
  /** Every write, as the name it went to. */
  readonly writes: string[] = [];

  plantSymlink(name: string): void {
    this.entries.set(name, { kind: 'symlink', data: new Uint8Array(0), mode: 0o777 });
  }

  create(name: string): Promise<TempFileHandle> {
    if (this.entries.has(name)) return Promise.reject(new Error('EEXIST'));
    const entry: Entry = { kind: 'file', data: new Uint8Array(0), mode: 0o600 };
    this.entries.set(name, entry);
    this.created.push(name);
    let closed = false;
    return Promise.resolve({
      write: (chunk: Uint8Array) => {
        if (closed) return Promise.reject(new Error('closed'));
        const next = new Uint8Array(entry.data.length + chunk.length);
        next.set(entry.data);
        next.set(chunk, entry.data.length);
        entry.data = next;
        this.writes.push(name);
        return Promise.resolve();
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });
  }

  rename(from: string, to: string): Promise<void> {
    const entry = this.entries.get(from);
    if (entry === undefined) return Promise.reject(new Error('ENOENT'));
    if (this.entries.has(to)) return Promise.reject(new Error('EEXIST'));
    this.entries.delete(from);
    this.entries.set(to, entry);
    return Promise.resolve();
  }

  remove(name: string): Promise<void> {
    this.entries.delete(name);
    return Promise.resolve();
  }

  list(): Promise<readonly string[]> {
    return Promise.resolve([...this.entries.keys()]);
  }

  /** Visible regular files (no quarantine names, no links). */
  files(): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const [name, e] of this.entries) {
      if (e.kind === 'file' && !name.startsWith('.')) out.set(name, e.data);
    }
    return out;
  }
}

/** Own storage in memory: presigned URLs carry a secret; downloads can be altered. */
export class MemoryOwnStorage implements StorageAdapter {
  readonly kind = 's3' as const;
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  readonly urls: string[] = [];
  alter: 'none' | 'flip' | 'truncate' | 'extend' = 'none';

  async put(
    ciphertext: ReadableStream<Uint8Array> | Uint8Array,
    opts: PutOptions,
  ): Promise<StoredObject> {
    const chunks: Uint8Array[] = [];
    if (ciphertext instanceof Uint8Array) chunks.push(ciphertext.slice());
    else {
      const reader = ciphertext.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value.slice());
      }
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      bytes.set(c, o);
      o += c.length;
    }
    if (bytes.length !== opts.size) throw new Error('size mismatch');
    const key = encodeHex(randomBytes(16));
    this.objects.set(key, bytes);
    return { kind: 's3', locator: key, size: bytes.length, sha256: encodeHex(sha256(bytes)) };
  }

  presignGet(obj: StoredObject): Promise<string> {
    const url = `https://storage.example.com/o/${obj.locator}?X-Amz-Signature=${encodeHex(randomBytes(32))}`;
    this.urls.push(url);
    return Promise.resolve(url);
  }

  delete(obj: StoredObject): Promise<void> {
    this.deleted.push(obj.locator);
    this.objects.delete(obj.locator);
    return Promise.resolve();
  }

  /** The download side, keyed by the presigned URL. */
  download(url: string): CiphertextSource {
    const key = /\/o\/([0-9a-f]{32})\?/.exec(url)?.[1] ?? '';
    const stored = this.objects.get(key);
    return async (maxBytes, onChunk) => {
      if (stored === undefined) throw new Error('404');
      let bytes = stored.slice();
      if (this.alter === 'flip') bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 1;
      if (this.alter === 'truncate') bytes = bytes.slice(0, bytes.length - 16);
      if (this.alter === 'extend') {
        const longer = new Uint8Array(bytes.length + 64);
        longer.set(bytes);
        bytes = longer;
      }
      for (let i = 0; i < bytes.length; i += 64 * 1024) {
        await onChunk(bytes.slice(i, Math.min(bytes.length, i + 64 * 1024, maxBytes + 1)));
        if (i + 64 * 1024 > maxBytes) break;
      }
    };
  }
}

export interface FileAgent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly cipher: TestStoreCipher;
  readonly keyStore: KeyStore;
  readonly owner: TestOwner;
  readonly id: string;
  readonly spy: PublishSpy;
  readonly inbox: MemoryInbox;
  readonly lines: string[];
  readonly platform: FilesPlatform;
}

export interface FileAgentOptions {
  readonly own?: MemoryOwnStorage;
  /** Any other own-storage adapter, such as the broken stub (M1-9i-a); `own` wins when both are set. */
  readonly ownAdapter?: StorageAdapter;
  readonly drop?: FilesPlatform['drop'];
  readonly download?: FilesPlatform['download'];
  readonly relays: readonly string[];
  /** The proofs platform (M1-7g), for the delete-on-receipt tests (M1-1g-h). */
  readonly proofs?: ProofsPlatform;
}

/** An agent with a files platform whose allowed folder is WORK and whose inbox is INBOX. */
export async function openFileAgent(
  clock: FakeClock,
  keyStore: KeyStore,
  owner: TestOwner,
  name: string,
  options: FileAgentOptions,
): Promise<FileAgent> {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const spy = new PublishSpy();
  const inbox = new MemoryInbox();
  const lines: string[] = [];
  const own = options.own;
  const platform: FilesPlatform = {
    flavor: 'posix',
    allowedFolderRealpaths: () => Promise.resolve([WORK]),
    ...(own !== undefined
      ? { ownStorage: own }
      : options.ownAdapter === undefined
        ? {}
        : { ownStorage: options.ownAdapter }),
    ...(options.drop === undefined ? {} : { drop: options.drop }),
    download:
      options.download ??
      ((url: string) => {
        if (own === undefined) throw new Error('no download');
        return own.download(url);
      }),
    inbox: (): Promise<InboxFolder> => Promise.resolve({ realpath: INBOX, ops: inbox }),
  };
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: spy.factory,
    policyMark: new MemoryPolicyMark(),
    files: platform,
    ...(options.proofs === undefined ? {} : { proofs: options.proofs }),
    logger: createLogger({
      name: 'core',
      level: 'debug',
      sink: (_l, line) => lines.push(line),
    }),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: options.relays,
  });
  return {
    client,
    store,
    cipher,
    keyStore,
    owner,
    id: client.agentId,
    spy,
    inbox,
    lines,
    platform,
  };
}

/** Pairs both ways, then gives the sender a signed policy that allows WORK. */
export async function pairForFiles(
  clock: FakeClock,
  a: FileAgent,
  b: FileAgent,
  edit: (p: Policy) => void = () => {},
): Promise<void> {
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
  for (const agent of [a, b]) {
    const policy = defaultPolicy();
    policy.files.allowedFolders = ['~/Work'];
    edit(policy);
    const signed = await signWith(agent.owner, {
      v: 1,
      agent: agent.id,
      owner: await ownerHex(agent.owner),
      op: 'policy.set',
      params: { version: 1, policy: policy as unknown as JsonObject },
      nonce: newNonce(),
      issuedAt: clock.t,
      expiresAt: clock.t + 600,
    });
    const applied = await agent.client.ownerActions.apply(JSON.stringify(signed));
    if (applied.status !== 'applied') throw new Error('policy not applied');
  }
}

/** Delivers the latest envelope `from` published to `to`'s agent key, and processes it. */
export async function deliver(from: FileAgent, to: FileAgent): Promise<void> {
  const key = encodeHex((await to.keyStore.getPublicBundle()).agentNostr);
  const wrap = [...from.spy.published]
    .reverse()
    .find((p) => p.event.tags.some((t) => t[0] === 'p' && t[1] === key));
  if (wrap === undefined) throw new Error('nothing published to that agent');
  const opened = await unwrapGiftWrap(wrap.event, to.keyStore as EnvelopeKeys);
  await to.client.envelopes.receive({ envelope: opened.envelope, giftWrapId: opened.giftWrapId });
  const reports = await to.client.envelopes.processReceived();
  // The step syncInbox runs after processing (07 §2.1 step 4; M1-7g): a `proof` envelope is
  // checked on-chain and DELIVERED is signed per policy. A no-op without a proofs platform.
  await to.client.proofs.processInbound(reports);
}

/** Deterministic bytes of a given length with a recognisable marker at the start. */
export function fileBytes(size: number, marker = 'PLAINTEXT-MARKER-7f'): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + 7) & 0xff;
  const m = new TextEncoder().encode(marker);
  out.set(m.subarray(0, Math.min(m.length, size)));
  return out;
}

/** An OutgoingFile under WORK, read from memory. */
export function outgoing(
  name: string,
  bytes: Uint8Array,
  extra: Partial<Pick<OutgoingFile, 'mime' | 'name'>> = {},
): OutgoingFile {
  return {
    realpath: `${WORK}/${name}`,
    size: bytes.length,
    ...extra,
    open: () => Promise.resolve(bytes.slice()),
  };
}
