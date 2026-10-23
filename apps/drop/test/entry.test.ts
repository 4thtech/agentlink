// CHORE-DROP-ENTRY-EXPORTS: Wrangler refuses a Worker entry module with exports the runtime does
// not expect (`wrangler dev` fails on non-handler exports). src/index.ts, the module wrangler.toml
// deploys, exports only the fetch handler and the Durable Object class its binding names; the shared
// constants and helpers come from src/lib.ts. The drop only ever receives ciphertext (D-48): this
// change moves exports and widens nothing.
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.js';
import * as lib from '../src/lib.js';

describe('the Worker entry module', () => {
  it('exports exactly the handler and the Durable Object class', () => {
    expect(Object.keys(entry).sort()).toEqual(['DropState', 'default']);
    expect(typeof entry.default.fetch).toBe('function');
    expect(typeof entry.DropState).toBe('function');
  });

  it('leaves the shared exports to the library module', () => {
    expect(lib.packageName).toBe('@4thtech-io/drop');
    expect(typeof lib.readConfig).toBe('function');
    expect(typeof lib.ipBucket).toBe('function');
    expect(lib.DEFAULTS.maxSize).toBeGreaterThan(0);
    expect(Array.isArray(lib.METRICS)).toBe(true);
    expect(lib.DropState).toBe(entry.DropState);
  });
});
