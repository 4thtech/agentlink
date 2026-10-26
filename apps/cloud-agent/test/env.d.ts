// Types for the `cloudflare:test` module of @cloudflare/vitest-plugin, narrowed to what these tests
// use (the plugin's own declarations need @cloudflare/workers-types, which this repo does not add as
// a dependency). Tests cast `env` to the Worker's CloudAgentEnv.
declare module 'cloudflare:test' {
  export const env: unknown;
  export const SELF: {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  };
  export function runInDurableObject<O, R>(
    stub: unknown,
    callback: (instance: O, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
  /** Runs the object's alarm now if one is set; true when it ran. */
  export function runDurableObjectAlarm(stub: unknown): Promise<boolean>;
  /** Resets the object's in-memory state: the next call constructs it again from storage. */
  export function evictDurableObject(stub: unknown): Promise<void>;
}

declare module '*?raw' {
  const text: string;
  export default text;
}
