// Types for the `cloudflare:test` module of @cloudflare/vitest-plugin, narrowed to what the drop's
// tests use (the plugin's own declarations need @cloudflare/workers-types, which this repo does not
// add as a dependency). Tests cast `env` to the Worker's DropEnv.
declare module 'cloudflare:test' {
  export const env: unknown;
  /** Runs the Durable Object's scheduled alarm now; false when none is scheduled. */
  export function runDurableObjectAlarm(stub: unknown): Promise<boolean>;
  export const SELF: {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  };
}
