// Test-only: an in-memory folder behind the TempFileOps seam of stream-sink.ts (M1-6b part 2), and a
// sink that only hashes. The package runs in Workers too and may not import Node built-ins, even in
// tests (tools/deps-check); the Node binding of TempFileOps belongs to the consumer in
// @agentlink/node. This fake keeps the same rules a real one must: create is exclusive, rename never
// overwrites, and a write after close fails.
import { createSha256, encodeHex } from '@agentlink/crypto';
import type { ProvisionalSink, TempFileHandle, TempFileOps } from './index.js';

export interface FakeFolder {
  readonly ops: TempFileOps;
  /** Files by name, with their bytes so far. */
  readonly files: Map<string, Uint8Array[]>;
  /** Names created, in order. */
  readonly created: string[];
  /** Fails the next `rename` when set. */
  failRename: boolean;
  /** Fails the `write` with this index (0-based, across all files) when set. */
  failWriteAt: number | undefined;
  /** The bytes of one file, joined. */
  read(name: string): Uint8Array | undefined;
}

export function fakeFolder(): FakeFolder {
  let writes = 0;
  const folder: FakeFolder = {
    files: new Map(),
    created: [],
    failRename: false,
    failWriteAt: undefined,
    read(name) {
      const parts = folder.files.get(name);
      if (parts === undefined) return undefined;
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    },
    ops: {
      async create(name: string): Promise<TempFileHandle> {
        if (folder.files.has(name)) throw new Error('exists');
        folder.files.set(name, []);
        folder.created.push(name);
        let closed = false;
        return {
          async write(chunk: Uint8Array) {
            if (closed) throw new Error('closed');
            if (folder.failWriteAt !== undefined && writes === folder.failWriteAt) {
              writes += 1;
              throw new Error('disk full');
            }
            writes += 1;
            // A copy: the caller wipes its buffer once the write resolves.
            folder.files.get(name)?.push(chunk.slice());
          },
          async close() {
            closed = true;
          },
        };
      },
      async rename(from: string, to: string) {
        if (folder.failRename) throw new Error('rename failed');
        if (folder.files.has(to)) throw new Error('exists');
        const parts = folder.files.get(from);
        if (parts === undefined) throw new Error('missing');
        folder.files.delete(from);
        folder.files.set(to, parts);
      },
      async remove(name: string) {
        folder.files.delete(name);
      },
    },
  };
  return folder;
}

/** A sink that hashes and counts what it is given; it records whether it was committed or discarded. */
export function hashingSink(): ProvisionalSink & {
  readonly state: () => 'open' | 'committed' | 'discarded';
  readonly size: () => number;
  readonly sha256: () => string;
} {
  const hasher = createSha256();
  let size = 0;
  let state: 'open' | 'committed' | 'discarded' = 'open';
  let digest: string | undefined;
  return {
    async write(chunk) {
      hasher.update(chunk);
      size += chunk.length;
    },
    async commit() {
      state = 'committed';
    },
    async discard() {
      state = 'discarded';
    },
    state: () => state,
    size: () => size,
    sha256: () => (digest ??= encodeHex(hasher.digest())),
  };
}
