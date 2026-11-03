// R2: a failed answer's fixed `reason` becomes specific plain copy (11 §5); an unknown reason keeps
// a generic line plus "Run `agentlink doctor` for details". Server text never reaches the page.
import { describe, expect, it } from 'vitest';
import { createOwnerClient } from '../pages/contacts/owner.js';
import { createSetupApi } from '../pages/first-run/setup-api.js';
import { setupMessage } from '../pages/first-run/index.js';
import { FAILURE_COPY, FAILURE_REASON_CODES, failureCopy } from './failure-reasons.js';

const BANNED = /wallet|\bgas\b|seed phrase|transaction/i;

describe('failureCopy', () => {
  it('has its own plain line for every reason code', () => {
    expect(FAILURE_REASON_CODES).toEqual([
      'storage_unreachable',
      'relay_unreachable',
      'ai_app_running',
      'ai_app_config_unwritable',
      'keychain_unavailable',
      'busy',
      'concurrent_change',
      'internal',
    ]);
    const lines = FAILURE_REASON_CODES.map((r) => failureCopy(r));
    expect(new Set(lines).size).toBe(lines.length);
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(20);
      expect(line).not.toMatch(BANNED);
      expect(line).not.toMatch(/_/);
    }
    expect(Object.keys(FAILURE_COPY).sort()).toEqual([...FAILURE_REASON_CODES].sort());
  });
  it('an unknown or missing reason is generic and points to doctor', () => {
    for (const r of [undefined, 'whatever', 5, null, '__proto__']) {
      expect(failureCopy(r)).toContain('agentlink doctor');
      expect(failureCopy(r)).toContain('details');
    }
  });
});

describe('where the reason is read', () => {
  it('the setup call keeps a known reason as the problem, with specific words', async () => {
    const api = createSetupApi({
      token: 't',
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ status: 'failed', reason: 'storage_unreachable' }), {
            status: 500,
          }),
        )) as unknown as typeof fetch,
    });
    const result = await api.finish(new Uint8Array([1, 2, 3]), 'N'.repeat(43));
    expect(result).toEqual({ kind: 'error', problem: 'storage_unreachable' });
    expect(setupMessage({ problem: 'storage_unreachable' } as never)).toBe(
      failureCopy('storage_unreachable'),
    );
    expect(setupMessage({ problem: 'internal' } as never)).toContain('details');
    expect(setupMessage({ problem: 'unknown' } as never)).toContain('details');
  });
  it('the owner call keeps the reason of a failed answer', async () => {
    const owner = createOwnerClient({
      token: 't',
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ status: 'failed', reason: 'keychain_unavailable' }), {
            status: 500,
          }),
        )) as unknown as typeof fetch,
    });
    const result = await owner.post('/api/ui/x', undefined, { kind: 'code', code: 'AAAA' });
    expect(result).toEqual({ kind: 'failed', reason: 'keychain_unavailable' });
    const odd = createOwnerClient({
      token: 't',
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ status: 'failed', reason: 'Error: /home/me' }), {
            status: 500,
          }),
        )) as unknown as typeof fetch,
    });
    expect(await odd.post('/api/ui/x', undefined, { kind: 'code', code: 'AAAA' })).toEqual({
      kind: 'failed',
    });
  });
});
