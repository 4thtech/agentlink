// W4-SHORT-INVITE (07 §5.4, 04 §3.6.2): the drop client's invite object calls. The upload is one
// signed `POST /v1/invite` at a recorded epoch; the delete is a signed `DELETE /v1/i/{lookupId}` at
// that epoch; the fetch is one unauthenticated GET built from the configured drop origin and a
// strict 22-character lookup ID only, with no redirect, no credentials, no referrer, a status and
// content-type check and a 17 441-byte cap (Content-Length and a running count). No error carries a
// URL or the lookup ID (I-7).
import { decodeUtf8, dropRequestEpoch, type DropAuthRequest } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import { createDropAdapter, type DropSigner } from './drop.js';
import { INVITE_OBJECT_MAX_BYTES, fetchInviteObject } from './drop-invite.js';
import { StorageError } from './errors.js';

const ORIGIN = 'https://drop.test';
const NOW_S = 1_800_000_000;
const ID = 'AAECAwQFBgcICQoLDA0ODw'; // 16 bytes, last character with zero trailing bits
const SIGNATURE = 'Nostr ZXZlbnQ';

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const octets = (bytes: Uint8Array, headers: Record<string, string> = {}): Response =>
  new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', ...headers },
  });

function harness(answer: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const signed: { request: DropAuthRequest; epoch: number }[] = [];
  const state = { epoch: 3 };
  const signer: DropSigner = {
    async signDropRequest(request, createdAt, opts) {
      expect(createdAt).toBe(NOW_S);
      signed.push({ request, epoch: dropRequestEpoch(request, opts, state.epoch) });
      return SIGNATURE;
    },
    async getPublicBundle() {
      return { keyEpoch: state.epoch };
    },
  };
  const fetch = async (request: Request): Promise<Response> => {
    seen.push(request.clone());
    return answer(request);
  };
  const adapter = createDropAdapter({
    endpoint: ORIGIN,
    signer,
    fetch,
    now: () => new Date(NOW_S * 1000),
  });
  return { adapter, seen, signed, state, fetch };
}

const errorOf = async (p: Promise<unknown>): Promise<StorageError> => {
  const e = await p.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(e).toBeInstanceOf(StorageError);
  return e as StorageError;
};

describe('putInvite / deleteInvite (07 §5.4)', () => {
  it('uploads one signed POST /v1/invite with exactly the spec body, at the given epoch', async () => {
    const h = harness(() => json(201, { expiresAt: NOW_S + 3600 }));
    expect(await h.adapter.inviteEpoch()).toBe(3);
    const object = new Uint8Array([0x41, 0x4c, 0x49, 0x31, 1, ...new Uint8Array(40)]);
    const out = await h.adapter.putInvite({
      lookupId: ID,
      object,
      expiresAt: new Date((NOW_S + 3600) * 1000),
      epoch: 3,
    });
    expect(out.expiresAt.getTime()).toBe((NOW_S + 3600) * 1000);
    expect(h.seen).toHaveLength(1);
    const [req] = h.seen;
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe(`${ORIGIN}/v1/invite`);
    expect(req?.redirect).toBe('manual');
    const body = JSON.parse(decodeUtf8(new Uint8Array(await req!.arrayBuffer()))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(
      ['expiresAt', 'lookupId', 'nonce', 'object', 'ts', 'v'].sort(),
    );
    expect(body).toMatchObject({ v: 1, lookupId: ID, expiresAt: NOW_S + 3600, ts: NOW_S });
    expect(h.signed[0]?.epoch).toBe(3);
  });

  it('refuses before sending when the epoch moved, or for a non-strict lookup ID', async () => {
    const h = harness(() => json(201, { expiresAt: NOW_S + 60 }));
    h.state.epoch = 4;
    const put = (lookupId: string) =>
      h.adapter.putInvite({
        lookupId,
        object: new Uint8Array(40),
        expiresAt: new Date((NOW_S + 60) * 1000),
        epoch: 3,
      });
    expect((await errorOf(put(ID))).code).toBe('upload_failed');
    h.state.epoch = 3;
    expect((await errorOf(put(`${ID.slice(0, 21)}B`))).code).toBe('invalid_argument');
    expect((await errorOf(put(ID.slice(1)))).code).toBe('invalid_argument');
  });

  it('maps 429 and 503 to retryable errors and other refusals to upload_failed', async () => {
    for (const [status, codeWanted] of [
      [429, 'rate_limited'],
      [503, 'unavailable'],
      [409, 'upload_failed'],
      [400, 'upload_failed'],
    ] as const) {
      const h = harness(() => json(status, { error: 'x' }, { 'retry-after': '5' }));
      const e = await errorOf(
        h.adapter.putInvite({
          lookupId: ID,
          object: new Uint8Array(40),
          expiresAt: new Date((NOW_S + 60) * 1000),
          epoch: 3,
        }),
      );
      expect(e.code).toBe(codeWanted);
      expect(e.message).not.toContain(ID);
    }
  });

  it('deletes with a signed DELETE /v1/i/{lookupId} at the recorded epoch; 404 is done', async () => {
    const h = harness((r) =>
      r.method === 'DELETE' ? new Response(null, { status: 204 }) : json(500, {}),
    );
    await h.adapter.deleteInvite(ID, 2);
    expect(h.seen[0]?.method).toBe('DELETE');
    expect(h.seen[0]?.url).toBe(`${ORIGIN}/v1/i/${ID}`);
    const body = JSON.parse(decodeUtf8(new Uint8Array(await h.seen[0]!.arrayBuffer()))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(['lookupId', 'nonce', 'ts', 'v']);
    expect(body['lookupId']).toBe(ID);
    expect(h.signed[0]?.epoch).toBe(2);
    const gone = harness(() => json(404, { error: 'not_found' }));
    await expect(gone.adapter.deleteInvite(ID, 3)).resolves.toBeUndefined();
    const busy = harness(() => json(503, { error: 'unavailable' }));
    expect((await errorOf(busy.adapter.deleteInvite(ID, 3))).code).toBe('unavailable');
  });
});

describe('fetchInviteObject (04 §3.6.2 steps 2–4)', () => {
  const obj = new Uint8Array([0x41, 0x4c, 0x49, 0x31, 1, ...new Uint8Array(100)]);

  it('one GET of <origin>/v1/i/<id>: no redirect, no credentials, no referrer', async () => {
    const seen: Request[] = [];
    const out = await fetchInviteObject(
      {
        endpoint: ORIGIN,
        fetch: async (r) => {
          seen.push(r);
          return octets(obj);
        },
      },
      ID,
    );
    expect(out).toEqual(obj);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toBe(`${ORIGIN}/v1/i/${ID}`);
    expect(seen[0]?.redirect).toBe('manual');
    expect(seen[0]?.credentials).toBe('omit');
    expect(seen[0]?.referrerPolicy).toBe('no-referrer');
    expect(seen[0]?.headers.get('authorization')).toBeNull();
  });

  it('maps 404 to not_found, 429/503 to retryable, and 3xx or any other status to a failure', async () => {
    const run = (res: Response) =>
      fetchInviteObject({ endpoint: ORIGIN, fetch: async () => res }, ID);
    expect((await errorOf(run(json(404, { error: 'not_found' })))).code).toBe('not_found');
    expect((await errorOf(run(json(429, {}, { 'retry-after': '9' })))).code).toBe('rate_limited');
    expect((await errorOf(run(json(503, {})))).code).toBe('unavailable');
    const redirect = new Response(null, {
      status: 302,
      headers: { location: 'https://evil.test/' },
    });
    expect((await errorOf(run(redirect))).code).toBe('download_failed');
    expect((await errorOf(run(json(500, {})))).code).toBe('download_failed');
    const opaque = {
      ...new Response(null),
      status: 0,
      type: 'opaqueredirect',
    } as unknown as Response;
    expect((await errorOf(run(opaque))).code).toBe('download_failed');
  });

  it('accepts only application/octet-stream', async () => {
    const e = await errorOf(
      fetchInviteObject(
        {
          endpoint: ORIGIN,
          fetch: async () =>
            new Response(obj as Uint8Array<ArrayBuffer>, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }),
        },
        ID,
      ),
    );
    expect(e.code).toBe('invalid_response');
  });

  it('refuses a Content-Length above 17 441 before reading, and a longer body while reading', async () => {
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4096));
        if (pulled > 10) controller.close();
      },
    });
    const declared = await errorOf(
      fetchInviteObject(
        {
          endpoint: ORIGIN,
          fetch: async () =>
            new Response(big, {
              status: 200,
              headers: {
                'content-type': 'application/octet-stream',
                'content-length': String(INVITE_OBJECT_MAX_BYTES + 1),
              },
            }),
        },
        ID,
      ),
    );
    expect(declared.code).toBe('too_large');
    expect(pulled).toBeLessThanOrEqual(1);
    const undeclared = await errorOf(
      fetchInviteObject(
        {
          endpoint: ORIGIN,
          fetch: async () => octets(new Uint8Array(INVITE_OBJECT_MAX_BYTES + 1)),
        },
        ID,
      ),
    );
    expect(undeclared.code).toBe('too_large');
    await expect(
      fetchInviteObject(
        { endpoint: ORIGIN, fetch: async () => octets(new Uint8Array(INVITE_OBJECT_MAX_BYTES)) },
        ID,
      ),
    ).resolves.toHaveLength(INVITE_OBJECT_MAX_BYTES);
  });

  it('refuses a non-strict lookup ID before any request, and a network error carries no URL', async () => {
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls += 1;
      throw new Error(`${ORIGIN}/v1/i/${ID}`);
    };
    for (const bad of [`${ID.slice(0, 21)}B`, `${ID}A`, '../x', `${ID.slice(0, 21)}=`]) {
      expect((await errorOf(fetchInviteObject({ endpoint: ORIGIN, fetch }, bad))).code).toBe(
        'invalid_argument',
      );
    }
    expect(calls).toBe(0);
    const e = await errorOf(fetchInviteObject({ endpoint: ORIGIN, fetch }, ID));
    expect(e.code).toBe('network');
    expect(e.message).not.toContain(ID);
    expect(e.message).not.toContain('drop.test');
  });
});
