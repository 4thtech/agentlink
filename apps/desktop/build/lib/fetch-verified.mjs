// Plain HTTPS fetch + SHA-256 check (no @electron/get). The committed hash is the trust anchor;
// the host list only narrows where we ask. A mismatch deletes the file and throws.
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sha256FileHex } from './hash.mjs';

/** SHA-256 of a file (streamed) as lowercase hex, through @4thtech-io/crypto. */
export const sha256File = sha256FileHex;

function checkUrl(u, allowedHosts, what) {
  if (u.protocol !== 'https:') throw new Error(`Refusing ${what} ${u.protocol}: https only.`);
  if (!allowedHosts.includes(u.hostname)) throw new Error(`Refusing ${what} host ${u.hostname}.`);
}

/** Follows redirects by hand so every hop is checked against the https + host allowlist. */
async function getChecked(url, allowedHosts, fetchImpl, signal) {
  let current = new URL(url);
  for (let hop = 0; hop <= 5; hop++) {
    checkUrl(current, allowedHosts, hop === 0 ? 'download from' : 'redirect to');
    const res = await fetchImpl(current.href, { redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`Redirect without a location (HTTP ${res.status}).`);
      current = new URL(loc, current);
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects.');
}

export async function fetchVerified({
  url,
  sha256,
  dest,
  allowedHosts,
  fetchImpl = fetch,
  maxBytes = 300 * 1024 * 1024,
  timeoutMs = 10 * 60 * 1000,
}) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('A 64-character SHA-256 is required.');
  const u = new URL(url);
  checkUrl(u, allowedHosts, 'download from');

  if (existsSync(dest)) {
    if ((await sha256File(dest)) === sha256) return dest;
    await rm(dest, { force: true });
  }
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  await rm(part, { force: true });

  const signal = AbortSignal.timeout(timeoutMs);
  const res = await getChecked(url, allowedHosts, fetchImpl, signal);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}.`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`Download too large (${declared} bytes).`);
  try {
    let seen = 0;
    const cap = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > maxBytes) cb(new Error(`Download exceeded ${maxBytes} bytes.`));
        else cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), cap, createWriteStream(part, { mode: 0o600 }), {
      signal,
    });
    const got = await sha256File(part);
    if (got !== sha256) {
      throw new Error(
        `SHA-256 mismatch for ${u.pathname.split('/').pop()}: expected ${sha256}, got ${got}.`,
      );
    }
    await rename(part, dest);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
  return dest;
}
