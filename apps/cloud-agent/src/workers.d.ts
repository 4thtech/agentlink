// The small part of the Cloudflare Workers runtime API that the cloud agent uses (SQLite-backed
// Durable Object storage, alarms, R2, outbound WebSockets), declared here instead of adding
// @cloudflare/workers-types as a dependency (as apps/drop does). Shapes follow the Workers runtime
// documentation; only the members the cloud agent calls are listed.

/** One row source of `sql.exec`. */
interface SqlStorageCursor {
  toArray(): Record<string, unknown>[];
  raw(): IterableIterator<unknown[]>;
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlStorageCursor;
}

interface DurableObjectStorage {
  readonly sql: SqlStorage;
  /** Runs `fn` as one SQLite transaction: all of it commits, or none of it when it throws. */
  transactionSync<T>(fn: () => T): T;
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

/** What the runtime passes to `alarm()`. */
interface AlarmInvocationInfo {
  readonly retryCount: number;
  readonly isRetry: boolean;
}

interface R2Bucket {
  head(key: string): Promise<unknown>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

// Outbound WebSockets: `fetch` with `Upgrade: websocket` answers 101 with `webSocket`, which the
// Worker accepts before use.
interface Response {
  readonly webSocket: WebSocket | null;
}

interface ResponseInit {
  webSocket?: WebSocket | null;
}

interface WebSocket {
  accept(): void;
}

declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
