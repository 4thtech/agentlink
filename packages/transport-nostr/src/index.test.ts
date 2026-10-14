import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@agentlink/transport-nostr', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@agentlink/transport-nostr');
  });
});
