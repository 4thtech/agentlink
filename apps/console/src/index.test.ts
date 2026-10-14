import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@agentlink/console', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@agentlink/console');
  });
});
