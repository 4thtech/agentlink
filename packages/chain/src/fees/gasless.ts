// The gasless top-up, agent side (12 §4.1 "gasless USDC"; 05 §2.5; 03 §4.4; 07 §7; D-123;
// M3-4b-t-2). The agent turns test USDC already at its own address into its own credits: it signs an
// EIP-3009 `ReceiveWithAuthorization` with its EVM key, and a submitter redeems it through the
// vault's `depositWithAuthorization`, paying the network cost.
//
// This module is the one chokepoint for that signature (the KeyStore's sign712 signs any typed data,
// so the rules live here, not in the KeyStore):
// - `from` is the agent's own address, read from the KeyStore; the signature must recover to it,
//   so only the agent EVM key signs (never the owner key; owner decision 2026-10-23).
// - `to` is the fee vault of the shipped chain registry (`getChainConfig`, composed from the pinned
//   @4thtech-io/occ-v2-abi release), never a parameter. A chain config that names another vault is
//   refused (`not_vault`). Payee = vault, so front-running cannot redirect the funds (05 §2.5).
// - The token must carry `eip3009` both in the caller's config and in the shipped registry, which
//   composes it from the token flag AND the deployed vault's `depositWithAuthorization` capability
//   (07 §6.1; false until M3-4b-t-0 imports the release that has it). Testnets only, and only the
//   chains in `GASLESS_CHAIN_IDS` (Base Sepolia); mainnet IDs are refused outright in this slice.
// - The token's EIP-712 domain is read from chain (EIP-5267 `eip712Domain()`, else `name()`,
//   `version()` and `DOMAIN_SEPARATOR()`) and checked by @4thtech-io/crypto `verifyTokenDomain`
//   against the configured chain ID and token address. It is never hard-coded.
// - The value is at least $5 and at least the vault's `minDeposit(token)`, at most $50 (testnet cap,
//   owner decision 2026-10-23) and at most the agent's token balance.
// - `validAfter` is 0 and `validBefore` is now + 15 minutes (60 s to 1 h as an option). A positive
//   `validAfter` would only add clock-skew failures: the payee is fixed and the nonce single use.
// - The nonce is 32 bytes from the crypto CSPRNG (@4thtech-io/crypto randomBytes).
// - Only `ReceiveWithAuthorization` is ever built (crypto has no `TransferWithAuthorization`).
// Errors carry fixed codes and text: never an address, an amount, a signature or a URL (I-7).
import {
  CryptoInputError,
  decodeEcdsaSignature,
  encodeHex0x,
  hashTypedData,
  randomBytes,
  receiveWithAuthorizationTypedData,
  recoverEvmAddress,
  verifyTokenDomain,
  type KeyStore,
  type TokenDomain,
} from '@4thtech-io/crypto';
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import type { ChainConfig, FeeTokenSymbol } from '../config/index.js';
import { ChainError } from '../clients/errors.js';
import type { ReadClient } from '../clients/read-client.js';
import { getChainConfig } from '../clients/registry.js';
import type { ChainState } from '../clients/state.js';
import { ChainInputError, type Hex } from '../ids/index.js';
import type {
  DepositAuthorizationAuth,
  DepositAuthorizationRequest,
} from '../submitter/deposit-auth.js';
import { offeredTokens } from './tokens.js';

/** The chains with a gasless top-up: Base Sepolia only in this testnet slice (D-123). */
export const GASLESS_CHAIN_IDS: readonly number[] = Object.freeze([84532]);
/** The least one gasless top-up may be, in US cents ($5; also never below the vault minDeposit). */
export const GASLESS_MIN_USD_CENTS = 500;
/** The most one gasless top-up may be on testnet, in US cents ($50). */
export const GASLESS_MAX_USD_CENTS = 5_000;
/** How long a signed authorization stays valid by default, in seconds (15 minutes). */
export const GASLESS_WINDOW_SECONDS = 900;
/**
 * The longest window the builder signs, in seconds. The relay refuses a `validBefore` later than
 * now + this + DEPOSIT_AUTH_CLOCK_SKEW_SECONDS, so the two cannot disagree (M3-4b-t-T2-b).
 */
export const GASLESS_MAX_WINDOW_SECONDS = GASLESS_WINDOW_SECONDS;
const GASLESS_MIN_WINDOW_SECONDS = 60;

const MAX_UINT256 = 2n ** 256n - 1n;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

/** One `eth_call` to `to` with `data` at the latest block; the raw return data. */
export type EthCall = (to: Hex, data: Hex) => Promise<Hex>;

/** An EthCall over a read client (its rejections are already URL-free ChainErrors). */
export function readClientEthCall(client: Pick<ReadClient, 'call'>): EthCall {
  return async (to, data) => {
    const { data: out } = await client.call({ to, data });
    if (typeof out !== 'string') throw new ChainError('bad_answer');
    return out;
  };
}

// EIP-3009 / EIP-5267 / ERC-20 views of the token (standard interfaces, not the OCC ABI).
const TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

type TokenFunction =
  'name' | 'version' | 'DOMAIN_SEPARATOR' | 'eip712Domain' | 'authorizationState';

async function tokenRead(
  ethCall: EthCall,
  token: Hex,
  functionName: TokenFunction,
  args: readonly unknown[] = [],
): Promise<unknown> {
  const data = encodeFunctionData({ abi: TOKEN_ABI, functionName, args } as never) as Hex;
  const out = await ethCall(token, data);
  try {
    return decodeFunctionResult({ abi: TOKEN_ABI, functionName, data: out } as never);
  } catch {
    throw new ChainError('bad_answer');
  }
}

/** The gasless deployment of one token: the shipped vault (payee) and the token. */
export interface GaslessToken {
  readonly chainId: number;
  readonly symbol: FeeTokenSymbol;
  /** The token contract, lowercase. */
  readonly token: Hex;
  readonly decimals: number;
  /** The shipped fee vault of the chain, lowercase: the only payee ever signed. */
  readonly vault: Hex;
}

const unavailable = (): never => {
  throw new ChainInputError(
    'gasless_unavailable',
    'no gasless top-up for that token on this chain',
  );
};

/**
 * The gasless deployment for `token` (a symbol, or the token address) on `config`'s chain, checked
 * against the shipped registry. Refuses `unsupported_chain` (not a gasless testnet), `not_vault`
 * (the config names another vault) or `gasless_unavailable` (no eip3009 token there, in the config
 * or in the registry). Reads nothing from the chain.
 */
export function gaslessToken(config: ChainConfig, token: FeeTokenSymbol | string): GaslessToken {
  const chainId = config.chainId;
  if (config.testnet !== true || !GASLESS_CHAIN_IDS.includes(chainId)) {
    throw new ChainInputError('unsupported_chain', 'no gasless top-up on this chain');
  }
  const shipped = getChainConfig(chainId);
  if (shipped?.testnet !== true) {
    throw new ChainInputError('unsupported_chain', 'no gasless top-up on this chain');
  }
  const vault = shipped.contracts.vault.toLowerCase();
  if (!EVM_ADDRESS.test(vault) || String(config.contracts.vault).toLowerCase() !== vault) {
    throw new ChainInputError('not_vault', 'the chain config does not name the shipped fee vault');
  }
  const want = typeof token === 'string' ? token.toLowerCase() : '';
  const find = (c: ChainConfig) =>
    offeredTokens(c).find(
      (o) => o.token.address !== null && (o.token.symbol === token || o.vaultAddress === want),
    );
  const mine = find(config);
  const theirs = find(shipped);
  if (
    mine === undefined ||
    theirs === undefined ||
    mine.token.eip3009 !== true ||
    theirs.token.eip3009 !== true ||
    mine.vaultAddress !== theirs.vaultAddress ||
    mine.token.decimals !== theirs.token.decimals ||
    mine.token.symbol !== theirs.token.symbol
  ) {
    return unavailable();
  }
  return Object.freeze({
    chainId,
    symbol: theirs.token.symbol,
    token: theirs.vaultAddress as Hex,
    decimals: theirs.token.decimals,
    vault: vault as Hex,
  });
}

/** The $5 and $50 bounds in base units of a $1 token with `decimals` (6 to 18). */
export function gaslessValueBounds(decimals: number): {
  readonly min: bigint;
  readonly max: bigint;
} {
  if (!Number.isInteger(decimals) || decimals < 6 || decimals > 18) {
    throw new ChainInputError('invalid_amount', 'fee-token decimals: an integer from 6 to 18');
  }
  const centUnit = 10n ** BigInt(decimals - 2);
  return Object.freeze({
    min: BigInt(GASLESS_MIN_USD_CENTS) * centUnit,
    max: BigInt(GASLESS_MAX_USD_CENTS) * centUnit,
  });
}

/**
 * The token's EIP-712 domain, read from chain and checked by `verifyTokenDomain` against the
 * configured chain ID and token address. EIP-5267 `eip712Domain()` first; a token without it (any
 * failure of that call) is read through `name()`, `version()` and `DOMAIN_SEPARATOR()`, whose
 * recomputed separator must match. A mismatch is ChainInputError `token_domain_mismatch`; an
 * answer that does not decode is ChainError `bad_answer`.
 */
export async function readTokenDomain(
  ethCall: EthCall,
  token: Pick<GaslessToken, 'chainId' | 'token'>,
): Promise<TokenDomain> {
  const expected = { chainId: token.chainId, verifyingContract: token.token };
  let reading: Record<string, unknown> | undefined;
  try {
    const [fields, name, version, chainId, verifyingContract, salt, extensions] = (await tokenRead(
      ethCall,
      token.token,
      'eip712Domain',
    )) as readonly unknown[];
    reading = {
      source: 'eip5267',
      fields: typeof fields === 'string' ? fields.toLowerCase() : fields,
      name,
      version,
      chainId,
      verifyingContract:
        typeof verifyingContract === 'string' ? verifyingContract.toLowerCase() : verifyingContract,
      salt: typeof salt === 'string' ? salt.toLowerCase() : salt,
      extensions: Array.isArray(extensions) ? [...(extensions as unknown[])] : extensions,
    };
  } catch {
    reading = undefined;
  }
  if (reading === undefined) {
    const name = await tokenRead(ethCall, token.token, 'name');
    const version = await tokenRead(ethCall, token.token, 'version');
    const separator = await tokenRead(ethCall, token.token, 'DOMAIN_SEPARATOR');
    reading = {
      source: 'domainSeparator',
      name,
      version,
      domainSeparator: typeof separator === 'string' ? separator.toLowerCase() : separator,
    };
  }
  try {
    return verifyTokenDomain(expected, reading);
  } catch (error) {
    if (error instanceof CryptoInputError && error.code === 'token_domain_mismatch') {
      throw new ChainInputError(
        'token_domain_mismatch',
        'the token signing domain on chain does not match the configured token',
      );
    }
    throw new ChainError('bad_answer');
  }
}

/** The token's `authorizationState(authorizer, nonce)`: true once that nonce was used. */
export async function readAuthorizationUsed(
  ethCall: EthCall,
  token: Hex,
  authorizer: Hex,
  nonce: Hex,
): Promise<boolean> {
  const used = await tokenRead(ethCall, token, 'authorizationState', [authorizer, nonce]);
  if (typeof used !== 'boolean') throw new ChainError('bad_answer');
  return used;
}

/**
 * The address that signed `auth` as a `ReceiveWithAuthorization` under `domain`, lowercase, or
 * null when the authorization or its signature is malformed or non-canonical (04 §2.4.1).
 */
export function recoverAuthorizationSigner(
  domain: TokenDomain,
  auth: DepositAuthorizationAuth,
): Hex | null {
  try {
    const td = receiveWithAuthorizationTypedData(domain, {
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    });
    if (
      (auth.v !== 27 && auth.v !== 28) ||
      !BYTES32.test(String(auth.r)) ||
      !BYTES32.test(String(auth.s))
    ) {
      return null;
    }
    const signature = decodeEcdsaSignature(
      `0x${auth.r.slice(2)}${auth.s.slice(2)}${auth.v.toString(16)}`,
    );
    return encodeHex0x(recoverEvmAddress(hashTypedData(td).digest, signature)) as Hex;
  } catch {
    return null;
  }
}

/** The KeyStore methods the builder uses: the agent's address and its EIP-712 signer. */
export type GaslessSigner = Pick<KeyStore, 'getPublicBundle' | 'sign712'>;

export interface GaslessTopUpRequest {
  readonly token: FeeTokenSymbol;
  /** Base units of the token. */
  readonly value: bigint;
}

export interface BuildGaslessOptions {
  /** Reads the token (domain) on the same chain as `state`. */
  readonly ethCall: EthCall;
  /** The current time in seconds (tests); default the system clock. */
  readonly nowSeconds?: () => number;
  /** Seconds until `validBefore`: 60 to GASLESS_MAX_WINDOW_SECONDS (900), default GASLESS_WINDOW_SECONDS. */
  readonly windowSeconds?: number;
}

/**
 * Builds and signs the agent's `ReceiveWithAuthorization` for a gasless top-up of `value` (see the
 * module comment for every rule), and returns the `POST /v1/deposit-authorization` request. Every
 * check runs before the KeyStore is asked to sign; the signature must recover to the agent.
 * Refusals are ChainInputErrors (`invalid_amount`, `invalid_option`, `unsupported_chain`,
 * `not_vault`, `gasless_unavailable`, `below_min_deposit`, `above_max_top_up`,
 * `insufficient_balance`, `token_domain_mismatch`) or ChainErrors (`invalid_call` for an agent
 * identity that is not an EVM address, `signer_mismatch` when the signature is not the agent's,
 * and read failures).
 */
export async function buildReceiveWithAuthorization(
  state: ChainState,
  signer: GaslessSigner,
  request: GaslessTopUpRequest,
  options: BuildGaslessOptions,
): Promise<DepositAuthorizationRequest> {
  const value = request.value;
  if (typeof value !== 'bigint' || value <= 0n || value > MAX_UINT256) {
    throw new ChainInputError('invalid_amount', 'value: a bigint from 1 to 2^256 - 1');
  }
  const window = options.windowSeconds ?? GASLESS_WINDOW_SECONDS;
  if (
    !Number.isSafeInteger(window) ||
    window < GASLESS_MIN_WINDOW_SECONDS ||
    window > GASLESS_MAX_WINDOW_SECONDS
  ) {
    throw new ChainInputError('invalid_option', 'windowSeconds: an integer from 60 to 900');
  }
  const deployment = gaslessToken(state.config, request.token);
  const bounds = gaslessValueBounds(deployment.decimals);
  if (value < bounds.min) {
    throw new ChainInputError('below_min_deposit', 'value: below the least gasless top-up');
  }
  if (value > bounds.max) {
    throw new ChainInputError(
      'above_max_top_up',
      'value: above the most one gasless top-up may be',
    );
  }

  const { agentId } = await signer.getPublicBundle();
  const from = typeof agentId === 'string' ? agentId.toLowerCase() : '';
  if (!EVM_ADDRESS.test(from)) throw new ChainError('invalid_call');

  const minDeposit = await state.minDeposit(deployment.token);
  if (typeof minDeposit !== 'bigint' || minDeposit < 0n) throw new ChainError('bad_answer');
  if (value < minDeposit) {
    throw new ChainInputError('below_min_deposit', 'value: below the vault minimum deposit');
  }
  const balance = await state.tokenBalance(deployment.token, from as Hex);
  if (typeof balance !== 'bigint' || balance < 0n) throw new ChainError('bad_answer');
  if (value > balance) {
    throw new ChainInputError('insufficient_balance', 'value: more than the agent holds');
  }

  const domain = await readTokenDomain(options.ethCall, deployment);

  const now = (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new ChainInputError('invalid_option', 'nowSeconds: a positive integer');
  }
  const message = Object.freeze({
    from,
    to: deployment.vault,
    value: value.toString(),
    validAfter: '0',
    validBefore: String(now + window),
    nonce: encodeHex0x(randomBytes(32)),
  });
  const typedData = receiveWithAuthorizationTypedData(domain, message);
  // Defence in depth: the typed data the KeyStore sees is exactly the vault-payee authorization.
  if (
    typedData.primaryType !== 'ReceiveWithAuthorization' ||
    (typedData.message as { to?: unknown }).to !== deployment.vault ||
    (typedData.message as { from?: unknown }).from !== from
  ) {
    throw new ChainError('invalid_call');
  }

  const signature = await signer.sign712(typedData);
  let bytes: Uint8Array;
  let recovered: string;
  try {
    bytes = decodeEcdsaSignature(signature);
    recovered = encodeHex0x(recoverEvmAddress(hashTypedData(typedData).digest, bytes));
  } catch {
    throw new ChainError('signer_mismatch');
  }
  if (recovered !== from) throw new ChainError('signer_mismatch');

  const auth: DepositAuthorizationAuth = Object.freeze({
    ...message,
    from: from as Hex,
    to: deployment.vault,
    nonce: message.nonce as Hex,
    v: bytes[64] as 27 | 28,
    r: encodeHex0x(bytes.subarray(0, 32)) as Hex,
    s: encodeHex0x(bytes.subarray(32, 64)) as Hex,
  });
  return Object.freeze({ chainId: deployment.chainId, token: deployment.token, auth });
}
