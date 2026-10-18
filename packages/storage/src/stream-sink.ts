// M1-6b part 2: where decrypted bytes go while a download is still provisional (04 §4, D-80).
//
// An ALF1 opener releases each chunk's plaintext as soon as that chunk authenticates, before the
// final chunk is seen; a truncated or extended object fails only at the end. So the output is
// provisional until the whole file verifies, and a consumer never commits it before then:
// decryptDownload (stream-download.ts) calls `commit` only after the final chunk and both hashes
// verified, and `discard` on any failure.
//
// createTempFileSink is that rule for files: write to a temporary file in the target folder, rename
// it to the final name on success, remove it on failure. The file system is injected (TempFileOps),
// because this package runs in Workers as well and never imports Node built-ins; the Node binding
// lives with the consumer (@agentlink/node), which also applies the allowed-folder and realpath
// rules of 04 §4 to the folder and sanitises the final name (createInboxFile) before it gets here.
import { encodeHex, randomBytes } from '@agentlink/crypto';
import { StorageError } from './errors.js';

/** A destination for provisional plaintext. */
export interface ProvisionalSink {
  /**
   * Takes the next piece. The caller wipes `chunk` once the promise resolves, so the sink copies or
   * finishes with it before then.
   */
  write(chunk: Uint8Array): Promise<void>;
  /** The whole file verified: make the output final. Called at most once, after every write. */
  commit(): Promise<void>;
  /** Something failed: remove every trace of the output. Called at most once; must not throw. */
  discard(): Promise<void>;
}

/** An open file. */
export interface TempFileHandle {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * The file operations the sink needs, on names inside one folder the caller chose and checked.
 * - `create` makes a new file exclusively (never overwrites, never follows a symbolic link);
 * - `rename` never overwrites an existing file;
 * - `remove` succeeds when the file is already gone.
 */
export interface TempFileOps {
  create(name: string): Promise<TempFileHandle>;
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** The temporary name: hidden and random, so it never clashes with or looks like a final file. */
function tempName(): string {
  return `.agentlink-partial-${encodeHex(randomBytes(16))}`;
}

/**
 * Creates the temporary file now (so even an empty file goes through it) and returns a sink that
 * renames it to `finalName` on commit and removes it on discard or on any failed write, close or
 * rename. `finalName` is a plain name the consumer already sanitised; it is never logged.
 */
export async function createTempFileSink(
  ops: TempFileOps,
  finalName: string,
): Promise<ProvisionalSink> {
  if (
    ops === null ||
    typeof ops !== 'object' ||
    typeof ops.create !== 'function' ||
    typeof ops.rename !== 'function' ||
    typeof ops.remove !== 'function'
  ) {
    throw new StorageError('invalid_argument', 'missing file operations');
  }
  if (typeof finalName !== 'string' || finalName.length === 0) {
    throw new StorageError('invalid_argument', 'missing file name');
  }
  const temp = tempName();
  const handle = await ops.create(temp);
  let state: 'open' | 'closed' | 'done' = 'open';

  const cleanup = async (): Promise<void> => {
    if (state === 'done') return;
    const wasOpen = state === 'open';
    state = 'done';
    if (wasOpen) await handle.close().catch(() => undefined);
    await ops.remove(temp).catch(() => undefined);
  };

  return {
    async write(chunk) {
      if (state !== 'open') throw new StorageError('invalid_argument', 'the file is closed');
      try {
        await handle.write(chunk);
      } catch {
        await cleanup();
        throw new StorageError('download_failed', 'the file could not be written');
      }
    },
    async commit() {
      if (state !== 'open') throw new StorageError('invalid_argument', 'the file is closed');
      try {
        state = 'closed';
        await handle.close();
        await ops.rename(temp, finalName);
        state = 'done';
      } catch {
        await cleanup();
        throw new StorageError('download_failed', 'the file could not be saved');
      }
    },
    discard: cleanup,
  };
}
