// Withdrawals (05 §2.5 "payer withdraws unused credits any time"; 07 §6.2; M1-4c-b).
//
// The typed withdraw API: `withdraw(token, amount, to)` on the vault from the payer's own account,
// in direct mode. sendWithdraw sends the signer's credits back to the signer's own account and to
// no other: the KeyStore refuses a withdraw that names another recipient (signTransaction), so the
// agent path can never move credits elsewhere. Withdrawing to an address the owner names is a later
// owner action (owner-signed, I-4); no MCP tool reaches this.
import type { Address, ChainConfig, FeeTokenSymbol } from '../config/index.js';
import { encodeFeeVaultCall } from '../clients/calls.js';
import {
  sendDirect,
  waitForTx,
  type DirectMode,
  type DirectSendOptions,
  type PollOptions,
} from '../clients/direct.js';
import { ChainError } from '../clients/errors.js';
import type { ChainState } from '../clients/state.js';
import { canonicalAddress, ChainInputError, type Hex } from '../ids/index.js';
import { offeredToken } from './tokens.js';

const MAX_UINT256 = 2n ** 256n - 1n;

/** The one call a withdrawal sends. */
export interface WithdrawStep {
  readonly to: Address;
  readonly data: Hex;
  /** Always 0: `withdraw` is not payable. */
  readonly value: bigint;
}

export interface WithdrawRequest {
  readonly token: FeeTokenSymbol;
  /** Base units, 1 to 2^256 − 1. */
  readonly amount: bigint;
  /** The recipient, `0x` + 40 hex. sendWithdraw always passes the signer's own address. */
  readonly to: string;
}

function checkAmount(amount: unknown): bigint {
  if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_UINT256) {
    throw new ChainInputError('invalid_amount', 'amount: a bigint from 1 to 2^256 - 1');
  }
  return amount;
}

/** The call that withdraws `amount` of an offered `token` from the sender's credits to `to`. */
export function buildWithdraw(config: ChainConfig, request: WithdrawRequest): WithdrawStep {
  const amount = checkAmount(request.amount);
  const to = canonicalAddress(request.to, 'to');
  const { vaultAddress } = offeredToken(config, request.token);
  return Object.freeze({
    to: config.contracts.vault,
    data: encodeFeeVaultCall({ functionName: 'withdraw', args: [vaultAddress, amount, to] }),
    value: 0n,
  });
}

export interface SendWithdrawOptions extends PollOptions {
  readonly directOptions?: DirectSendOptions;
}

/**
 * Withdraws `amount` of `token` from the signer's credits to the signer's own account: simulated
 * first, signed by the KeyStore, then confirmed by its receipt on-chain. Errors are ChainErrors:
 * `call_reverted` (simulation, by name), `no_gas`, `signing_refused`, `tx_reverted`,
 * `tx_not_included`; a bad amount or token is a ChainInputError before anything is read.
 */
export async function sendWithdraw(
  state: ChainState,
  direct: DirectMode,
  request: { readonly token: FeeTokenSymbol; readonly amount: bigint },
  options: SendWithdrawOptions = {},
): Promise<{ readonly txHash: Hex }> {
  const amount = checkAmount(request.amount);
  const { vaultAddress } = offeredToken(state.config, request.token);
  const self = direct.signer.address.toLowerCase() as Hex;
  const sent = await sendDirect(
    state,
    direct,
    {
      contract: 'vault',
      to: state.config.contracts.vault as Hex,
      value: 0n,
      functionName: 'withdraw',
      args: [vaultAddress, amount, self],
    },
    options.directOptions,
  );
  if (!sent.ok) {
    if (sent.error === 'no_gas') throw new ChainError('no_gas');
    throw new ChainError('call_reverted', sent.error === 'reverted' ? undefined : sent.error);
  }
  const status = await waitForTx(state, sent.txHash, options);
  if (status === 'reverted') throw new ChainError('tx_reverted');
  if (status === 'pending') throw new ChainError('tx_not_included');
  return Object.freeze({ txHash: sent.txHash });
}
