// The fee tokens the client prices, shows credits for and deposits (D-46; 07 §6.1; 12 §3).
//
// A token is offered only when the chain's shipped config lists it AND it passes the launch
// allowlist again here: a USD stablecoin (USDC, USDT) with a contract address, or the native coin
// only on Gnosis chain IDs (xDAI). A hand-made or corrupted config cannot slip in a volatile coin.
import {
  GNOSIS_CHAIN_IDS,
  type Address,
  type ChainConfig,
  type FeeToken,
  type FeeTokenSymbol,
} from '../config/index.js';
import { ChainInputError } from '../ids/index.js';

/** The vault's key for the native coin (05 §2.2: `address(0)`). */
export const NATIVE_TOKEN_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** True when `t` is a launch fee token on `chainId` (D-46). */
function allowlisted(chainId: number, t: FeeToken): boolean {
  if (!Number.isInteger(t.decimals) || t.decimals < 6 || t.decimals > 18) return false;
  if (t.symbol === 'NATIVE') {
    return t.address === null && t.decimals === 18 && GNOSIS_CHAIN_IDS.includes(chainId);
  }
  return (
    (t.symbol === 'USDC' || t.symbol === 'USDT') &&
    typeof t.address === 'string' &&
    ADDRESS.test(t.address)
  );
}

/** A fee token as the vault sees it. */
export interface OfferedToken {
  readonly token: FeeToken;
  /** The token's address in vault calls: `address(0)` for the native coin. */
  readonly vaultAddress: Address;
}

/** The offered fee tokens of a chain, in config order; anything off the allowlist is left out. */
export function offeredTokens(config: ChainConfig): OfferedToken[] {
  return config.feeTokens
    .filter((t) => allowlisted(config.chainId, t))
    .map((token) => ({ token, vaultAddress: token.address ?? NATIVE_TOKEN_ADDRESS }));
}

/** The offered token with `symbol`, or a `fee_token_not_offered` ChainInputError. */
export function offeredToken(config: ChainConfig, symbol: FeeTokenSymbol): OfferedToken {
  const match = offeredTokens(config).find((o) => o.token.symbol === symbol);
  if (match === undefined) {
    throw new ChainInputError(
      'fee_token_not_offered',
      `chain ${String(config.chainId)}: that fee token is not offered`,
    );
  }
  return match;
}

/** The offered token whose vault address is `address`, if any. */
export function offeredTokenAt(config: ChainConfig, address: string): OfferedToken | undefined {
  const lower = address.toLowerCase();
  return offeredTokens(config).find((o) => o.vaultAddress === lower);
}
