import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@4thtech-io/submitter', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@4thtech-io/submitter');
  });
});
