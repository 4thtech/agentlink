// USD amounts (04 §2.4.1 "USD amount" row; 06 §3; G-7, G-32).
//
// One spelling: `^(0|[1-9][0-9]{0,8})(\.[0-9]{0,5}[1-9])?$`, a JSON string, never a JSON number. At
// most 6 decimals (USD stablecoin precision) and at most 999 999 999.999999. Every value is compared
// and added as an exact decimal, here as integer micro-dollars in a bigint, never as a binary float.
//
// Paths: policy `proofs.dailyBudgetUSD`, `proofs.perActionMaxUSD`, `commitments.autoAcceptMaxUSD`,
// `commitments.autoAcceptMinUSD`, `contactRules[].proofs.perActionMaxUSD`; CommitmentScope
// `maxFeeUsd`; `approval-request` `action.context.fee.usd`; `ProofStatus.fee` `usd`, `protocolUsd`,
// `integratorUsd`; `agentlink_status` `prices[]`; the budget ledger.
//
// The helpers throw on any input that is not canonical, so a malformed amount can never be read as
// zero or compare as "not above the limit" (fail closed).
import { z } from 'zod';

/** Decimal places of a USD amount. */
export const USD_DECIMALS = 6;
/** Micro-dollars per dollar. */
export const MICROS_PER_USD = 1_000_000n;
/** The largest USD amount, 999 999 999.999999, in micro-dollars. */
export const MAX_USD_MICROS = 999_999_999_999_999n;
/** Micro-dollars per cent. */
const MICROS_PER_CENT = 10_000n;

const USD_AMOUNT = /^(0|[1-9][0-9]{0,8})(\.[0-9]{0,5}[1-9])?$/;

/**
 * A terms price amount (04 §3.4, D-55): `^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`. Trailing zeros are
 * allowed and the length is not bounded here (M1-21 sets the size limits).
 */
const DECIMAL_AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;

/** True when `value` is a USD amount string in its single canonical spelling. */
export function isUsdAmount(value: unknown): value is string {
  return typeof value === 'string' && USD_AMOUNT.test(value);
}

/** A USD amount: a string in the single 04 §2.4.1 spelling. A JSON number is rejected. */
export const usdAmountSchema = z
  .string()
  .regex(
    USD_AMOUNT,
    'must be a USD amount string such as "5" or "0.5": no trailing zero, at most 6 decimals, at most 999999999.999999',
  );

function requireUsd(text: unknown): asserts text is string {
  if (typeof text !== 'string') throw new TypeError('a USD amount must be a string');
  if (!USD_AMOUNT.test(text)) throw new RangeError('not a canonical USD amount');
}

/** The integer digits and the fraction padded to 6 digits, from an already checked decimal string. */
function splitDecimal(text: string): [string, string] {
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  return [whole, fraction.padEnd(USD_DECIMALS, '0')];
}

/** Parses a canonical USD amount to micro-dollars. Throws on any other input. */
export function parseUsd(text: string): bigint {
  requireUsd(text);
  const [whole, fraction] = splitDecimal(text);
  return BigInt(whole) * MICROS_PER_USD + BigInt(fraction);
}

/** Writes micro-dollars in the canonical USD spelling. Throws outside [0, MAX_USD_MICROS]. */
export function formatUsd(micros: bigint): string {
  if (typeof micros !== 'bigint') throw new TypeError('micro-dollars must be a bigint');
  if (micros < 0n || micros > MAX_USD_MICROS) {
    throw new RangeError('USD amount out of range [0, 999999999.999999]');
  }
  const whole = (micros / MICROS_PER_USD).toString();
  const fraction = (micros % MICROS_PER_USD).toString().padStart(USD_DECIMALS, '0');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? whole : `${whole}.${trimmed}`;
}

/** -1, 0 or 1 as `a` is below, equal to or above `b`. Throws if either is not canonical. */
export function compareUsd(a: string, b: string): -1 | 0 | 1 {
  const x = parseUsd(a);
  const y = parseUsd(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** `a + b` in the canonical spelling. Throws if either is not canonical or the sum is out of range. */
export function addUsd(a: string, b: string): string {
  return formatUsd(parseUsd(a) + parseUsd(b));
}

/**
 * The exact sum of USD amounts in micro-dollars, with no upper bound on the sum (the budget ledger's
 * spent amount, 06 §3). Throws if any entry is not canonical: a broken ledger is never an empty sum.
 */
export function sumUsdMicros(amounts: readonly string[]): bigint {
  let total = 0n;
  for (const amount of amounts) total += parseUsd(amount);
  return total;
}

/** Rounds micro-dollars up to whole cents. Throws on a negative value. */
export function roundUpToCents(micros: bigint): bigint {
  if (typeof micros !== 'bigint') throw new TypeError('micro-dollars must be a bigint');
  if (micros < 0n) throw new RangeError('a USD amount is never negative');
  const rest = micros % MICROS_PER_CENT;
  return rest === 0n ? micros : micros + (MICROS_PER_CENT - rest);
}

/**
 * Rounds a USD amount up to whole cents and writes it canonically ("Remember for this contact",
 * 06 §3: a fee of 2.501 becomes "2.51", and $2.50 is "2.5"). Throws if the result is out of range.
 */
export function roundUpUsdToCents(text: string): string {
  return formatUsd(roundUpToCents(parseUsd(text)));
}

/**
 * Compares a terms price amount (04 §3.4: `^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`, any size) with a
 * canonical USD limit, exactly, without overflow: an amount far above every limit is simply above
 * it. Throws if either value is malformed. Positivity, the currency and the payer are the caller's
 * checks (04 §3.4.2 auto-accept).
 */
export function compareDecimalWithUsd(amount: string, usdLimit: string): -1 | 0 | 1 {
  if (typeof amount !== 'string') throw new TypeError('an amount must be a string');
  if (!DECIMAL_AMOUNT.test(amount)) throw new RangeError('not a decimal amount');
  requireUsd(usdLimit);
  const [aWhole, aFraction] = splitDecimal(amount);
  const [bWhole, bFraction] = splitDecimal(usdLimit);
  // Neither has a leading zero, so the longer integer part is the larger one.
  if (aWhole.length !== bWhole.length) return aWhole.length < bWhole.length ? -1 : 1;
  if (aWhole !== bWhole) return aWhole < bWhole ? -1 : 1;
  if (aFraction !== bFraction) return aFraction < bFraction ? -1 : 1;
  return 0;
}
