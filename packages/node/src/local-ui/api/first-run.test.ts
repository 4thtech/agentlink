// M1-11b-1: the first-run page's status route (08 §1). It says only whether approvals are protected
// yet, as one fixed word; it is a read route (no presence), and the setup routes stay setup routes.
import { describe, expect, it } from 'vitest';
import type { LocalUiContext } from '../context.js';
import { createLocalUiRoutes } from '../routes.js';
import { firstRunRoutes, firstRunStatus } from './first-run.js';

const OWNER = {
  agent: '0x' + '11'.repeat(20),
  owner: {
    ownerEvm: new Uint8Array(20).fill(1),
    ownerNostr: new Uint8Array(32).fill(2),
    ownerEnc: new Uint8Array(33).fill(3),
  },
};

function contextWith(ownerContext: LocalUiContext['ownerContext']): LocalUiContext {
  return {
    client: undefined,
    ownerContext,
    applyOwnerAction: () => Promise.reject(new Error('never called')),
    now: () => 0,
  };
}

describe('GET /api/ui/first-run (M1-11b-1)', () => {
  it('answers missing while no owner is set up', async () => {
    const result = await firstRunStatus(contextWith(() => Promise.resolve(undefined)));
    expect(result).toEqual({ status: 200, body: { owner: 'missing' } });
  });

  it('answers set_up once the agent card names an owner, and nothing about the owner', async () => {
    const result = await firstRunStatus(contextWith(() => Promise.resolve(OWNER as never)));
    expect(result).toEqual({ status: 200, body: { owner: 'set_up' } });
  });

  it('answers unknown when the check fails, without the error text', async () => {
    const result = await firstRunStatus(
      contextWith(() => Promise.reject(new Error('keychain locked at /Users/x'))),
    );
    expect(result).toEqual({ status: 200, body: { owner: 'unknown' } });
    expect(JSON.stringify(result)).not.toContain('keychain');
  });

  it('is a read route; begin and finish stay setup routes run by the setup gate', () => {
    const registry = createLocalUiRoutes();
    const match = registry.match('GET', '/api/ui/first-run');
    expect(match).not.toBe('method');
    if (match === undefined || match === 'method') throw new Error('not registered');
    expect(match.route.presence).toBe(false);
    expect(registry.match('POST', '/api/ui/first-run')).toBe('method');
    const setup = firstRunRoutes.filter((r) => r.presence === 'setup');
    expect(setup.map((r) => [r.method, r.path])).toEqual([
      ['POST', '/api/ui/first-run/owner/begin'],
      ['POST', '/api/ui/first-run/owner/finish'],
    ]);
  });
});
