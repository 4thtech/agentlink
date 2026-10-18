import { describe, expect, it } from 'vitest';

// Imports every shared package through its published entry point (dist), as a consumer would.
// Literal specifiers only: the boundary guards (tools/deps-check) cannot check a computed import().
const shared: Record<string, () => Promise<{ packageName?: unknown }>> = {
  '@4thtech-io/types': () => import('@4thtech-io/types'),
  '@4thtech-io/crypto': () => import('@4thtech-io/crypto'),
  '@4thtech-io/chain': () => import('@4thtech-io/chain'),
  '@4thtech-io/transport-nostr': () => import('@4thtech-io/transport-nostr'),
  '@4thtech-io/storage': () => import('@4thtech-io/storage'),
  '@4thtech-io/core': () => import('@4thtech-io/core'),
  '@4thtech-io/node': () => import('@4thtech-io/node'),
  '@4thtech-io/ui': () => import('@4thtech-io/ui'),
};

describe('shared packages import in Node', () => {
  it.each(Object.entries(shared))('%s', async (name, load) => {
    const mod = await load();
    expect(mod.packageName).toBe(name);
  });
});
