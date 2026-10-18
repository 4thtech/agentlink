// M1-11a test seam: the local approval UI harness shared by the server tests and the Chromium e2e.
// Not part of the build (tsconfig.json excludes *.fixture.ts).
//
// - FileKeychain: the OS keychain stand-in (one JSON file), holding a real owner item set up with
//   `initOwnerWith`, so every decision is a real owner signature from the real owner store.
// - fakeSource: core's approval read and `ownerActions.apply` for these tests. It verifies the owner
//   signature, the agent, each approval ID and action digest against its pending rows (both
//   `approval.decide` and `approval.decideBatch`, whole or nothing, nonce burnt), and refuses a
//   commitment inside a batch, like core (04 §2.5.2).
// - send: a raw HTTP request, so a test controls Host, Origin and every other header.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TAGS,
  bip340Verify,
  canonicalizeToBytes,
  decodeBase64url,
  decodeHex,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  sha256,
  taggedHash,
  type JsonObject,
  type JsonValue,
  type OwnerPublicKeys,
} from '@agentlink/crypto';
import type { OwnerActionOutcome } from '@agentlink/core';
import type { ApprovalForDecision, ApprovalServerSource } from './approval-server.js';
import { createKeychainAgent } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { initOwnerWith } from './owner-init.js';
import type { OwnerTerminal } from './owner-terminal.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

/** The OS keychain stand-in: one JSON file, readable and writable by the same user. */
export class FileKeychain implements KeychainBackend {
  constructor(readonly file: string) {}
  #read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  get(account: string): Promise<Uint8Array | null> {
    const value = this.#read()[account];
    return Promise.resolve(value === undefined ? null : decodeBase64url(value));
  }
  set(account: string, value: Uint8Array): Promise<void> {
    writeFileSync(this.file, JSON.stringify({ ...this.#read(), [account]: encodeBase64url(value) }));
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    const items = this.#read();
    const had = account in items;
    Reflect.deleteProperty(items, account);
    writeFileSync(this.file, JSON.stringify(items));
    return Promise.resolve(had);
  }
}

export interface OwnerWorld {
  readonly root: string;
  readonly keychain: FileKeychain;
  readonly agentId: string;
  readonly owner: OwnerPublicKeys;
  /** The owner code shown once at setup. */
  readonly code: string;
  cleanup(): void;
}

/** A temp directory, a file keychain, one agent and one owner (real owner store, low KDF cost). */
export async function ownerWorld(prefix: string): Promise<OwnerWorld> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const keychain = new FileKeychain(join(root, 'keychain-stand-in.json'));
  const agentId = await createKeychainAgent(keychain);
  const written: string[] = [];
  const setup: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: () =>
      Promise.resolve(
        encodeUtf8((written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(-4)),
      ),
    confirm: () => Promise.resolve(true),
    clearScreen: () => undefined,
  };
  const { owner } = await initOwnerWith(
    keychain,
    setup,
    { backend: 'keychain', env: {} },
    { kdf: KDF },
  );
  const code = (written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(
    'Your owner code: '.length,
  );
  return {
    root,
    keychain,
    agentId,
    owner,
    code,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const approvalId = (n: number): string => `apr_${String.fromCharCode(65 + n).repeat(22)}`;
export const digestOf = (action: JsonValue): string =>
  encodeHex(sha256(canonicalizeToBytes(action)));

export function ownerSigValid(owner: OwnerPublicKeys, body: JsonObject, sig: string): boolean {
  try {
    const digest = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(body)));
    return bip340Verify(owner.ownerNostr, digest, decodeHex(sig, { length: 64 }));
  } catch {
    return false;
  }
}

export interface FakeSource extends ApprovalServerSource {
  readonly applied: { body: JsonObject; sig: string }[];
  readonly calls: { apply: number; get: number };
  /** Adds (or replaces) pending request `n`. */
  add(n: number, extra?: Partial<ApprovalForDecision>): ApprovalForDecision;
  /** Removes request `n` (decided elsewhere). */
  remove(n: number): void;
  /** Whether request `n` is still pending. */
  pending(n: number): boolean;
}

interface Item {
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly decision: string;
}

export function fakeSource(world: Pick<OwnerWorld, 'agentId' | 'owner'>): FakeSource {
  const rows = new Map<string, ApprovalForDecision>();
  const nonces = new Set<string>();
  const applied: { body: JsonObject; sig: string }[] = [];
  const calls = { apply: 0, get: 0 };
  const refused = (op: string, reason: string, items?: string[]): OwnerActionOutcome =>
    ({
      status: 'refused',
      op,
      reason,
      nonceBurnt: true,
      ...(items === undefined
        ? {}
        : { items: items.map((id) => ({ approvalId: id, reason: 'approval_unknown' })) }),
    }) as never;
  return {
    applied,
    calls,
    add(n, extra = {}) {
      const action = { tool: 'agentlink_send', to: `contact-${String(n)}`, text: 'hello' };
      const row: ApprovalForDecision = {
        approvalId: approvalId(n),
        summary: `Send a message to Contact ${String(n)}`,
        actionDigest: digestOf(action),
        storedDigest: digestOf(action),
        action,
        expiresAt: Math.floor(Date.now() / 1000) + 3_600 + n,
        commitment: false,
        ...extra,
      };
      rows.set(row.approvalId, row);
      return row;
    },
    remove(n) {
      rows.delete(approvalId(n));
    },
    pending(n) {
      return rows.has(approvalId(n));
    },
    context: () => Promise.resolve({ agent: world.agentId, owner: world.owner }),
    list: () =>
      Promise.resolve(
        [...rows.values()].map(
          ({ approvalId: id, summary, actionDigest, expiresAt, commitment, details }) => ({
            approvalId: id,
            summary,
            actionDigest,
            expiresAt,
            commitment,
            ...(details === undefined ? {} : { details }),
          }),
        ),
      ),
    get: (id) => {
      calls.get += 1;
      return Promise.resolve(rows.get(id));
    },
    apply: (signed) => {
      calls.apply += 1;
      const body = signed.body;
      const op = String(body['op']);
      if (!ownerSigValid(world.owner, body, signed.sig)) {
        return Promise.resolve(refused(op, 'signature_invalid'));
      }
      if (body['agent'] !== world.agentId) return Promise.resolve(refused(op, 'agent_mismatch'));
      const nonce = String(body['nonce']);
      if (nonces.has(nonce)) return Promise.resolve(refused(op, 'nonce_used'));
      nonces.add(nonce);
      const params = body['params'] as Record<string, unknown>;
      const items: Item[] =
        op === 'approval.decideBatch'
          ? (params['items'] as Item[])
          : op === 'approval.decide'
            ? [params as unknown as Item]
            : [];
      if (items.length === 0) return Promise.resolve(refused(op, 'op_unknown'));
      const bad = items
        .filter((i) => {
          const row = rows.get(i.approvalId);
          return (
            row === undefined ||
            row.storedDigest !== i.actionDigest ||
            (op === 'approval.decideBatch' && row.commitment)
          );
        })
        .map((i) => i.approvalId);
      if (bad.length > 0) return Promise.resolve(refused(op, 'items_refused', bad));
      for (const i of items) rows.delete(i.approvalId);
      applied.push(signed);
      return Promise.resolve({ status: 'applied', op } as OwnerActionOutcome);
    },
  };
}

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A raw HTTP request to 127.0.0.1, so the test controls Host, Origin and every other header. */
export function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { Host: `localhost:${String(port)}`, ...options.headers },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
