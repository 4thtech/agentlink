// SHA-256 for the build tooling (asset and tree hashes, the ASAR integrity digest), through
// @4thtech-io/crypto like every other hash in the repository (AGENTS.md: all crypto goes through
// @4thtech-io/crypto; deps-check refuses node:crypto). Output is lowercase hex, as before.
import { createSha256, encodeHex, sha256 } from '@4thtech-io/crypto';
import { createReadStream } from 'node:fs';

const bytesOf = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

/** SHA-256 of `data` (bytes, or a string as UTF-8) as raw bytes. */
export function sha256Bytes(data) {
  return sha256(bytesOf(data));
}

/** SHA-256 of `data` (bytes, or a string as UTF-8) as lowercase hex. */
export function sha256Hex(data) {
  return encodeHex(sha256Bytes(data));
}

/** An incremental SHA-256: update(bytes | string) ..., then digest() (bytes). */
export function sha256Stream() {
  const h = createSha256();
  const hasher = {
    update(data) {
      h.update(bytesOf(data));
      return hasher;
    },
    digest: () => h.digest(),
  };
  return hasher;
}

/** SHA-256 of a file, read as a stream, as lowercase hex. */
export async function sha256FileHex(path) {
  const h = createSha256();
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return encodeHex(h.digest());
}
