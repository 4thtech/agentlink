// Plain HTTPS fetch + SHA-256 check (no @electron/get). The committed hash is the trust anchor;
// the host list only narrows where we ask. A mismatch deletes the file and throws.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function sha256File(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

export async function fetchVerified({ url, sha256, dest, allowedHosts, fetchImpl = fetch }) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('A 64-character SHA-256 is required.');
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`Refusing ${u.protocol} download: https only.`);
  if (!allowedHosts.includes(u.hostname))
    throw new Error(`Refusing download from host ${u.hostname}.`);

  if (existsSync(dest)) {
    if ((await sha256File(dest)) === sha256) return dest;
    await rm(dest, { force: true });
  }
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  await rm(part, { force: true });

  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}.`);
  if (res.url) {
    const f = new URL(res.url);
    if (f.protocol !== 'https:' || !allowedHosts.includes(f.hostname)) {
      throw new Error(`Refusing redirect to ${f.hostname}.`);
    }
  }
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part, { mode: 0o600 }));
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
