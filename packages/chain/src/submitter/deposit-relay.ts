// The submitter Worker's relay side of a gasless top-up (07 §7 `POST /v1/deposit-authorization`;
// 05 §2.5; 04 §7 gas griefing; M3-4b-t-2). The Worker (apps/submitter, M3-4b-t-3) parses the body,
// calls `check`, and only on `{ok: true}` sends through `send` at its serialised gas-wallet nonce.
//
// - `check` runs every rule before the gas key signs anything, cheapest first, and answers a fixed
//   code (deposit-auth.ts DEPOSIT_AUTH_ERROR_CODES):
//   1. the chain is this one, a gasless testnet (`unsupported_chain`);
//   2. the token is eip3009 in this config AND in the shipped registry (`gasless_unavailable`);
//   3. `auth.to` is the shipped fee vault (`not_vault`);
//   4. $5 ≤ value ≤ $50 (`below_min_deposit`, `above_max_top_up`);
//   5. `validAfter` is in the past and `validBefore` leaves at least a minute but is no further
//      away than the 15-minute window plus clock skew (`expired`, `invalid_window`);
//   6. the signature recovers `from` under the token's domain as read from chain, and `from` has no
//      code: EOAs only (`invalid_signature`; a domain that does not match is `gasless_unavailable`);
//   7. `authorizationState(from, nonce)` is false (`already_used`), so a replay is refused before
//      any simulation or send;
//   8. value ≥ the vault's `minDeposit(token)` (`below_min_deposit`);
//   9. `eth_estimateGas` of `depositWithAuthorization` from the gas wallet succeeds
//      (`simulation_failed`) and simulated gas + 20 % stays within DEPOSIT_AUTH_MAX_GAS
//      (`gas_too_high`, refused, never clamped). The vault itself also refuses an unflagged token,
//      a value below minDeposit and a balance change other than `value` (D-89).
//   A chain or RPC failure throws a fixed-text ChainError (infrastructure, not the request's fault).
// - The relay ABI is a parameter: exactly the vault's `depositWithAuthorization` as 05 §2.5 gives
//   it, plus events and errors (`checkRelayAbi`). M3-4b-t-0 exports it from @4thtech-io/occ-v2-abi
//   (`occFeeVaultRelayAbi`, tag `relay`); the client ABI keeps excluding it (D-89), so an agent can
//   never send it.
// - The gas key is the chain's Worker secret (I-7: never logged, never in an error, never on the
//   returned object); it signs locally through viem's account in this package only (M0-10), as
//   port.ts. The transaction hash is computed locally from the signed bytes.
// - Nothing here logs. The authorization carries no secret, but the Worker keeps aggregate counters
//   only (07 §7, D-109).
import { decodeFunctionResult, encodeFunctionData, keccak256, type Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainConfigError, type ChainConfig } from '../config/index.js';
import { FEE_VAULT_CLIENT_ABI } from '../clients/calls.js';
import { ChainError } from '../clients/errors.js';
import { DEFAULT_RPC_TIMEOUT_MS } from '../clients/read-client.js';
import {
  GASLESS_CHAIN_IDS,
  GASLESS_WINDOW_SECONDS,
  gaslessToken,
  gaslessValueBounds,
  readAuthorizationUsed,
  readTokenDomain,
  recoverAuthorizationSigner,
  type EthCall,
  type GaslessToken,
} from '../fees/gasless.js';
import { ChainInputError, type Hex } from '../ids/index.js';
import {
  parseDepositAuthorizationRequest,
  type DepositAuthErrorCode,
  type DepositAuthorizationRequest,
} from './deposit-auth.js';
import type { SendOptions, SubmitterChainOptions } from './port.js';
import { createRpcCaller, RpcAnswerError, type FetchFn } from './rpc.js';

/** The highest gas limit signed for one `depositWithAuthorization` (simulated gas + margin). */
export const DEPOSIT_AUTH_MAX_GAS = 250_000n;
/** The margin added to the simulated gas, in percent. */
export const DEPOSIT_AUTH_GAS_MARGIN_PERCENT = 20n;
/** An authorization must stay valid at least this long after the check, in seconds. */
export const DEPOSIT_AUTH_MIN_REMAINING_SECONDS = 60;
/** Clock skew allowed between the agent and the Worker, in seconds. */
export const DEPOSIT_AUTH_CLOCK_SKEW_SECONDS = 120;

const GAS_KEY = /^0x[0-9a-f]{64}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;

/** The inputs of `depositWithAuthorization` (05 §2.5), in order. */
const RELAY_INPUTS = Object.freeze([
  'address',
  'address',
  'uint256',
  'uint256',
  'uint256',
  'bytes32',
  'uint8',
  'bytes32',
  'bytes32',
]);

/**
 * Checks the relay ABI: exactly one function, `depositWithAuthorization` with the 05 §2.5 inputs,
 * non-payable, no outputs; other entries only events and errors. Anything else is ChainConfigError
 * `bad_relay_abi`.
 */
export function checkRelayAbi(abi: unknown): Abi {
  const bad = (): never => {
    throw new ChainConfigError(
      'bad_relay_abi',
      'the relay ABI must be depositWithAuthorization only',
    );
  };
  if (!Array.isArray(abi)) return bad();
  const functions = abi.filter(
    (e: unknown) =>
      typeof e !== 'object' ||
      e === null ||
      !['event', 'error'].includes((e as { type?: unknown }).type as string),
  ) as {
    type?: unknown;
    name?: unknown;
    inputs?: unknown;
    outputs?: unknown;
    stateMutability?: unknown;
  }[];
  if (functions.length !== 1) return bad();
  const fn = functions[0] as (typeof functions)[number];
  if (
    fn.type !== 'function' ||
    fn.name !== 'depositWithAuthorization' ||
    fn.stateMutability !== 'nonpayable' ||
    !Array.isArray(fn.outputs) ||
    fn.outputs.length !== 0 ||
    !Array.isArray(fn.inputs) ||
    fn.inputs.length !== RELAY_INPUTS.length ||
    !fn.inputs.every(
      (input: unknown, i) => (input as { type?: unknown } | null)?.type === RELAY_INPUTS[i],
    )
  ) {
    return bad();
  }
  return abi as Abi;
}

/** Calldata of `depositWithAuthorization` carrying exactly `request` (parsed first). */
export function depositAuthorizationCalldata(
  relayAbi: Abi,
  request: DepositAuthorizationRequest,
): Hex {
  const abi = checkRelayAbi(relayAbi);
  const { token, auth } = parseDepositAuthorizationRequest(request);
  return encodeFunctionData({
    abi,
    functionName: 'depositWithAuthorization',
    args: [
      token,
      auth.from,
      BigInt(auth.value),
      BigInt(auth.validAfter),
      BigInt(auth.validBefore),
      auth.nonce,
      auth.v,
      auth.r,
      auth.s,
    ],
  } as never) as Hex;
}

/** The outcome of the relay checks. */
export type DepositRelayCheck =
  | { readonly ok: true; readonly gasLimit: bigint }
  | { readonly ok: false; readonly error: DepositAuthErrorCode };

/** What the Worker needs from one chain to relay gasless top-ups. */
export interface DepositRelayChain {
  readonly chainId: number;
  /** The fee vault (lowercase): the only payee relayed. */
  readonly vault: Hex;
  /** The gas wallet's address (lowercase); public. */
  readonly gasAddress: Hex;
  /**
   * Every relay rule (module comment), at `nowSeconds`. A malformed body throws ChainInputError
   * `invalid_deposit_auth_body`; a chain failure throws a ChainError; nothing is signed or sent.
   */
  check(request: DepositAuthorizationRequest, nowSeconds: number): Promise<DepositRelayCheck>;
  /** The token's `authorizationState(from, nonce)` (idempotency and confirmation). */
  authorizationUsed(request: DepositAuthorizationRequest): Promise<boolean>;
  /** The gas wallet's next nonce, counting the mempool. */
  pendingNonce(): Promise<number>;
  /** The gas wallet's next nonce, counting mined transactions only. */
  latestNonce(): Promise<number>;
  /**
   * Signs and sends one `depositWithAuthorization` with exactly this authorization; returns the
   * locally computed hash. Run `check` first: this re-checks only the chain, the payee and the gas
   * cap (ChainError `invalid_call` otherwise, nothing sent).
   */
  send(request: DepositAuthorizationRequest, options: SendOptions): Promise<Hex>;
  /** A transaction's receipt status; `pending` while there is none. */
  txStatus(txHash: Hex): Promise<'pending' | 'success' | 'reverted'>;
}

export interface DepositRelayOptions extends SubmitterChainOptions {
  /** The vault's relay ABI (M3-4b-t-0: `occFeeVaultRelayAbi`); see checkRelayAbi. */
  readonly relayAbi: unknown;
}

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new ChainError('bad_answer');
  return BigInt(value);
}

/** The relay of one gasless testnet (GASLESS_CHAIN_IDS); anything else is refused at creation. */
export function createDepositRelayChain(
  config: ChainConfig,
  options: DepositRelayOptions,
): DepositRelayChain {
  if (config.testnet !== true || !GASLESS_CHAIN_IDS.includes(config.chainId)) {
    throw new ChainConfigError('unsupported_chain', 'no gasless top-up on this chain');
  }
  const relayAbi = checkRelayAbi(options.relayAbi);
  if (typeof options.gasKey !== 'string' || !GAS_KEY.test(options.gasKey)) {
    // Never echo the key, not even a part of it.
    throw new ChainConfigError('bad_gas_key', 'the gas key must be 0x + 64 lowercase hex');
  }
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(options.gasKey as Hex);
  } catch {
    throw new ChainConfigError('bad_gas_key', 'the gas key is not a valid key');
  }
  const timeout = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new ChainConfigError('bad_client_option', 'timeoutMs: 1 to 30000');
  }
  const rpc = createRpcCaller(
    options.rpcUrls && options.rpcUrls.length > 0 ? options.rpcUrls : config.rpcUrls,
    options.fetchFn as unknown as FetchFn,
    timeout,
  );
  const chainId = config.chainId;
  const vault = config.contracts.vault.toLowerCase() as Hex;
  const gasAddress = account.address.toLowerCase() as Hex;
  let chainChecked = false;

  /** A JSON-RPC call whose every failure is a fixed-text ChainError or RpcAnswerError. */
  const call = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    try {
      return await rpc(method, params);
    } catch (error) {
      if (error instanceof ChainError || error instanceof RpcAnswerError) throw error;
      throw new ChainError('rpc_failed');
    }
  };

  const ethCall: EthCall = async (to, data) => {
    let out: unknown;
    try {
      out = await call('eth_call', [{ to, data }, 'latest']);
    } catch (error) {
      if (error instanceof RpcAnswerError) throw new ChainError('call_reverted');
      throw error;
    }
    if (typeof out !== 'string' || !/^0x[0-9a-fA-F]*$/.test(out))
      throw new ChainError('bad_answer');
    return out as Hex;
  };

  const minDeposit = async (token: Hex): Promise<bigint> => {
    const data = encodeFunctionData({
      abi: FEE_VAULT_CLIENT_ABI,
      functionName: 'minDeposit',
      args: [token],
    } as never) as Hex;
    const out = await ethCall(vault, data);
    try {
      const value = decodeFunctionResult({
        abi: FEE_VAULT_CLIENT_ABI,
        functionName: 'minDeposit',
        data: out,
      } as never) as unknown;
      if (typeof value !== 'bigint') throw new Error('type');
      return value;
    } catch {
      throw new ChainError('bad_answer');
    }
  };

  const hasCode = async (address: Hex): Promise<boolean> => {
    const code = await call('eth_getCode', [address, 'latest']);
    if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code))
      throw new ChainError('bad_answer');
    return code.length > 2;
  };

  /** The simulated gas, or null when the call reverts (with revert data). */
  const estimate = async (data: Hex): Promise<bigint | null> => {
    try {
      return quantity(
        await call('eth_estimateGas', [{ from: gasAddress, to: vault, data, value: '0x0' }]),
      );
    } catch (error) {
      if (error instanceof RpcAnswerError) {
        // No revert data: the provider's fault (a limit, a node fault), not the request's.
        if (error.data === undefined) throw new ChainError('rpc_error');
        return null;
      }
      throw error;
    }
  };

  const nonceAt = async (tag: 'pending' | 'latest'): Promise<number> => {
    const n = quantity(await call('eth_getTransactionCount', [gasAddress, tag]));
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainError('bad_answer');
    return Number(n);
  };

  /** The shipped deployment for the request's token, or the refusal code. */
  const deploymentFor = (
    request: DepositAuthorizationRequest,
  ): GaslessToken | DepositAuthErrorCode => {
    try {
      const d = gaslessToken(config, request.token);
      return d.vault === vault ? d : 'gasless_unavailable';
    } catch (error) {
      if (error instanceof ChainInputError && error.code === 'unsupported_chain') {
        return 'unsupported_chain';
      }
      return 'gasless_unavailable';
    }
  };

  const refuse = (error: DepositAuthErrorCode): DepositRelayCheck =>
    Object.freeze({ ok: false, error });

  return Object.freeze({
    chainId,
    vault,
    gasAddress,

    async check(raw: DepositAuthorizationRequest, nowSeconds: number): Promise<DepositRelayCheck> {
      const request = parseDepositAuthorizationRequest(raw);
      if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0)
        throw new ChainError('invalid_call');
      if (request.chainId !== chainId) return refuse('unsupported_chain');
      const deployment = deploymentFor(request);
      if (typeof deployment === 'string') return refuse(deployment);
      const { auth } = request;
      if (auth.to !== deployment.vault) return refuse('not_vault');

      const value = BigInt(auth.value);
      const bounds = gaslessValueBounds(deployment.decimals);
      if (value < bounds.min) return refuse('below_min_deposit');
      if (value > bounds.max) return refuse('above_max_top_up');

      const now = BigInt(nowSeconds);
      const validBefore = BigInt(auth.validBefore);
      if (BigInt(auth.validAfter) >= now) return refuse('invalid_window');
      if (validBefore <= now + BigInt(DEPOSIT_AUTH_MIN_REMAINING_SECONDS)) return refuse('expired');
      if (validBefore > now + BigInt(GASLESS_WINDOW_SECONDS + DEPOSIT_AUTH_CLOCK_SKEW_SECONDS)) {
        return refuse('invalid_window');
      }

      let domain;
      try {
        domain = await readTokenDomain(ethCall, deployment);
      } catch (error) {
        if (error instanceof ChainInputError) return refuse('gasless_unavailable');
        throw error;
      }
      if (recoverAuthorizationSigner(domain, auth) !== auth.from)
        return refuse('invalid_signature');
      if (await hasCode(auth.from)) return refuse('invalid_signature');
      if (await readAuthorizationUsed(ethCall, deployment.token, auth.from, auth.nonce)) {
        return refuse('already_used');
      }
      if (value < (await minDeposit(deployment.token))) return refuse('below_min_deposit');

      const gas = await estimate(depositAuthorizationCalldata(relayAbi, request));
      if (gas === null) return refuse('simulation_failed');
      const gasLimit = (gas * (100n + DEPOSIT_AUTH_GAS_MARGIN_PERCENT)) / 100n;
      if (gasLimit > DEPOSIT_AUTH_MAX_GAS) return refuse('gas_too_high');
      return Object.freeze({ ok: true, gasLimit });
    },

    async authorizationUsed(raw: DepositAuthorizationRequest): Promise<boolean> {
      const { token, auth } = parseDepositAuthorizationRequest(raw);
      return readAuthorizationUsed(ethCall, token, auth.from, auth.nonce);
    },

    pendingNonce: () => nonceAt('pending'),

    latestNonce: () => nonceAt('latest'),

    async send(
      raw: DepositAuthorizationRequest,
      { gasLimit, nonce, feePercent = 100 }: SendOptions,
    ) {
      let data: Hex;
      try {
        const request = parseDepositAuthorizationRequest(raw);
        const deployment = deploymentFor(request);
        if (
          request.chainId !== chainId ||
          typeof deployment === 'string' ||
          request.auth.to !== deployment.vault
        ) {
          throw new Error('request');
        }
        data = depositAuthorizationCalldata(relayAbi, request);
      } catch {
        throw new ChainError('invalid_call');
      }
      if (
        typeof gasLimit !== 'bigint' ||
        gasLimit < 21_000n ||
        gasLimit > DEPOSIT_AUTH_MAX_GAS ||
        !Number.isSafeInteger(nonce) ||
        nonce < 0 ||
        !Number.isSafeInteger(feePercent) ||
        feePercent < 100 ||
        feePercent > 1_000
      ) {
        throw new ChainError('invalid_call');
      }
      if (!chainChecked) {
        // EIP-155 binds the signature to chainId anyway; this refuses a misconfigured RPC early.
        if (quantity(await call('eth_chainId', [])) !== BigInt(chainId)) {
          throw new ChainError('bad_answer');
        }
        chainChecked = true;
      }
      const block = (await call('eth_getBlockByNumber', ['latest', false])) as {
        baseFeePerGas?: unknown;
      } | null;
      if (block === null || typeof block !== 'object') throw new ChainError('bad_answer');
      const baseFee = quantity(block.baseFeePerGas);
      const pct = BigInt(feePercent);
      let priority = (quantity(await call('eth_maxPriorityFeePerGas', [])) * pct) / 100n;
      let maxFee = (2n * baseFee * pct) / 100n + priority;
      if (options.maxFeePerGasWei !== undefined && maxFee > options.maxFeePerGasWei) {
        maxFee = options.maxFeePerGasWei;
        if (priority > maxFee) priority = maxFee;
      }
      let signed: Hex;
      try {
        signed = (await account.signTransaction({
          type: 'eip1559',
          chainId,
          nonce,
          gas: gasLimit,
          maxFeePerGas: maxFee,
          maxPriorityFeePerGas: priority,
          to: vault,
          data,
          value: 0n,
        })) as Hex;
      } catch {
        throw new ChainError('invalid_call');
      }
      const hash = keccak256(signed) as Hex;
      try {
        await call('eth_sendRawTransaction', [signed]);
      } catch (error) {
        if (error instanceof RpcAnswerError) throw new ChainError('rpc_error');
        throw error;
      }
      return hash;
    },

    async txStatus(txHash: Hex) {
      if (typeof txHash !== 'string' || !BYTES32.test(txHash)) throw new ChainError('invalid_call');
      const receipt = (await call('eth_getTransactionReceipt', [txHash])) as {
        status?: unknown;
      } | null;
      if (receipt === null) return 'pending';
      if (typeof receipt !== 'object') throw new ChainError('bad_answer');
      if (receipt.status === '0x1') return 'success';
      if (receipt.status === '0x0') return 'reverted';
      throw new ChainError('bad_answer');
    },
  } satisfies DepositRelayChain);
}
