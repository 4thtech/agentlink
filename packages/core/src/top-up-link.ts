// The top-up link (M1-26-e; D-111, D-113, 08 §1, 06 §2.1 `topUpUrl`, §2.4 `needs_credits`,
// docs/design/topup-ux.md §5): the one builder for the link to the pay page.
//
//   https://{payHost}/#v=1&a=<agent address, 0x + 40 lowercase hex>&usd=<suggested amount, optional>
//
// - Everything after the `#`: the address and the amount never reach the pay host's server or any
//   CDN log (zero access, 04 §1). The link names no network and no token (D-40).
// - `{payHost}` is configuration: the shipped testing host until the production domain is decided
//   (M2-10, D-28, D-56), passed in by the caller from its shipped config. It is never read from
//   inbound content, a tool argument or an RPC answer. This module never logs and never reads the
//   environment.
// - The builder is strict and returns undefined instead of a link when anything is malformed.
//   The address is the agent's own public address; no key or secret is ever an input.

/** The shipped testing host of the pay page (D-28). Not final: the production domain is M2-10. */
export const TOP_UP_PAY_HOST = 'pay.agentlink.4thtech.io';
/** The pay page's amount presets in US dollars (docs/design/topup-ux.md §2). */
export const TOP_UP_PRESETS_USD: readonly number[] = Object.freeze([5, 10, 25]);
/** The smallest suggested amount: the gasless top-up minimum (12 §4.1, proposed $5). */
export const TOP_UP_MIN_USD = 5;
/** The largest amount a link may suggest (a sanity bound; the user can still change it). */
export const TOP_UP_MAX_USD = 10_000;

const AGENT_ADDRESS = /^0x[0-9a-f]{40}$/;
/** A positive decimal with at most two places and no leading zero, e.g. `5`, `7.5`, `25.00`. */
const USD_AMOUNT = /^[1-9][0-9]{0,4}(\.[0-9]{1,2})?$/;
/** At least two lowercase labels; the last starts with a letter (so no IP address, no `localhost`). */
const PAY_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SHORTFALL = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;
const MICRO = 1_000_000n;

export interface TopUpLinkInput {
  /** The agent's own public address: `0x` plus 40 lowercase hex characters. */
  readonly agentAddress: string;
  /** The suggested amount in US dollars (see `suggestTopUpUsd`); optional. */
  readonly usd?: string;
  /** The pay host from the shipped config; defaults to the shipped testing host. */
  readonly payHost?: string;
}

/** `usd` as micro-dollars when it is a valid amount within the limits, else undefined. */
function amountMicro(usd: string): bigint | undefined {
  if (!USD_AMOUNT.test(usd)) return undefined;
  const [whole = '0', frac = ''] = usd.split('.');
  const micro = BigInt(whole) * MICRO + BigInt((frac + '000000').slice(0, 6));
  return micro >= BigInt(TOP_UP_MIN_USD) * MICRO && micro <= BigInt(TOP_UP_MAX_USD) * MICRO
    ? micro
    : undefined;
}

/**
 * The top-up link (D-113). Undefined when the address, the amount or the host is malformed: a
 * malformed amount is refused, never dropped silently, so a caller's mistake cannot go unseen.
 */
export function buildTopUpLink(input: TopUpLinkInput): string | undefined {
  const host = input.payHost ?? TOP_UP_PAY_HOST;
  if (!PAY_HOST.test(host)) return undefined;
  if (!AGENT_ADDRESS.test(input.agentAddress)) return undefined;
  if (input.usd !== undefined && amountMicro(input.usd) === undefined) return undefined;
  const amount = input.usd === undefined ? '' : `&usd=${input.usd}`;
  return `https://${host}/#v=1&a=${input.agentAddress}${amount}`;
}

/**
 * The suggested amount for a shortfall (08 §1): the shortfall rounded up to the first preset, at
 * least the minimum; above the largest preset, rounded up to a whole dollar. `shortfall` is a USD
 * decimal string (at most 6 places). Undefined when it is not a positive amount or exceeds the
 * largest link amount.
 */
export function suggestTopUpUsd(shortfall: string): string | undefined {
  if (!SHORTFALL.test(shortfall)) return undefined;
  const [whole = '0', frac = ''] = shortfall.split('.');
  const micro = BigInt(whole) * MICRO + BigInt((frac + '000000').slice(0, 6));
  if (micro <= 0n) return undefined;
  const preset = TOP_UP_PRESETS_USD.find((p) => BigInt(p) * MICRO >= micro);
  const dollars = preset ?? Number((micro + MICRO - 1n) / MICRO);
  const usd = Math.max(dollars, TOP_UP_MIN_USD);
  return usd > TOP_UP_MAX_USD ? undefined : String(usd);
}
