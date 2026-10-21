// M1-10c: the deploy smoke test (test/smoke-steps.ts) against the Worker under Miniflare (workerd),
// on every `pnpm test`. The same steps run against the deployed staging Worker in the deploy
// workflow (test/smoke-remote.test.ts). The chain is the in-memory FakeChain with real signature
// checks; like the Notary for an agent without credits, its simulation refuses every smoke Record.
// Nothing here is a real secret: the IP key is the fixed test key of vitest.config.ts and every
// agent key is random.
import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getChainConfig, type Hex, type ItemSimulation } from '@4thtech-io/chain';
import { FakeChain, fakeChains } from './fake-chain.js';
import { randomBytes } from '@4thtech-io/crypto';
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import {
  SmokeFailure,
  smokeAll,
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

const CHAIN_ID = 84532;
const config = getChainConfig(CHAIN_ID);
if (!config) throw new Error('test setup: no Base Sepolia deployment');
const NOTARY = config.contracts.notary as Hex;

let ipCounter = 0;
/** A distinct client IP per test, so the per-IP limits never carry over. */
function target(): SmokeTarget {
  ipCounter += 1;
  return {
    base: 'https://submitter.test',
    fetch: (input, init) => SELF.fetch(input, init),
    headers: { 'cf-connecting-ip': `192.0.2.${String(100 + ipCounter)}` },
  };
}

/** The Notary's answer for a fresh agent with no credits and maxFee 0. */
const noCredits = (): Promise<ItemSimulation> =>
  Promise.resolve({ outcome: 'failed', error: 'InsufficientCredits' });

let chain: FakeChain;
beforeEach(() => {
  chain = new FakeChain(CHAIN_ID, NOTARY);
  chain.signatureCheck = 'real';
  chain.simulateItem = noCredits;
  fakeChains.set(CHAIN_ID, chain);
});

describe('deploy smoke (local Worker)', () => {
  it('health answers with every served chain available', async () => {
    expect(await smokeHealth(target())).toEqual([CHAIN_ID]);
  });

  it('a simulated notarize reaches the chain and sends nothing', async () => {
    const error = await smokeSimulatedNotarize(target(), CHAIN_ID, await newSmokeAgent());
    expect(error).toBe('InsufficientCredits');
    expect(chain.sent).toHaveLength(0);
  });

  it('the faucet refuses a mainnet chain ID', async () => {
    await smokeFaucetRefusesMainnet(target(), await newSmokeAgent());
  });

  it('runs every step in order', async () => {
    await smokeAll(target(), newSmokeAgent);
    expect(chain.sent).toHaveLength(0);
  });
});

describe('deploy smoke negative controls', () => {
  it('fails when the simulation would accept the record (it must never be sent)', async () => {
    chain.simulateItem = (): Promise<ItemSimulation> =>
      Promise.resolve({ outcome: 'ok', gas: 160_000n });
    const error = await smokeSimulatedNotarize(target(), CHAIN_ID, await newSmokeAgent()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SmokeFailure);
    expect(String(error)).toMatch(/accepted for sending/);
  });

  it('fails when the signature is refused locally (the simulation did not run)', async () => {
    const agent = await newSmokeAgent();
    const other = await newSmokeAgent();
    const error = await smokeSimulatedNotarize(target(), CHAIN_ID, {
      address: agent.address,
      signer: other.signer,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmokeFailure);
    expect(String(error)).toMatch(/InvalidSignature: the simulation did not reach the chain/);
  });

  it('fails when a chain is unavailable, without a URL in the message', async () => {
    fakeChains.delete(CHAIN_ID);
    const error = await smokeHealth(target()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmokeFailure);
    expect(String(error)).not.toMatch(/https?:|\/v1\//);
  });
});

describe('smokeOrigin', () => {
  it('accepts a bare https origin only', () => {
    expect(smokeOrigin('https://agentlink-submitter-staging.example.workers.dev')).toBe(
      'https://agentlink-submitter-staging.example.workers.dev',
    );
    expect(smokeOrigin('https://submit.example/')).toBe('https://submit.example');
    expect(smokeOrigin('http://submit.example')).toBeNull();
    expect(smokeOrigin('https://submit.example/v1')).toBeNull();
    expect(smokeOrigin('https://submit.example?x=1')).toBeNull();
    expect(smokeOrigin('https://user:pw@submit.example')).toBeNull();
    expect(smokeOrigin('not a url')).toBeNull();
  });
});
