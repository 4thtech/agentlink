// M1-27b: the deploy smoke test against a deployed drop (release-and-deployment.md §4.5, job
// `smoke-staging` of .github/workflows/deploy-drop.yml). Runs only when the workflow provides the
// staging origin as DROP_SMOKE_URL (vitest.config.ts `provide`); otherwise every test is skipped.
// No credentials: a fresh random drop key and random bytes. Nothing is logged (I-7).
import { describe, inject, it } from 'vitest';
import { signDropAuthorization } from '@4thtech-io/crypto/testing';
import {
  smokeExpiredGet,
  smokeHealth,
  smokeOrigin,
  smokeRoundTrip,
  type SmokeTarget,
} from './smoke-steps.js';

declare module 'vitest' {
  export interface ProvidedContext {
    dropSmokeUrl: string;
  }
}

const configured = inject('dropSmokeUrl');

describe.skipIf(configured === '')('deploy smoke (deployed drop)', () => {
  const target = (): SmokeTarget => {
    const base = smokeOrigin(configured);
    if (base === null) throw new Error('DROP_SMOKE_URL must be a bare https origin');
    return {
      base,
      // A redirect would leave the drop: never follow one.
      fetch: (input, init) => fetch(input, { ...init, redirect: 'manual' }),
      sign: signDropAuthorization,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  };

  it('health answers and the configuration is loaded', async () => {
    await smokeHealth(target());
  });

  it('signed upload, GET and DELETE round trip', async () => {
    await smokeRoundTrip(target());
  });

  it('an expired GET is refused', async () => {
    await smokeExpiredGet(target(), 5);
  });
});
