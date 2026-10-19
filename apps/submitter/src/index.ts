// The submitter Worker's entry point (07 §7; M1-10a): the routes and Durable Objects of worker.ts
// over the real chain port of @4thtech-io/chain, built from this Worker's secrets.
//
// Per served chain (SUBMITTER_CHAINS), the owner sets with `wrangler secret put` (M1-10c):
//   SUBMITTER_GAS_KEY_<chainId>   the gas key, 0x + 64 lowercase hex (a hot key, low balance)
//   SUBMITTER_RPC_URLS_<chainId>  optional: comma-separated RPC URLs; default: the shipped ones
// A chain without its gas key is unavailable (503, health `available: false`); nothing else is
// affected. SUBMITTER_MAX_FEE_PER_GAS_WEI (a var) caps every transaction's fee. The key is read only here, handed to the port and never logged or returned.
//
// Per faucet chain (SUBMITTER_FAUCET_CHAINS; testnets only, M1-10b), the owner sets:
//   SUBMITTER_FAUCET_KEY_<chainId> the faucet key, 0x + 64 lowercase hex: its own key, never the
//                                  gas key (a faucet key equal to the gas key is refused)
// A chain without its faucet key has no faucet (503); the submitter is not affected.
import {
  createFaucetChain,
  createSubmitterChain,
  getChainConfig,
  type FaucetChain,
  type SubmitterChain,
} from '@4thtech-io/chain';
import {
  SubmitterLimits,
  createFaucetClass,
  createQueueClass,
  createSubmitterWorker,
  readConfig,
} from './worker.js';

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
  const maxFee = readConfig(vars)?.maxFeePerGasWei ?? null;
  let port: SubmitterChain | null = null;
  if (config && typeof gasKey === 'string') {
    try {
      port = createSubmitterChain(config, {
        fetchFn: (input: string, init: never) => fetch(input, init),
        gasKey,
        ...(maxFee === null ? {} : { maxFeePerGasWei: maxFee }),
        ...(typeof rpcRaw === 'string' && rpcRaw !== '' ? { rpcUrls: rpcRaw.split(',') } : {}),
      });
    } catch {
      port = null; // a malformed key or RPC URL: unavailable, with no detail anywhere
    }
  }
  ports.set(chainId, port);
  return port;
}

/** One faucet wallet per chain per isolate; a changed secret starts a new isolate. */
const faucets = new Map<number, FaucetChain | null>();

function faucetFor(env: unknown, chainId: number): FaucetChain | null {
  if (faucets.has(chainId)) return faucets.get(chainId) ?? null;
  const vars = env as Record<string, unknown>;
  const faucetKey = vars[`SUBMITTER_FAUCET_KEY_${String(chainId)}`];
  const gasKey = vars[`SUBMITTER_GAS_KEY_${String(chainId)}`];
  const rpcRaw = vars[`SUBMITTER_RPC_URLS_${String(chainId)}`];
  const config = getChainConfig(chainId);
  const maxFee = readConfig(vars)?.maxFeePerGasWei ?? null;
  let faucet: FaucetChain | null = null;
  if (config && typeof faucetKey === 'string' && faucetKey !== gasKey) {
    try {
      faucet = createFaucetChain(config, {
        fetchFn: (input: string, init: never) => fetch(input, init),
        faucetKey,
        ...(maxFee === null ? {} : { maxFeePerGasWei: maxFee }),
        ...(typeof rpcRaw === 'string' && rpcRaw !== '' ? { rpcUrls: rpcRaw.split(',') } : {}),
      });
    } catch {
      faucet = null; // not a faucet chain, a malformed key or RPC URL: no faucet, no detail anywhere
    }
  }
  faucets.set(chainId, faucet);
  return faucet;
}

const deps = { portFor, faucetFor };

export default createSubmitterWorker(deps);
export const SubmitterQueue = createQueueClass(deps);
export const SubmitterFaucet = createFaucetClass(deps);
export { SubmitterLimits };
