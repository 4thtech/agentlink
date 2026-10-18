// The direct-mode deposit helper (12 §4.1 "Top up: deposit"; 05 §2.5). It builds the calls the
// payer's own account sends to top up its credits; it signs and sends nothing (sending is M1-4c).
// - A stablecoin: an `approve` of exactly the amount to the vault, then `deposit(token, amount)`.
//   Never an unlimited allowance.
// - The native coin (xDAI on Gnosis): one `deposit(address(0), amount)` carrying the value.
// The gasless EIP-3009 top-up (`depositWithAuthorization`) is refused by the deployed vault until
// M1-3c and cannot be encoded here (it is not in the client ABI).
import { encodeFunctionData, erc20Abi } from 'viem';
import type { Address, ChainConfig, FeeTokenSymbol } from '../config/index.js';
import { encodeFeeVaultCall } from '../clients/calls.js';
import { ChainInputError, type Hex } from '../ids/index.js';
import { offeredToken } from './tokens.js';

const MAX_UINT256 = 2n ** 256n - 1n;

/** One call for the payer's account to send, in order. */
export interface DepositStep {
  readonly purpose: 'approve' | 'deposit';
  readonly to: Address;
  readonly data: Hex;
  /** Native value to attach (base units); 0 for a stablecoin. */
  readonly value: bigint;
}

export interface DepositRequest {
  readonly token: FeeTokenSymbol;
  /** Base units, 1 to 2^256 − 1. */
  readonly amount: bigint;
}

/** The calls that deposit `amount` of `token` as the sender's own credits on `config`'s chain. */
export function buildDeposit(config: ChainConfig, request: DepositRequest): DepositStep[] {
  const { amount } = request;
  if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_UINT256) {
    throw new ChainInputError('invalid_amount', 'amount: a bigint from 1 to 2^256 - 1');
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
  const approve: DepositStep = Object.freeze({
    purpose: 'approve',
    to: token.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, amount] }),
    value: 0n,
  });
  return [approve, deposit];
}
