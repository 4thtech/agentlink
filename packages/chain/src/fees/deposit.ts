// Deposits (12 §4.1 "Top up: deposit"; 05 §2.5; M1-4b, M1-4c).
//
// `buildDeposit` builds the calls the payer's own account sends to top up its credits:
// - a stablecoin: an `approve` of exactly the amount to the vault, then `deposit(token, amount)`.
//   Never an unlimited allowance. Given the current allowance (IR-M1-4b-1 L-3): an allowance equal
//   to the amount is used as is; any other nonzero allowance is first set to 0, because tokens in
//   the USDT style revert on an `approve` from one nonzero value to another;
// - the native coin (xDAI on Gnosis): one `deposit(address(0), amount)` carrying the value.
// `planDeposit` reads the allowance on-chain first; `sendDeposit` sends the steps in direct mode,
// each confirmed by its receipt on-chain before the next, and after the deposit clears the chain
// selector's cache and selects again once (IR-M1-26-1), so the newly funded chain is picked.
//
// The gasless EIP-3009 top-up (`depositWithAuthorization`) is not live (D-89, M1-3c): it is not in
// the client ABI and is never built or called here. `checkGaslessTopUp` is the client-side gate for
// it: the token must carry the shipped `eip3009` flag (off until the vault accepts the call), and
// the amount must reach the vault's `minDeposit(token)` (05 §2.2, 12 §4.1).
import { decodeFunctionData, encodeFunctionData, erc20Abi } from 'viem';
import type { Address, ChainConfig, FeeTokenSymbol } from '../config/index.js';
import { encodeFeeVaultCall, FEE_VAULT_CLIENT_ABI } from '../clients/calls.js';
import {
  sendDirect,
  waitForTx,
  type DirectMode,
  type DirectSendOptions,
  type PollOptions,
} from '../clients/direct.js';
import { ChainError } from '../clients/errors.js';
import type { ChainState, ContractName } from '../clients/state.js';
import { canonicalAddress, ChainInputError, type Hex } from '../ids/index.js';
import type { ChainSelection } from '../select/pick.js';
import { offeredToken, offeredTokens } from './tokens.js';

const MAX_UINT256 = 2n ** 256n - 1n;

/** One call for the payer's account to send, in order. */
export interface DepositStep {
  /** `reset_approval`: `approve(vault, 0)` before a new nonzero allowance (USDT style). */
  readonly purpose: 'reset_approval' | 'approve' | 'deposit';
  readonly to: Address;
  readonly data: Hex;
  /** Native value to attach (base units); 0 for a stablecoin. */
  readonly value: bigint;
}

export interface DepositRequest {
  readonly token: FeeTokenSymbol;
  /** Base units, 1 to 2^256 − 1. */
  readonly amount: bigint;
  /**
   * The payer's current allowance to the vault, when known (`planDeposit` reads it). Without it
   * the steps assume none: approve, then deposit.
   */
  readonly currentAllowance?: bigint;
}

function checkAmount(amount: unknown): bigint {
  if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_UINT256) {
    throw new ChainInputError('invalid_amount', 'amount: a bigint from 1 to 2^256 - 1');
  }
  return amount;
}

/** The calls that deposit `amount` of `token` as the sender's own credits on `config`'s chain. */
export function buildDeposit(config: ChainConfig, request: DepositRequest): DepositStep[] {
  const amount = checkAmount(request.amount);
  const current = request.currentAllowance;
  if (
    current !== undefined &&
    (typeof current !== 'bigint' || current < 0n || current > MAX_UINT256)
  ) {
    throw new ChainInputError('invalid_amount', 'currentAllowance: a bigint from 0 to 2^256 - 1');
  }
  const { token, vaultAddress } = offeredToken(config, request.token);
  const vault = config.contracts.vault;
  const deposit: DepositStep = Object.freeze({
    purpose: 'deposit',
    to: vault,
    data: encodeFeeVaultCall({ functionName: 'deposit', args: [vaultAddress, amount] }),
    value: token.address === null ? amount : 0n,
  });
  if (token.address === null) return [deposit];
  const approve = (purpose: 'reset_approval' | 'approve', value: bigint): DepositStep =>
    Object.freeze({
      purpose,
      to: token.address as Address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, value] }),
      value: 0n,
    });
  if (current === amount) return [deposit];
  if (current !== undefined && current !== 0n) {
    return [approve('reset_approval', 0n), approve('approve', amount), deposit];
  }
  return [approve('approve', amount), deposit];
}

/** `buildDeposit` with the payer's current allowance read on-chain. */
export async function planDeposit(
  state: ChainState,
  request: { readonly payer: string; readonly token: FeeTokenSymbol; readonly amount: bigint },
): Promise<DepositStep[]> {
  const payer = canonicalAddress(request.payer, 'payer');
  checkAmount(request.amount);
  const { token } = offeredToken(state.config, request.token);
  if (token.address === null) {
    return buildDeposit(state.config, { token: request.token, amount: request.amount });
  }
  const currentAllowance = await state.allowance(
    token.address as Hex,
    payer,
    state.config.contracts.vault as Hex,
  );
  return buildDeposit(state.config, {
    token: request.token,
    amount: request.amount,
    currentAllowance,
  });
}

/** One step as a direct-mode call; anything not built by buildDeposit is refused. */
function stepCall(config: ChainConfig, step: DepositStep) {
  const vault = config.contracts.vault.toLowerCase();
  const to = String(step.to).toLowerCase();
  const tokens = offeredTokens(config)
    .map((o) => o.token.address)
    .filter((a): a is Address => a !== null)
    .map((a) => a.toLowerCase());
  let contract: ContractName;
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    if (step.purpose === 'deposit') {
      if (to !== vault) throw new Error('to');
      contract = 'vault';
      decoded = decodeFunctionData({ abi: FEE_VAULT_CLIENT_ABI, data: step.data }) as never;
      if (decoded.functionName !== 'deposit') throw new Error('fn');
    } else if (step.purpose === 'approve' || step.purpose === 'reset_approval') {
      if (!tokens.includes(to) || step.value !== 0n) throw new Error('to');
      contract = 'erc20';
      decoded = decodeFunctionData({ abi: erc20Abi, data: step.data }) as never;
      const [spender, value] = decoded.args as [string, bigint];
      if (decoded.functionName !== 'approve' || spender.toLowerCase() !== vault) {
        throw new Error('fn');
      }
      if ((step.purpose === 'reset_approval') !== (value === 0n)) throw new Error('value');
    } else {
      throw new Error('purpose');
    }
  } catch {
    throw new ChainError('invalid_call');
  }
  return {
    contract,
    to: to as Hex,
    value: step.value,
    functionName: decoded.functionName,
    args: [...decoded.args],
  };
}

export interface SendDepositOptions extends PollOptions {
  readonly directOptions?: DirectSendOptions;
  /** The chain selector's cache (createChainSelector): cleared once the deposit is on-chain. */
  readonly selector?: { clear(): void };
  /** Selects the paying chain again; called once after the deposit is on-chain. */
  readonly reselect?: () => Promise<ChainSelection>;
}

export interface DepositResult {
  readonly txHashes: readonly Hex[];
  /** The fresh selection after the deposit, when `reselect` was given. */
  readonly selection?: ChainSelection;
}

/**
 * Sends the deposit steps from the signer's own account, in order, each simulated first and
 * confirmed by its on-chain receipt before the next. Then clears the selector and selects again
 * once. Errors are ChainErrors: `invalid_call` (a step not built by buildDeposit, before anything is
 * sent), `call_reverted` (simulation), `no_gas`, `tx_reverted`, `tx_not_included`.
 */
export async function sendDeposit(
  state: ChainState,
  direct: DirectMode,
  steps: readonly DepositStep[],
  options: SendDepositOptions = {},
): Promise<DepositResult> {
  if (steps.length < 1 || steps.length > 3 || steps.at(-1)?.purpose !== 'deposit') {
    throw new ChainError('invalid_call');
  }
  const calls = steps.map((s) => stepCall(state.config, s));
  const txHashes: Hex[] = [];
  for (const call of calls) {
    const sent = await sendDirect(state, direct, call, options.directOptions);
    if (!sent.ok) {
      if (sent.error === 'no_gas') throw new ChainError('no_gas');
      throw new ChainError('call_reverted', sent.error === 'reverted' ? undefined : sent.error);
    }
    txHashes.push(sent.txHash);
    const status = await waitForTx(state, sent.txHash, options);
    if (status === 'reverted') throw new ChainError('tx_reverted');
    if (status === 'pending') throw new ChainError('tx_not_included');
  }
  // Credits changed: never pay from the cached detection (07 §6.3).
  options.selector?.clear();
  const selection = options.reselect ? await options.reselect() : undefined;
  return Object.freeze({
    txHashes: Object.freeze(txHashes),
    ...(selection === undefined ? {} : { selection }),
  });
}

/**
 * The client-side gate for a gasless top-up (12 §4.1; 07 §7 `/v1/deposit-authorization`): the token
 * must carry the shipped `eip3009` flag and the amount must reach the vault's `minDeposit`. Refused
 * before any read while the flag is off (D-89). Builds and sends nothing.
 */
export async function checkGaslessTopUp(
  state: ChainState,
  request: { readonly token: FeeTokenSymbol; readonly amount: bigint },
): Promise<{ readonly minDeposit: bigint }> {
  const amount = checkAmount(request.amount);
  const { token, vaultAddress } = offeredToken(state.config, request.token);
  if (token.eip3009 !== true || token.address === null) {
    throw new ChainInputError(
      'gasless_unavailable',
      'no gasless top-up for that token on this chain',
    );
  }
  const minDeposit = await state.minDeposit(vaultAddress as Hex);
  if (amount < minDeposit) {
    throw new ChainInputError('below_min_deposit', 'amount: below the vault minimum deposit');
  }
  return Object.freeze({ minDeposit });
}
