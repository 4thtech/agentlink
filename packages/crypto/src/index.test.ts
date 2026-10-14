import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@agentlink/crypto', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@agentlink/crypto');
  });
});
