import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@agentlink/cloud-agent', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@agentlink/cloud-agent');
  });
});
