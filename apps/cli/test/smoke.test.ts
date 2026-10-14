import { describe, expect, it } from 'vitest';

// Imports every shared package through its published entry point (dist), as a consumer would.
// Literal specifiers only: the boundary guards (tools/deps-check) cannot check a computed import().
const shared: Record<string, () => Promise<{ packageName?: unknown }>> = {
  '@agentlink/types': () => import('@agentlink/types'),
  '@agentlink/crypto': () => import('@agentlink/crypto'),
  '@agentlink/chain': () => import('@agentlink/chain'),
  '@agentlink/transport-nostr': () => import('@agentlink/transport-nostr'),
  '@agentlink/storage': () => import('@agentlink/storage'),
  '@agentlink/core': () => import('@agentlink/core'),
  '@agentlink/node': () => import('@agentlink/node'),
  '@agentlink/ui': () => import('@agentlink/ui'),
};

describe('shared packages import in Node', () => {
  it.each(Object.entries(shared))('%s', async (name, load) => {
    const mod = await load();
    expect(mod.packageName).toBe(name);
  });
});
