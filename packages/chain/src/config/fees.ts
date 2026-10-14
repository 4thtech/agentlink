// The USD fee schedule (12 §2, §4.1; 05 §2.2; D-45, D-46) and its token amounts.
//
// Every launch fee token is a USD stablecoin valued at $1, so a fee in token units is exactly
// USD × 10^decimals: the same USD value on every chain and for every token. The on-chain values are
// set by the deploy configuration (occ-v2-contracts script/config, M1-14) and read back with
// `OCCFeeVault.quote` (M1-4b); this schedule is the published reference the config is checked against.

/** Micro-dollars per dollar (USD amounts carry 6 decimals, see @agentlink/types `usd`). */
export const USD_MICROS = 1_000_000n;

/** Configured fee types at launch. `ANCHOR`, `DEAL` and `DISCLOSE` are not offered yet (fee and cap 0). */
export type ConfiguredFeeType = 'NOTARIZE' | 'REGISTER';

/** The beta schedule in micro-dollars. */
export const FEE_SCHEDULE_USD_MICROS = Object.freeze({
  /** Proof: one notarized record including up to 3 receipts, $0.10. */
  NOTARIZE: Object.freeze({ fee: 100_000n, cap: 500_000n }),
  /** Verified registration, $5 one-time per agent per key epoch. */
  REGISTER: Object.freeze({ fee: 5_000_000n, cap: 25_000_000n }),
} as const);

/** Minimum gasless deposit, $5 (12 §4.1, proposed; confirmed for mainnet in M3-3). */
export const MIN_DEPOSIT_USD_MICROS = 5_000_000n;

/** Integrator fee cap as a multiple of the protocol fee (05 §2.2); never above 10. */
export const INTEGRATOR_FEE_CAP_MULTIPLE = 4;

/** Converts micro-dollars to token units of a $1 stablecoin with `decimals` (6 to 18). */
export function usdMicrosToTokenUnits(micros: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 6 || decimals > 18) {
    throw new RangeError(`unsupported fee-token decimals: ${String(decimals)}`);
  }
  return micros * 10n ** BigInt(decimals - 6);
}

/** The protocol fee and cap of `feeType` in token units, for a token with `decimals`. */
export function feeInTokenUnits(
  feeType: ConfiguredFeeType,
  decimals: number,
): { fee: bigint; cap: bigint } {
  const s = FEE_SCHEDULE_USD_MICROS[feeType];
  return {
    fee: usdMicrosToTokenUnits(s.fee, decimals),
    cap: usdMicrosToTokenUnits(s.cap, decimals),
  };
}
