// Types for the `cloudflare:test` module of @cloudflare/vitest-plugin, narrowed to what
// test/files-drop.worker.test.ts uses (the plugin's own declarations need @cloudflare/workers-types,
// which this repo does not add as a dependency). Same shape as packages/core/test/cloudflare-test.d.ts.
declare module 'cloudflare:test' {
  export const env: unknown;
  export const SELF: {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  };
}
