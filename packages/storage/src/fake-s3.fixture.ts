// Test-only helpers: a fake S3 endpoint behind an injected fetch. No real network is used.
import { encodeBase64url, randomBytes } from '@4thtech-io/crypto';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly redirect: RequestRedirect;
  readonly body: Uint8Array;
}

export interface FakeEndpoint {
  readonly fetch: (input: Request) => Promise<Response>;
  readonly requests: RecordedRequest[];
  /** Objects stored by key path (`/<bucket>/<key>`). */
  readonly objects: Map<string, Uint8Array>;
}

export type Responder = (req: RecordedRequest) => Response | Promise<Response>;

/** A minimal in-memory S3: PUT stores, GET reads, DELETE removes. `respond` overrides it. */
export function fakeEndpoint(respond?: Responder): FakeEndpoint {
  const requests: RecordedRequest[] = [];
  const objects = new Map<string, Uint8Array>();
  const fetch = async (input: Request): Promise<Response> => {
    const body = new Uint8Array(await input.arrayBuffer());
    const req: RecordedRequest = {
      method: input.method,
      url: input.url,
      headers: input.headers,
      redirect: input.redirect,
      body,
    };
    requests.push(req);
    if (respond !== undefined) return respond(req);
    const path = new URL(req.url).pathname;
    if (req.method === 'PUT') {
      objects.set(path, body);
      return new Response(null, { status: 200 });
    }
    if (req.method === 'DELETE') {
      objects.delete(path);
      return new Response(null, { status: 204 });
    }
    const stored = objects.get(path);
    return stored === undefined
      ? new Response(null, { status: 404 })
      : new Response(new Uint8Array(stored), { status: 200 });
  };
  return { fetch, requests, objects };
}

export const ENDPOINT = 'https://acct.r2.example.com';
export const BUCKET = 'agentlink-test';
export const NOW = new Date('2026-10-17T12:00:00.000Z');
export const DAY_MS = 86_400_000;

export function testPrefix(): string {
  return encodeBase64url(randomBytes(16));
}

export function bytes(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

export function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
