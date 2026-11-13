import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchVerified } from '../lib/fetch-verified.mjs';

const body = Buffer.from('hello runtime');
// Fixed SHA-256 values (shasum -a 256), an oracle independent of the code under test.
const sha = '92030caf1e893211f66c1c043bf1fb8053e95e33ab97517b21ace0403babc483';
const okFetch = async () => new Response(body, { status: 200 });
const dir = () => mkdtempSync(join(tmpdir(), 'fv-'));
const base = { url: 'https://nodejs.org/x', allowedHosts: ['nodejs.org'] };

test('writes the file when the hash matches', async () => {
  const dest = join(dir(), 'a.zip');
  await fetchVerified({ ...base, sha256: sha, dest, fetchImpl: okFetch });
  assert.deepEqual(readFileSync(dest), body);
});

test('refuses and leaves nothing when the hash differs', async () => {
  const dest = join(dir(), 'a.zip');
  await assert.rejects(
    fetchVerified({ ...base, sha256: 'a'.repeat(64), dest, fetchImpl: okFetch }),
    /SHA-256/,
  );
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(dest + '.part'), false);
});

test('refuses http, a host off the list and a bad status', async () => {
  let calls = 0;
  const f = async () => (calls++, new Response(body));
  const dest = join(dir(), 'a.zip');
  await assert.rejects(
    fetchVerified({ ...base, url: 'http://nodejs.org/x', sha256: sha, dest, fetchImpl: f }),
    /https/,
  );
  await assert.rejects(
    fetchVerified({ ...base, url: 'https://evil.example/x', sha256: sha, dest, fetchImpl: f }),
    /host/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    fetchVerified({
      ...base,
      sha256: sha,
      dest,
      fetchImpl: async () => new Response('', { status: 404 }),
    }),
    /404/,
  );
});

test('every redirect hop is checked against https and the host list', async () => {
  const dest = join(dir(), 'a.zip');
  const hop = (location) => async () => new Response('', { status: 302, headers: { location } });
  await assert.rejects(
    fetchVerified({ ...base, sha256: sha, dest, fetchImpl: hop('https://evil.example/x') }),
    /redirect to host/,
  );
  await assert.rejects(
    fetchVerified({ ...base, sha256: sha, dest, fetchImpl: hop('http://nodejs.org/x') }),
    /redirect to http/,
  );
  let n = 0;
  const chain = async () =>
    n++ === 0
      ? new Response('', { status: 302, headers: { location: 'https://nodejs.org/y' } })
      : new Response(body);
  await fetchVerified({ ...base, sha256: sha, dest, fetchImpl: chain });
  assert.deepEqual(readFileSync(dest), body);
});

test('a download over the size cap is refused and leaves nothing', async () => {
  const dest = join(dir(), 'a.zip');
  await assert.rejects(
    fetchVerified({ ...base, sha256: sha, dest, maxBytes: 4, fetchImpl: okFetch }),
    /exceeded|too large/,
  );
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(dest + '.part'), false);
});

test('a cached file with the right hash is reused without fetching', async () => {
  const dest = join(dir(), 'a.zip');
  await fetchVerified({ ...base, sha256: sha, dest, fetchImpl: okFetch });
  let calls = 0;
  await fetchVerified({
    ...base,
    sha256: sha,
    dest,
    fetchImpl: async () => (calls++, new Response(body)),
  });
  assert.equal(calls, 0);
});

test('a cached file with the wrong hash is discarded and fetched again', async () => {
  const dest = join(dir(), 'a.zip');
  await fetchVerified({ ...base, sha256: sha, dest, fetchImpl: okFetch });
  const sha2 = 'd9298a10d1b0735837dc4bd85dac641b0f3cef27a47e5d53a54f2f3f5b2fcffa'; // 'other'
  await fetchVerified({
    ...base,
    sha256: sha2,
    dest,
    fetchImpl: async () => new Response('other'),
  });
  assert.equal(readFileSync(dest, 'utf8'), 'other');
});
