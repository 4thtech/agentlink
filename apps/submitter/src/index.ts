// The submitter Worker's entry point (07 §7; M1-10a): the routes and Durable Objects of worker.ts
// over the real chain port of @4thtech-io/chain, built from this Worker's secrets.
//
// Per served chain (SUBMITTER_CHAINS), the owner sets with `wrangler secret put` (M1-10c):
//   SUBMITTER_GAS_KEY_<chainId>   the gas key, 0x + 64 lowercase hex (a hot key, low balance)
//   SUBMITTER_RPC_URLS_<chainId>  optional: comma-separated RPC URLs; default: the shipped ones
// A chain without its gas key is unavailable (503, health `available: false`); nothing else is
// affected. The key is read only here, handed to the port and never logged or returned.
import { createSubmitterChain, getChainConfig, type SubmitterChain } from '@4thtech-io/chain';
import { SubmitterLimits, createQueueClass, createSubmitterWorker } from './worker.js';

export const packageName = '@4thtech-io/submitter';
export * from './worker.js';

/** One port per chain per isolate; a changed secret starts a new isolate. */
const ports = new Map<number, SubmitterChain | null>();

function portFor(env: unknown, chainId: number): SubmitterChain | null {
  if (ports.has(chainId)) return ports.get(chainId) ?? null;
  const vars = env as Record<string, unknown>;
  const gasKey = vars[`SUBMITTER_GAS_KEY_${String(chainId)}`];
  const rpcRaw = vars[`SUBMITTER_RPC_URLS_${String(chainId)}`];
  const config = getChainConfig(chainId);
  let port: SubmitterChain | null = null;
  if (config && typeof gasKey === 'string') {
    try {
      port = createSubmitterChain(config, {
        fetchFn: (input: string, init: never) => fetch(input, init),
        gasKey,
        ...(typeof rpcRaw === 'string' && rpcRaw !== '' ? { rpcUrls: rpcRaw.split(',') } : {}),
      });
    } catch {
      port = null; // a malformed key or RPC URL: unavailable, with no detail anywhere
    }
  }
  ports.set(chainId, port);
  return port;
}

const deps = { portFor };

export default createSubmitterWorker(deps);
export const SubmitterQueue = createQueueClass(deps);
export { SubmitterLimits };
