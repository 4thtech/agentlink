// N19 (spec §2.3): Under the hood shows the server's real facts from the health read.
import { describe, expect, it } from 'vitest';
import { serverFacts } from './status-strip.js';

const ok = (data: unknown) => ({ kind: 'ok' as const, status: 200, data });

describe('serverFacts', () => {
  it('shows version, port, relays and last sync from the health answer', () => {
    const facts = serverFacts(
      ok({
        agent: 'running',
        version: '0.5.1',
        relays: { connected: 2, total: 3 },
        lastSyncAt: 1_700_000_000,
      }),
      '48123',
      'en-GB',
    );
    expect(facts.map((f) => [f.label, f.value])).toEqual([
      ['Version', '0.5.1'],
      ['Port', '48123'],
      ['Relays', '2 of 3 connected'],
      ['Last sync', expect.stringMatching(/^\d\d:\d\d$/)],
    ]);
  });

  it('shows nothing it was not told: no relays, no port, no answer', () => {
    expect(serverFacts(undefined, '1')).toEqual([]);
    expect(serverFacts(ok({ agent: 'running' }), '')).toEqual([]);
    expect(serverFacts({ kind: 'error', status: 500 }, '1')).toEqual([]);
  });

  it('never shows an address or path from the body', () => {
    const facts = serverFacts(
      ok({
        agent: 'running',
        version: '0.5.1',
        relays: { connected: 1, total: 1 },
        dataDir: '/Users/x/.agentlink',
        relay: 'wss://r.example',
      }),
      '1234',
    );
    expect(JSON.stringify(facts)).not.toMatch(/Users|wss/);
  });

  it('shows the data folder (home as ~) and the uptime when the server answers them', () => {
    const facts = serverFacts(
      ok({
        agent: 'running',
        version: '0.5.1',
        relays: null,
        lastSyncAt: null,
        dataFolder: '~/.agentlink',
        uptimeSeconds: 3_725,
      }),
      '48123',
    );
    expect(facts.map((f) => [f.label, f.value])).toEqual([
      ['Version', '0.5.1'],
      ['Port', '48123'],
      ['Data folder', '~/.agentlink'],
      ['Uptime', '1 h 2 min'],
    ]);
    const short = serverFacts(ok({ agent: 'running', uptimeSeconds: 42 }), '');
    expect(short).toEqual([{ label: 'Uptime', value: 'Under a minute' }]);
    const days = serverFacts(ok({ agent: 'running', uptimeSeconds: 2 * 86_400 + 3_600 }), '');
    expect(days).toEqual([{ label: 'Uptime', value: '2 d 1 h' }]);
  });

  it('never shows an absolute data folder or a malformed uptime', () => {
    for (const dataFolder of ['/Users/alice/.agentlink', 'C:\\Users\\alice', '~/a\nb', 42, '']) {
      const facts = serverFacts(ok({ agent: 'running', dataFolder }), '');
      expect(facts).toEqual([]);
    }
    for (const uptimeSeconds of [-1, 1.5, '60', Number.NaN, null]) {
      expect(serverFacts(ok({ agent: 'running', uptimeSeconds }), '')).toEqual([]);
    }
  });
});
