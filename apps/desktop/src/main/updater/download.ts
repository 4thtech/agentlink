// WP-D10: fetching the update document and the installer. Every URL and every redirect hop must pass
// the host allowlist (manifest.ts allowedDownloadUrl: https, no credentials or port, this
// repository's GitHub Releases or GitHub's release download hosts); redirects are followed by hand,
// at most MAX_REDIRECTS. Bodies are read with a byte cap. The installer goes into a fresh private
// temp folder (0700, file 0600) and is kept only if its size and SHA-256 equal the manifest's;
// otherwise it is deleted. No URL, header or body is ever logged or put into an error (I-7).
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSha256, encodeHex } from '@4thtech-io/crypto';
import { UpdateRefusal, allowedDownloadUrl, type UpdateAsset } from './manifest.js';

export const MAX_REDIRECTS = 5;
export const DOCUMENT_TIMEOUT_MS = 20_000;
export const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** The part of `fetch` used here (injected in tests). */
export type FetchLike = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

const fail = (): never => {
  throw new UpdateRefusal('download_failed');
};

/** GET with manual redirects; every hop checked against the allowlist. Returns a 200 response. */
export async function fetchAllowed(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = allowedDownloadUrl(url);
  if (current === undefined) throw new UpdateRefusal('wrong_host');
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current.href, {
        redirect: 'manual',
        signal,
        headers: { accept: 'application/octet-stream, application/json' },
      });
    } catch {
      return fail();
    }
    if (response.status === 200) return response;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (location === null) return fail();
      let next: string;
      try {
        next = new URL(location, current).href;
      } catch {
        return fail();
      }
      current = allowedDownloadUrl(next);
      if (current === undefined) throw new UpdateRefusal('wrong_host');
      continue;
    }
    await response.body?.cancel().catch(() => undefined);
    return fail();
  }
  return fail();
}

/** The body's chunks; the reader is released when the caller stops early. */
async function* chunks(response: Response): AsyncGenerator<Uint8Array> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The update document, at most `maxBytes` (checked while reading, and on Content-Length). */
export async function fetchDocument(
  url: string,
  maxBytes: number,
  fetchImpl: FetchLike,
): Promise<Uint8Array> {
  const response = await fetchAllowed(url, fetchImpl, DOCUMENT_TIMEOUT_MS);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpdateRefusal('oversize');
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of chunks(response)) {
      total += chunk.length;
      if (total > maxBytes) throw new UpdateRefusal('oversize');
      parts.push(chunk);
    }
  } catch (error) {
    if (error instanceof UpdateRefusal) throw error;
    return fail();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The SHA-256 (lowercase hex) and size of a file, read in full. */
export async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const handle = await open(path, 'r');
  try {
    const hasher = createSha256();
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = chunk as Buffer;
      hasher.update(bytes);
      size += bytes.length;
    }
    return { sha256: encodeHex(hasher.digest()), size };
  } finally {
    await handle.close();
  }
}

export interface DownloadedInstaller {
  readonly path: string;
  readonly dir: string;
}

/**
 * Downloads `asset` into a new private temp folder and checks it: more bytes than `size` stops the
 * download (`size_mismatch`), fewer or a different SHA-256 (`size_mismatch`, `hash_mismatch`) delete
 * the folder. The file name is the last segment of the manifest URL (already restricted to
 * [A-Za-z0-9._-]).
 */
export async function downloadInstaller(
  asset: UpdateAsset,
  fetchImpl: FetchLike,
  tempRoot: string = tmpdir(),
): Promise<DownloadedInstaller> {
  const name = asset.url.slice(asset.url.lastIndexOf('/') + 1);
  const dir = await mkdtemp(join(tempRoot, 'agentlink-update-'));
  const path = join(dir, name);
  try {
    const response = await fetchAllowed(asset.url, fetchImpl, DOWNLOAD_TIMEOUT_MS);
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) !== asset.size) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpdateRefusal('size_mismatch');
    }
    const hasher = createSha256();
    let size = 0;
    const file = await open(path, 'wx', 0o600);
    try {
      for await (const chunk of chunks(response)) {
        size += chunk.length;
        if (size > asset.size) throw new UpdateRefusal('size_mismatch');
        hasher.update(chunk);
        await file.write(chunk);
      }
    } catch (error) {
      if (error instanceof UpdateRefusal) throw error;
      return fail();
    } finally {
      await file.close();
    }
    if (size !== asset.size) throw new UpdateRefusal('size_mismatch');
    if (encodeHex(hasher.digest()) !== asset.sha256) throw new UpdateRefusal('hash_mismatch');
    return Object.freeze({ path, dir });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
