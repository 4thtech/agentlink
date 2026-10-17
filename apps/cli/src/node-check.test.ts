import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkNodeVersion, isNodeTooOld, MIN_NODE } from './node-check.js';

describe('Node version check (M1-9y)', () => {
  it('refuses Node older than 22.14.0 with one clear line', () => {
    expect(checkNodeVersion('22.13.1')).toBe(
      'AgentLink needs Node.js 22.14 or newer; you have v22.13.1. Update Node (nodejs.org, or `nvm install --lts`) and try again.',
    );
    expect(checkNodeVersion('v20.11.0')).toContain('you have v20.11.0');
    expect(checkNodeVersion('22.13.1')).not.toContain('\n');
  });

  it('accepts 22.14.0 and newer', () => {
    for (const v of ['22.14.0', '22.14.1', '22.15.0', '23.0.0', '24.1.0', '100.0.0']) {
      expect(checkNodeVersion(v)).toBeUndefined();
    }
  });

  it('compares numerically, not as text', () => {
    expect(isNodeTooOld('22.9.0')).toBe(true);
    expect(isNodeTooOld('9.99.99')).toBe(true);
    expect(isNodeTooOld('22.100.0')).toBe(false);
  });

  it('treats an unreadable version as too old', () => {
    expect(checkNodeVersion('garbage')).toBeDefined();
  });

  it('keeps the minimum in step with engines.node', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(`>=${MIN_NODE}`);
  });
});
