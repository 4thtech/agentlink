// CHORE-SUBMITTER-WRANGLER-DEV: Wrangler refuses a Worker entry module with exports the runtime
// does not expect (`wrangler dev` failed on `MAX_BODY_BYTES`). src/index.ts, the module
// wrangler.toml deploys, exports only the fetch handler and the Durable Object classes its
// bindings name; the shared constants and helpers come from src/lib.ts (the package surface).
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.js';
import * as lib from '../src/lib.js';

describe('the Worker entry module', () => {
  it('exports exactly the handler and the Durable Object classes', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'SubmitterDepositRelay',
      'SubmitterFaucet',
      'SubmitterLimits',
      'SubmitterQueue',
      'default',
    ]);
    expect(typeof entry.default.fetch).toBe('function');
    for (const cls of [
      entry.SubmitterQueue,
      entry.SubmitterLimits,
      entry.SubmitterFaucet,
      entry.SubmitterDepositRelay,
    ]) {
      expect(typeof cls).toBe('function');
    }
  });

  it('leaves the shared exports to the library module', () => {
    expect(lib.packageName).toBe('@4thtech-io/submitter');
    expect(lib.MAX_BODY_BYTES).toBe(128 * 1024);
    expect(typeof lib.createSubmitterWorker).toBe('function');
    expect(lib.SubmitterLimits).toBe(entry.SubmitterLimits);
  });
});
