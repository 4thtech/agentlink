// M1-13c: an in-memory encrypted drop (D-48) for the deterministic e2e layer. It speaks the drop's
// HTTP protocol as the storage adapter uses it (07 §5.4; packages/storage drop.ts): a signed
// `POST /v1/upload` grant, a single `PUT /v1/put/<id>/0` of the ciphertext, a signed
// `POST /v1/o/<id>/commit` that checks the SHA-256 the sender reports, and a signed-URL
// `GET /v1/get/<id>` for the recipient. It is a fake of the service, not of the client: the agents run
// their real drop adapter against it, and request signatures are required to be present (the real
// Worker's own signature checks are covered by apps/drop/test).
//
// It records what it saw, for the zero-access audit (I-1, I-2, I-7): `seen` holds the method, the
// path (never the query, which carries the signed-URL token) and the body as bytes, and `objects`
// holds the stored ciphertext. Nothing here logs or prints.
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { TextDecoder } from 'node:util';

const { Response } = globalThis;

export const FAKE_DROP_ORIGIN = 'https://drop.agentlink.4thtech.io';

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * @param {{ origin?: string, now?: () => number }} [options]
 */
export function createFakeDrop(options = {}) {
  const origin = options.origin ?? FAKE_DROP_ORIGIN;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  /** @type {Map<string, { bytes: Uint8Array | undefined, committed: boolean, expiresAt: number }>} */
  const objects = new Map();
  /** @type {{ method: string, path: string, body: Uint8Array }[]} */
  const seen = [];

  const signedUrl = (path, expiresAt) =>
    `${origin}${path}?e=${String(expiresAt)}&m=${b64url(randomBytes(32))}`;

  /** The drop's side of the adapter's `fetch`. */
  async function fetchDrop(request) {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.clone().arrayBuffer());
    seen.push({ method: request.method, path: url.pathname, body });
    if (url.origin !== origin) return json(404, { error: 'not_found' });
    const path = url.pathname;

    if (request.method === 'POST' && path === '/v1/upload') {
      if (!(request.headers.get('authorization') ?? '').startsWith('Nostr ')) {
        return json(401, { error: 'unauthorized' });
      }
      const grant = JSON.parse(new TextDecoder().decode(body));
      const objectId = b64url(randomBytes(16));
      objects.set(objectId, { bytes: undefined, committed: false, expiresAt: grant.expiresAt });
      return json(201, {
        objectId,
        uploadUrl: signedUrl(`/v1/put/${objectId}/0`, now() + 900),
        expiresAt: grant.expiresAt,
        uploadExpiresAt: now() + 900,
      });
    }
    const put = /^\/v1\/put\/([A-Za-z0-9_-]{22})\/0$/.exec(path);
    if (request.method === 'PUT' && put !== null) {
      const object = objects.get(put[1]);
      if (object === undefined) return json(404, { error: 'not_found' });
      object.bytes = body;
      return json(201, { part: 0, size: body.length });
    }
    const commit = /^\/v1\/o\/([A-Za-z0-9_-]{22})\/commit$/.exec(path);
    if (request.method === 'POST' && commit !== null) {
      if (!(request.headers.get('authorization') ?? '').startsWith('Nostr ')) {
        return json(401, { error: 'unauthorized' });
      }
      const object = objects.get(commit[1]);
      if (object?.bytes === undefined) return json(404, { error: 'not_found' });
      const reported = JSON.parse(new TextDecoder().decode(body)).ciphertextSha256;
      if (createHash('sha256').update(object.bytes).digest('hex') !== reported) {
        return json(422, { error: 'hash_mismatch' });
      }
      object.committed = true;
      return json(200, {
        getUrl: signedUrl(`/v1/get/${commit[1]}`, object.expiresAt),
        expiresAt: object.expiresAt,
      });
    }
    const del = /^\/v1\/o\/([A-Za-z0-9_-]{22})$/.exec(path);
    if (request.method === 'DELETE' && del !== null) {
      objects.delete(del[1]);
      return new Response(null, { status: 204 });
    }
    return json(404, { error: 'not_found' });
  }

  /** The recipient's download of a signed GET URL, read to the byte cap (FilesPlatform.download). */
  const download = (url) => async (maxBytes, onChunk) => {
    const parsed = new URL(url);
    const match = /^\/v1\/get\/([A-Za-z0-9_-]{22})$/.exec(parsed.pathname);
    const object = match === null ? undefined : objects.get(match[1]);
    if (parsed.origin !== origin || object?.bytes === undefined || !object.committed) {
      throw new Error('download failed');
    }
    seen.push({ method: 'GET', path: parsed.pathname, body: new Uint8Array(0) });
    const chunk = 64 * 1024;
    let total = 0;
    for (let at = 0; at < object.bytes.length; at += chunk) {
      const piece = object.bytes.subarray(at, at + chunk);
      total += piece.length;
      await onChunk(piece);
      if (total > maxBytes) break;
    }
  };

  return { origin, fetch: fetchDrop, download, objects, seen };
}
