// M1-27b: the deploy smoke test (test/smoke-steps.ts) against the Worker under Miniflare (workerd),
// on every `pnpm test`. The same steps run against the deployed staging Worker in the deploy
// workflow (test/smoke-remote.test.ts). Nothing here is a real secret: the URL key is the fixed test
// key of vitest.config.ts and every drop key is random.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { signDropAuthorization } from '@4thtech-io/crypto/testing';
import {
  SmokeFailure,
  smokeExpiredGet,
  smokeHealth,
  smokeOrigin,
  smokeRoundTrip,
  type SmokeTarget,
} from './smoke-steps.js';

const target: SmokeTarget = {
  base: 'https://drop.test',
  fetch: (input, init) => SELF.fetch(input, init),
  sign: signDropAuthorization,
  headers: { 'cf-connecting-ip': '192.0.2.77' },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

describe('deploy smoke (local Worker)', () => {
  it('health answers and the configuration is loaded', async () => {
    await smokeHealth(target);
  });

  it('signed upload, GET and DELETE round trip', async () => {
    await smokeRoundTrip(target);
  });

  it('an expired GET is refused', async () => {
    await smokeExpiredGet(target);
  });

  it('fails on a drop that is not this one, without a URL in the message (negative control)', async () => {
    const wrongHost: SmokeTarget = { ...target, base: 'https://other.test' };
    const error = await smokeRoundTrip(wrongHost).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmokeFailure);
    expect(String(error)).not.toMatch(/https?:|\/v1\//);
  });
});

describe('smokeOrigin', () => {
  it('accepts a bare https origin only', () => {
    expect(smokeOrigin('https://agentlink-drop-staging.example.workers.dev')).toBe(
      'https://agentlink-drop-staging.example.workers.dev',
    );
    expect(smokeOrigin('https://drop.example/')).toBe('https://drop.example');
    expect(smokeOrigin('http://drop.example')).toBeNull();
    expect(smokeOrigin('https://drop.example/v1')).toBeNull();
    expect(smokeOrigin('https://drop.example?x=1')).toBeNull();
    expect(smokeOrigin('https://user:pw@drop.example')).toBeNull();
    expect(smokeOrigin('not a url')).toBeNull();
  });
});
