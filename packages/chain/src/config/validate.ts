// The client-side chain config check (M1-14), mirroring the deploy-side check in occ-v2-contracts
// (script/config/ChainConfig.sol): the stablecoin allowlist (D-46), the native coin only on Gnosis
// chain IDs, a source for every entry, keyless public RPC URLs (07 §6.1) and no duplicate tokens.
import type { ChainNetwork, FeeToken } from './types.js';

/** Gnosis mainnet and Chiado: the only chains whose native coin (xDAI) is a USD stablecoin (D-46). */
export const GNOSIS_CHAIN_IDS: readonly number[] = Object.freeze([100, 10200]);

/** Chain IDs this release supports (03 §7, beta testnets). Mainnets arrive with M3-2a. */
export const SUPPORTED_TESTNET_CHAIN_IDS: readonly number[] = Object.freeze([84532, 10200]);

const STABLECOINS: readonly string[] = Object.freeze(['USDC', 'USDT']);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_RPC_URLS = 2;

/** A config entry that breaks a rule. `code` is stable; the message names the field. */
export class ChainConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChainConfigError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ChainConfigError(code, message);
}

/**
 * The rule shared with the deploy-side check (occ-v2-contracts `ChainConfig._isPlainHttpsUrl`,
 * IR-M1-14-1 L-2): `https://`, then a host that starts with a letter or digit, has only letters,
 * digits, `.` and `-`, and contains a `.`; then an optional `:port` of 1–5 digits; then the end or
 * a `/` path. Nowhere a userinfo `@`, query `?`, fragment `#`, template `$`, backslash, whitespace or
 * control character: the usual places an API key hides. A key inside the path cannot be detected
 * here; review covers it.
 */
export function isKeylessHttpsUrl(url: string): boolean {
  if (/[@?#$\\]/.test(url)) return false;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return false; // whitespace and control characters
  }
  const m = /^https:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)(:[0-9]{1,5})?(\/.*)?$/.exec(url);
  return m !== null && m[1] !== undefined && m[1].includes('.');
}

function checkSource(code: string, field: string, src: { url: string; verifiedOn: string }): void {
  if (!isKeylessHttpsUrl(src.url) || !DATE.test(src.verifiedOn)) {
    fail(code, `${field}: needs an https source URL and a YYYY-MM-DD verification date`);
  }
}

function checkToken(chainId: number, t: FeeToken): void {
  const isNative = t.symbol === 'NATIVE' || t.address === null;
  if (isNative) {
    // A native coin is a fee token only where it is a USD stablecoin: xDAI on Gnosis (D-46).
    if (!GNOSIS_CHAIN_IDS.includes(chainId)) {
      fail(
        'native_outside_gnosis',
        `chain ${String(chainId)}: a native coin is not a launch fee token`,
      );
    }
    if (t.symbol !== 'NATIVE' || t.address !== null || t.decimals !== 18 || t.eip3009 === true) {
      fail(
        'native_mismatch',
        `${t.symbol}: the native entry is NATIVE, address null, 18 decimals, no EIP-3009`,
      );
    }
  } else {
    if (!STABLECOINS.includes(t.symbol)) {
      fail('token_not_allowlisted', `${String(t.symbol)}: not in the stablecoin allowlist (D-46)`);
    }
    if (t.address === null || !ADDRESS.test(t.address)) {
      fail('bad_address', `${t.symbol}: address must be 0x + 40 lowercase hex`);
    }
  }
  if (!Number.isInteger(t.decimals) || t.decimals < 6 || t.decimals > 18) {
    fail('bad_decimals', `${t.symbol}: decimals must be an integer from 6 to 18`);
  }
  checkSource('missing_issuer_source', `${t.symbol}.source`, t.source);
}

/** Throws a `ChainConfigError` unless `n` is a valid launch-testnet entry. */
export function validateChainNetwork(n: ChainNetwork): void {
  if (!SUPPORTED_TESTNET_CHAIN_IDS.includes(n.chainId)) {
    fail('unsupported_chain', `chain ${String(n.chainId)} is not supported by this release`);
  }
  if (!n.testnet) fail('not_testnet', `chain ${String(n.chainId)}: launch testnets only`);
  if (n.rpcUrls.length < MIN_RPC_URLS) {
    fail(
      'too_few_rpc_urls',
      `chain ${String(n.chainId)}: needs at least ${String(MIN_RPC_URLS)} RPC URLs`,
    );
  }
  for (const url of n.rpcUrls) {
    if (!isKeylessHttpsUrl(url))
      fail('bad_rpc_url', `chain ${String(n.chainId)}: RPC URL must be keyless https`);
  }
  if (!isKeylessHttpsUrl(n.explorer))
    fail('bad_explorer', `chain ${String(n.chainId)}: explorer must be https`);
  if (!Number.isInteger(n.confirmations) || n.confirmations < 1) {
    fail(
      'bad_confirmations',
      `chain ${String(n.chainId)}: confirmations must be a positive integer`,
    );
  }
  if (typeof n.finalizedTag !== 'boolean') {
    fail('bad_finalized_tag', `chain ${String(n.chainId)}: finalizedTag must be true or false`);
  }
  checkSource('missing_source', `chain ${String(n.chainId)}.source`, n.source);
  if (n.feeTokens.length === 0) fail('no_fee_tokens', `chain ${String(n.chainId)}: no fee tokens`);
  const seen = new Set<string>();
  const symbols = new Set<string>();
  for (const t of n.feeTokens) {
    checkToken(n.chainId, t);
    const id = t.address ?? 'native';
    if (seen.has(id))
      fail('duplicate_token', `chain ${String(n.chainId)}: ${t.symbol} listed twice`);
    // One token per symbol and chain: the user sees the symbol, so two would be indistinguishable.
    if (symbols.has(t.symbol))
      fail('duplicate_symbol', `chain ${String(n.chainId)}: two ${t.symbol} tokens`);
    seen.add(id);
    symbols.add(t.symbol);
  }
}
