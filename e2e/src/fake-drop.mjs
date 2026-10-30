// M1-13c: an in-memory encrypted drop (D-48) for the deterministic e2e layer. It speaks the drop's
// HTTP protocol as the storage adapter uses it (07 §5.4; packages/storage drop.ts): a signed
// `POST /v1/upload` grant, a single `PUT /v1/put/<id>/0` of the ciphertext, a signed
// `POST /v1/o/<id>/commit` that checks the SHA-256 the sender reports, and a signed-URL
// `GET /v1/get/<id>` for the recipient. It is a fake of the service, not of the client: the agents run
// their real drop adapter against it, and request signatures are required to be present (the real
// Worker's own signature checks are covered by apps/drop/test).
//
// W4-SHORT-INVITE (D-139, 07 §5.4): it also holds short-invite objects: a signed `POST /v1/invite`
// (strict lookupId, the 17 441-byte cap, the `ALI1` v1 header, `conflict` for an existing ID), an
// unauthenticated `GET /v1/i/<lookupId>` (8 downloads, then the uniform 404 that unknown, expired and
// deleted objects also get), a `DELETE /v1/i/<lookupId>` that only the uploading drop key (the
// `pubkey` of the Authorization event; not verified, as above) may send, and the
// `POST /v1/report` `{v, lookupId, reason}` form. Objects are keyed by the 16 decoded bytes.
//
// It records what it saw, for the zero-access audit (I-1, I-2, I-7): `seen` holds the method, the
// path (never the query, which carries the signed-URL token) and the body as bytes, and `objects`
// holds the stored ciphertext; `invites` holds the stored invite objects. Nothing here logs or prints.
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { encodeHex, randomBytes, sha256 } from '@4thtech-io/crypto';
import { TextDecoder } from 'node:util';

const { Response } = globalThis;

export const FAKE_DROP_ORIGIN = 'https://drop.agentlink.4thtech.io';

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** 07 §5.4: 22 base64url characters with zero trailing bits; anything else is a 404, no lookup. */
const LOOKUP_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const INVITE_MAX = 17_441;
const INVITE_MIN = 17 + 16;
const INVITE_DOWNLOADS = 8;
const ALI1 = [0x41, 0x4c, 0x49, 0x31, 0x01];
const REASONS = ['malware', 'illegal', 'spam', 'other'];

/** The key of a strict lookupId (hex of its 16 bytes, never the string), or null. */
const inviteKey = (text) =>
  typeof text === 'string' && LOOKUP_ID.test(text)
    ? Buffer.from(text, 'base64url').toString('hex')
    : null;

/** The `pubkey` of the request's `Authorization: Nostr <base64url(event)>`, or null. */
function signer(request) {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Nostr ')) return null;
  try {
    const event = JSON.parse(Buffer.from(header.slice(6), 'base64url').toString('utf8'));
    return typeof event?.pubkey === 'string' ? event.pubkey : null;
  } catch {
    return null;
  }
}

/** The decoded `ALI1` object, 'size' above the cap, or null when malformed. */
function inviteObject(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const bytes = new Uint8Array(Buffer.from(text, 'base64url'));
  if (b64url(bytes) !== text) return null;
  if (bytes.length > INVITE_MAX) return 'size';
  if (bytes.length < INVITE_MIN || !ALI1.every((byte, i) => bytes[i] === byte)) return null;
  return bytes;
}
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const notFound = () => json(404, { error: 'not_found' });

function parseBody(body) {
  try {
    const value = JSON.parse(new TextDecoder().decode(body));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const hasExactly = (object, keys) =>
  Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));

/**
 * @param {{ origin?: string, now?: () => number }} [options]
 */
export function createFakeDrop(options = {}) {
  const origin = options.origin ?? FAKE_DROP_ORIGIN;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  /** @type {Map<string, { bytes: Uint8Array | undefined, committed: boolean, expiresAt: number }>} */
  const objects = new Map();
  /** @type {Map<string, { bytes: Uint8Array, owner: string, expiresAt: number, downloads: number }>} */
  const invites = new Map();
  /** @type {{ method: string, path: string, body: Uint8Array }[]} */
  const seen = [];

  /** The live invite object under `key`, or undefined (expired and used-up ones are forgotten). */
  const liveInvite = (key) => {
    const invite = key === null ? undefined : invites.get(key);
    if (invite === undefined) return undefined;
    if (now() >= invite.expiresAt || invite.downloads >= INVITE_DOWNLOADS) {
      invites.delete(key);
      return undefined;
    }
    return invite;
  };

  function handleInvite(request, path, body) {
    if (path === '/v1/invite') {
      if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
      const owner = signer(request);
      if (owner === null) return json(401, { error: 'unauthorized' });
      const input = parseBody(body);
      if (
        input === null ||
        !hasExactly(input, ['v', 'lookupId', 'expiresAt', 'object', 'nonce', 'ts']) ||
        input.v !== 1
      ) {
        return json(400, { error: 'bad_request' });
      }
      const key = inviteKey(input.lookupId);
      const { expiresAt } = input;
      if (
        key === null ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now() ||
        expiresAt > now() + 7 * 86_400
      ) {
        return json(400, { error: 'bad_request' });
      }
      const object = inviteObject(input.object);
      if (object === null) return json(400, { error: 'bad_request' });
      if (object === 'size') return json(413, { error: 'limit', limit: 'size' });
      if (liveInvite(key) !== undefined) return json(409, { error: 'conflict' });
      invites.set(key, { bytes: object, owner, expiresAt, downloads: 0 });
      return json(201, { expiresAt });
    }
    // path starts with /v1/i/
    const idText = path.slice('/v1/i/'.length);
    const key = inviteKey(idText);
    if (key === null) return notFound();
    if (request.method === 'GET') {
      const invite = liveInvite(key);
      if (invite === undefined) return notFound();
      invite.downloads += 1;
      return new Response(invite.bytes.slice(), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        },
      });
    }
    if (request.method === 'DELETE') {
      const owner = signer(request);
      if (owner === null) return json(401, { error: 'unauthorized' });
      const input = parseBody(body);
      if (
        input === null ||
        !hasExactly(input, ['v', 'lookupId', 'nonce', 'ts']) ||
        input.lookupId !== idText
      ) {
        return json(400, { error: 'bad_request' });
      }
      const invite = liveInvite(key);
      if (invite === undefined) return notFound();
      if (invite.owner !== owner) return json(403, { error: 'forbidden' });
      invites.delete(key);
      return new Response(null, { status: 204 });
    }
    return json(405, { error: 'method_not_allowed' });
  }

  const signedUrl = (path, expiresAt) =>
    `${origin}${path}?e=${String(expiresAt)}&m=${b64url(randomBytes(32))}`;

  /** The drop's side of the adapter's `fetch`. */
  async function fetchDrop(request) {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.clone().arrayBuffer());
    seen.push({ method: request.method, path: url.pathname, body });
    if (url.origin !== origin) return json(404, { error: 'not_found' });
    const path = url.pathname;

    if (path === '/v1/invite' || path.startsWith('/v1/i/'))
      return handleInvite(request, path, body);
    const report = request.method === 'POST' && path === '/v1/report' ? parseBody(body) : null;
    if (report !== null && Object.hasOwn(report, 'lookupId')) {
      // Only the invite form is faked: deletes that object, the same answer whether it existed.
      const input = report;
      if (
        input === null ||
        !hasExactly(input, ['v', 'lookupId', 'reason']) ||
        input.v !== 1 ||
        !REASONS.includes(input.reason)
      ) {
        return json(400, { error: 'bad_request' });
      }
      const key = inviteKey(input.lookupId);
      if (key === null) return json(400, { error: 'bad_request' });
      invites.delete(key);
      return json(202, { ok: true });
    }

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
      if (encodeHex(sha256(object.bytes)) !== reported) {
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

  return { origin, fetch: fetchDrop, download, objects, invites, seen };
}
