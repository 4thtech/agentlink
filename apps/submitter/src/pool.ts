// The faucet and gas pool states (M1-10b-e): what `/v1/health` reports per chain and what the
// scheduled pool alert (.github/workflows/submitter-pool.yml) acts on. Only these words leave the
// Worker: never a faucet balance or address (balances are public on-chain anyway).
import type { FaucetBalances, FaucetPoolState, GasPoolState } from '@4thtech-io/chain';
import type { PoolThresholds } from './config.js';

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

/**
 * - `paused`: the faucet cannot cover one grant of `grantUsdCents`, or its balances are unknown
 *   (no wallet, an RPC failure); it grants nothing.
 * - `low`: under the chain's faucet threshold, or its own gas is under the gas threshold.
 * - `ok`: otherwise.
 */
export function faucetPoolState(
  balances: FaucetBalances | null,
  grantUsdCents: number,
  thresholds: PoolThresholds | null,
): FaucetPoolState {
  if (balances === null || balances.tokenUsdCents < BigInt(grantUsdCents)) return 'paused';
  if (thresholds === null) return 'ok';
  if (balances.tokenUsdCents < BigInt(thresholds.faucetLowUsdCents)) return 'low';
  if (balances.nativeWei < thresholds.gasLowWei) return 'low';
  return 'ok';
}

/** `low` under the chain's gas threshold; null when the balance is unknown or there is none. */
export function gasPoolState(
  gasBalanceWei: string | null,
  thresholds: PoolThresholds | null,
): GasPoolState | null {
  if (gasBalanceWei === null || thresholds === null || !DECIMAL.test(gasBalanceWei)) return null;
  return BigInt(gasBalanceWei) < thresholds.gasLowWei ? 'low' : 'ok';
}
