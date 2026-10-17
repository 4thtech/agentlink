// The small part of the Cloudflare Workers runtime API that the drop uses (R2, Durable Objects),
// declared here instead of adding @cloudflare/workers-types as a dependency. Shapes follow the
// Workers runtime documentation; only the members the drop calls are listed.

interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly customMetadata?: Record<string, string>;
  readonly httpMetadata?: { contentType?: string; contentDisposition?: string };
}

interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

interface R2MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(
    partNumber: number,
    value: ReadableStream | ArrayBuffer | Uint8Array,
  ): Promise<R2UploadedPart>;
  abort(): Promise<void>;
  complete(parts: R2UploadedPart[]): Promise<R2Object>;
}

interface R2Objects {
  readonly objects: R2Object[];
  readonly truncated: boolean;
}

interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array | null,
  ): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    include?: ('httpMetadata' | 'customMetadata')[];
  }): Promise<R2Objects>;
  createMultipartUpload(key: string): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface DurableObjectId {
  toString(): string;
}

/** An RPC stub: every method of T, returning a Promise. */
type DurableObjectStub<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

interface DurableObjectNamespace<T> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
