import { describe, expect, it } from 'vitest';

// Imports every shared package through its published entry point (dist), as a consumer would.
const shared = [
  '@agentlink/types',
  '@agentlink/crypto',
  '@agentlink/chain',
  '@agentlink/transport-nostr',
  '@agentlink/storage',
  '@agentlink/core',
  '@agentlink/node',
  '@agentlink/ui',
];

describe('shared packages import in Node', () => {
  it.each(shared)('%s', async (name) => {
    const mod = (await import(name)) as { packageName?: unknown };
    expect(mod.packageName).toBe(name);
  });
});
