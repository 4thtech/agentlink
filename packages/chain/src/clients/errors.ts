// Errors that leave the read client (IR-M1-4a-1 M-2). viem's transport errors carry the request
// URL ("URL: …"), its details and sometimes the request body. An RPC URL may hold the owner's
// provider key in its path, so it is a secret (I-7): every rejection from the read client becomes a
// `ChainError` with a fixed code and fixed text, and no cause, URL, path, query or server text.
import {
  AbiDecodingDataSizeTooSmallError,
  AbiEncodingLengthMismatchError,
  AbiFunctionNotFoundError,
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InvalidAddressError,
  MethodNotSupportedRpcError,
  RpcRequestError,
  TimeoutError,
} from 'viem';

export type ChainErrorCode =
  /** The contract call reverted. `revertName` names the contract error when the ABI knows it. */
  | 'call_reverted'
  /** The call could not be encoded or decoded (unknown function, bad argument). Nothing was sent. */
  | 'invalid_call'
  /** The method is not a read method; refused before any request. */
  | 'method_refused'
  /** Every RPC endpoint timed out. */
  | 'rpc_timeout'
  /** Every RPC endpoint failed at the HTTP or network level. */
  | 'rpc_unavailable'
  /** An RPC endpoint answered with a JSON-RPC error. */
  | 'rpc_error'
  /** The chain answered, but the answer is impossible (a quote whose parts do not add up). */
  | 'bad_answer'
  /** Direct mode: the signed bytes are not the transaction that was built, or not from the signer. */
  | 'signer_mismatch'
  /** Direct mode: the account cannot pay the gas for the call. Nothing was signed. */
  | 'no_gas'
  /**
   * Direct mode (M1-4c-b): the KeyStore refused to sign the transaction (not one direct mode may
   * send on this chain). Nothing was signed or sent.
   */
  | 'signing_refused'
  /** A sent transaction reverted on-chain. */
  | 'tx_reverted'
  /** A sent transaction was not included within the wait. */
  | 'tx_not_included'
  /** Anything else. */
  | 'rpc_failed';

const MESSAGES: Record<ChainErrorCode, string> = {
  call_reverted: 'The contract refused the call.',
  invalid_call: 'The contract call is not valid.',
  method_refused: 'That request is not allowed on the read client.',
  rpc_timeout: 'The chain did not answer in time.',
  rpc_unavailable: 'The chain could not be reached.',
  rpc_error: 'The chain returned an error.',
  bad_answer: 'The chain returned an answer that does not add up.',
  signer_mismatch: 'The signed transaction does not match the contract call.',
  no_gas: 'The account cannot pay the chain fee for this contract call.',
  signing_refused: 'The account key refused to sign this contract call.',
  tx_reverted: 'The contract refused the transaction.',
  tx_not_included: 'The transaction was not included on the chain in time.',
  rpc_failed: 'The chain request failed.',
};

/** A read-client failure. Fixed text; never a URL or server text (I-7). */
export class ChainError extends Error {
  readonly code: ChainErrorCode;
  /** The contract error's ABI name for `call_reverted`, when known (from the bound ABI). */
  readonly revertName: string | undefined;

  constructor(code: ChainErrorCode, revertName?: string) {
    super(MESSAGES[code]);
    this.name = 'ChainError';
    this.code = code;
    this.revertName = revertName;
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Maps any error to a URL-free ChainError. */
export function toChainError(error: unknown): ChainError {
  if (error instanceof ChainError) return error;
  if (!(error instanceof BaseError)) return new ChainError('rpc_failed');
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    const name = reverted.data?.errorName;
    return new ChainError(
      'call_reverted',
      typeof name === 'string' && IDENTIFIER.test(name) ? name : undefined,
    );
  }
  const has = (cls: new (...args: never[]) => Error): boolean =>
    error.walk((e) => e instanceof cls) !== null;
  if (has(MethodNotSupportedRpcError)) return new ChainError('method_refused');
  if (
    has(AbiFunctionNotFoundError) ||
    has(AbiEncodingLengthMismatchError) ||
    has(AbiDecodingDataSizeTooSmallError) ||
    has(InvalidAddressError)
  ) {
    return new ChainError('invalid_call');
  }
  if (has(TimeoutError)) return new ChainError('rpc_timeout');
  if (has(RpcRequestError)) return new ChainError('rpc_error');
  if (has(HttpRequestError)) return new ChainError('rpc_unavailable');
  return new ChainError('rpc_failed');
}
