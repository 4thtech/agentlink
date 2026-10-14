import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@agentlink/chain', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@agentlink/chain');
  });
});
