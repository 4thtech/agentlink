import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@agentlink/drop', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@agentlink/drop');
  });
});
