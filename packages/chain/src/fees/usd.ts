// Token units to USD at 1:1 (D-46; 07 §6.2; 12 §3.1). Every launch fee token is a USD stablecoin,
// so a token amount is shown as dollars with no price source. Display only: never used on-chain.
import { MAX_USD_MICROS, formatUsd } from '@4thtech-io/types';

/**
 * `amount` base units of a $1 token with `decimals` (6 to 18), as a canonical USD string (at most 6
 * decimals). `up` for a fee (never shows less than is charged), `down` for a balance (never shows
 * more than is there). `null` above 999 999 999.999999, which a USD amount cannot spell.
 */
export function tokenUnitsToUsd(
  amount: bigint,
  decimals: number,
  rounding: 'up' | 'down',
): string | null {
  if (typeof amount !== 'bigint' || amount < 0n) {
    throw new RangeError('a token amount is a non-negative bigint');
  }
  if (!Number.isInteger(decimals) || decimals < 6 || decimals > 18) {
    throw new RangeError('fee-token decimals must be an integer from 6 to 18');
  }
  const unit = 10n ** BigInt(decimals - 6);
  const micros = rounding === 'up' ? (amount + unit - 1n) / unit : amount / unit;
  return micros > MAX_USD_MICROS ? null : formatUsd(micros);
}
