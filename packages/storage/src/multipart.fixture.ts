// Test-only: an in-memory S3 that speaks multipart upload and bucket lifecycle (M1-6b), behind an
// injected fetch. No real network is used. Bodies of part PUTs are counted, not kept, beyond the
// assembled object, so large uploads stay cheap.
import { encodeBase64url, encodeHex, randomBytes, sha256 } from '@agentlink/crypto';

export interface FakeRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly redirect: RequestRedirect;
  readonly body: Uint8Array;
}

export interface FakeUpload {
  readonly key: string;
  readonly parts: Map<number, Uint8Array>;
}

export interface FakeMultipartS3 {
  readonly fetch: (input: Request) => Promise<Response>;
  readonly requests: FakeRequest[];
  /** Completed objects by key. */
  readonly objects: Map<string, Uint8Array>;
  /** Open multipart uploads by upload ID. */
  readonly uploads: Map<string, FakeUpload>;
  /** The bucket lifecycle document as last PUT, or null. */
  lifecycle: string | null;
  /** Returns a Response to override the default handling of a request, or undefined. */
  override: ((req: FakeRequest) => Response | undefined) | undefined;
}

function xml(body: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status,
    headers: { 'Content-Type': 'application/xml' },
  });
}

function etagOf(bytes: Uint8Array): string {
  return `"${encodeHex(sha256(bytes)).slice(0, 32)}"`;
}

export function fakeMultipartS3(bucket: string): FakeMultipartS3 {
  const state: FakeMultipartS3 = {
    fetch: async () => new Response(null, { status: 500 }),
    requests: [],
    objects: new Map(),
    uploads: new Map(),
    lifecycle: null,
    override: undefined,
  };

  const handle = (req: FakeRequest): Response => {
    const path = decodeURIComponent(req.url.pathname);
    const q = req.url.searchParams;
    if (path === `/${bucket}` || path === `/${bucket}/`) {
      if (q.has('lifecycle')) {
        if (req.method === 'GET') {
          return state.lifecycle === null
            ? xml('<Error><Code>NoSuchLifecycleConfiguration</Code></Error>', 404)
            : xml(state.lifecycle);
        }
        if (req.method === 'PUT') {
          state.lifecycle = new TextDecoder().decode(req.body).replace(/^<\?xml[^>]*\?>/, '');
          return new Response(null, { status: 200 });
        }
      }
      if (q.has('uploads') && req.method === 'GET') {
        const prefix = q.get('prefix') ?? '';
        const list = [...state.uploads.entries()]
          .filter(([, u]) => u.key.startsWith(prefix))
          .map(([id, u]) => `<Upload><Key>${u.key}</Key><UploadId>${id}</UploadId></Upload>`)
          .join('');
        return xml(
          `<ListMultipartUploadsResult><Bucket>${bucket}</Bucket><IsTruncated>false</IsTruncated>${list}</ListMultipartUploadsResult>`,
        );
      }
      return new Response(null, { status: 400 });
    }
    const key = path.slice(bucket.length + 2);
    if (req.method === 'POST' && q.has('uploads')) {
      const id = encodeBase64url(randomBytes(24));
      state.uploads.set(id, { key, parts: new Map() });
      return xml(
        `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    const uploadId = q.get('uploadId');
    if (uploadId !== null) {
      const upload = state.uploads.get(uploadId);
      if (upload === undefined || upload.key !== key) {
        return xml('<Error><Code>NoSuchUpload</Code></Error>', 404);
      }
      if (req.method === 'PUT') {
        const n = Number(q.get('partNumber'));
        upload.parts.set(n, req.body);
        return new Response(null, { status: 200, headers: { ETag: etagOf(req.body) } });
      }
      if (req.method === 'DELETE') {
        state.uploads.delete(uploadId);
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST') {
        const doc = new TextDecoder().decode(req.body);
        const listed = [...doc.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag>/g)];
        const chunks: Uint8Array[] = [];
        let expected = 1;
        for (const [, num, tag] of listed) {
          const part = upload.parts.get(Number(num));
          if (Number(num) !== expected || part === undefined) {
            return xml('<Error><Code>InvalidPartOrder</Code></Error>', 400);
          }
          if (tag?.replace(/&quot;/g, '"') !== etagOf(part)) {
            return xml('<Error><Code>InvalidPart</Code></Error>', 400);
          }
          chunks.push(part);
          expected += 1;
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.length;
        }
        state.objects.set(key, out);
        state.uploads.delete(uploadId);
        return xml(
          `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>"x-${chunks.length}"</ETag></CompleteMultipartUploadResult>`,
        );
      }
    }
    if (req.method === 'GET') {
      const stored = state.objects.get(key);
      return stored === undefined
        ? new Response(null, { status: 404 })
        : new Response(new Uint8Array(stored), { status: 200 });
    }
    if (req.method === 'DELETE') {
      state.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 400 });
  };

  (state as { fetch: FakeMultipartS3['fetch'] }).fetch = async (input: Request) => {
    const body = new Uint8Array(await input.arrayBuffer());
    const req: FakeRequest = {
      method: input.method,
      url: new URL(input.url),
      headers: input.headers,
      redirect: input.redirect,
      body,
    };
    state.requests.push(req);
    return state.override?.(req) ?? handle(req);
  };
  return state;
}

/** A stream of `total` random-looking bytes in chunks of `chunk`, deterministic from `seed`. */
export function patternBytes(total: number, seed = 1): Uint8Array {
  const out = new Uint8Array(total);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < total; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export function chunked(data: Uint8Array, chunk: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunk, data.length);
      controller.enqueue(data.slice(offset, end));
      offset = end;
    },
  });
}

/** A stream that yields `before` bytes and then errors. */
export function failingStream(before: number, chunk = 1024 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= before) {
        controller.error(new Error('source failed'));
        return;
      }
      const n = Math.min(chunk, before - sent);
      controller.enqueue(new Uint8Array(n).fill(3));
      sent += n;
    },
  });
}
