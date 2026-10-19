// Types for the `cloudflare:test` module of @cloudflare/vitest-plugin, narrowed to what the
// submitter's tests use (the plugin's own declarations need @cloudflare/workers-types, which this
// repo does not add as a dependency). Tests cast `env` to the Worker's SubmitterEnv.
declare module 'cloudflare:test' {
  export const env: unknown;
  export const SELF: {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  };
  export function runDurableObjectAlarm(stub: unknown): Promise<boolean>;
}
