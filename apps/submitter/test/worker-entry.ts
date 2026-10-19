// The submitter Worker as the Miniflare tests run it (M1-10a, M1-10b): the production routes and
// Durable Objects of src/worker.ts, with each chain's port replaced by the in-memory FakeChain of
// fake-chain.ts and each faucet wallet by the FakeFaucet of fake-faucet.ts. Only vitest.config.ts
// names this file as `main`; wrangler.toml deploys src/index.ts, which builds the real ports from
// Worker secrets. The tests and the Worker run in one isolate, so they share the fakes.
import {
  createFaucetClass,
  createQueueClass,
  createSubmitterWorker,
  SubmitterLimits,
} from '../src/worker.js';
import { fakeChains } from './fake-chain.js';
import { fakeFaucets } from './fake-faucet.js';

// The queue's alarm is scheduled an hour ahead, so it never fires on the wall clock during a run:
// it polls only when a test calls runDurableObjectAlarm. One queue instance serves the whole file
// and keeps earlier tests' items, so a wall-clock alarm could race a test's own alarm run.
const deps = {
  portFor: (_env: unknown, chainId: number) => fakeChains.get(chainId) ?? null,
  faucetFor: (_env: unknown, chainId: number) => fakeFaucets.get(chainId) ?? null,
  pollMs: 3_600_000,
};

export default createSubmitterWorker(deps);
export const SubmitterQueue = createQueueClass(deps);
export const SubmitterFaucet = createFaucetClass(deps);
export { SubmitterLimits };
