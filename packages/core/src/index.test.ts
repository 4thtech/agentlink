import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@agentlink/core', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@agentlink/core');
  });
});
