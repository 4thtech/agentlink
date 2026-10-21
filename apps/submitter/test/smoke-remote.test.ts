// M1-10c: the deploy smoke test against a deployed submitter (release-and-deployment.md §4.5, job
// `smoke-staging` of .github/workflows/deploy-submitter.yml). Runs only when the workflow provides
// the staging origin as SUBMITTER_SMOKE_URL (vitest.config.ts `provide`); otherwise every test is
// skipped. No credentials: a fresh random agent key per step, and a Record that fails simulation,
// so nothing is sent and no gas is spent. Nothing is logged (I-7).
import { describe, inject, it } from 'vitest';
import { randomBytes } from '@4thtech-io/crypto';
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import {
  smokeFaucetRefusesMainnet,
  smokeHealth,
  smokeOrigin,
  smokeSimulatedNotarize,
  type SmokeAgent,
  type SmokeTarget,
} from './smoke-steps.js';

/**
 * A fresh smoke agent: a random seed in the crypto test seam's MemoryKeyStore (never stored or
 * printed). Its address holds no credits on any chain, so its Records always fail simulation. The
 * seam may be imported by *.test.ts files under apps/submitter/test only (deps-check `testDirs`).
 */
async function newSmokeAgent(): Promise<SmokeAgent> {
  const seed = randomBytes(32);
  const keyStore = new MemoryKeyStore(seed);
  seed.fill(0);
  const identity = await keyStore.getPublicBundle();
  return { address: identity.agentId, signer: keyStore };
}

declare module 'vitest' {
  export interface ProvidedContext {
    submitterSmokeUrl: string;
  }
}

const configured = inject('submitterSmokeUrl');

describe.skipIf(configured === '')('deploy smoke (deployed submitter)', () => {
  const target = (): SmokeTarget => {
    const base = smokeOrigin(configured);
    if (base === null) throw new Error('SUBMITTER_SMOKE_URL must be a bare https origin');
    // A redirect would leave the submitter: never follow one.
    return { base, fetch: (input, init) => fetch(input, { ...init, redirect: 'manual' }) };
  };

  it('health lists every served chain as available; a simulated notarize on each', async () => {
    const chains = await smokeHealth(target());
    for (const chainId of chains) {
      await smokeSimulatedNotarize(target(), chainId, await newSmokeAgent());
    }
  });

  it('the faucet refuses a mainnet chain ID', async () => {
    await smokeFaucetRefusesMainnet(target(), await newSmokeAgent());
  });
});
