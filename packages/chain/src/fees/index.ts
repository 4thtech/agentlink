// Fees and credits (07 §6.2; 12 §4, §5; 06 §2.1; D-46; M1-4b): quotes in USD, credits across
// chains, the direct-mode deposit helper and the credit event filter.
export {
  FEE_TYPE_IDS,
  OFFICIAL_APP_ID,
  quoteFee,
  type FeeQuote,
  type QuoteRequest,
} from './quote.js';
export {
  readCredits,
  readCreditsAcrossChains,
  type ChainReader,
  type CreditBalance,
} from './credits.js';
export { buildDeposit, type DepositRequest, type DepositStep } from './deposit.js';
export {
  MAX_LOG_BLOCK_SPAN,
  filterCreditEvents,
  readCreditHistory,
  type CreditEvent,
  type CreditEventName,
  type CreditHistoryRequest,
  type RawLog,
} from './events.js';
export { NATIVE_TOKEN_ADDRESS, offeredTokens, type OfferedToken } from './tokens.js';
export {
  FAUCET_CHAIN_IDS,
  FAUCET_MAX_USD_CENTS,
  buildDepositFor,
  createFaucetChain,
  isFaucetChain,
  type DepositForRequest,
  type FaucetChain,
  type FaucetChainOptions,
  type FaucetCredit,
} from './faucet.js';
export { tokenUnitsToUsd } from './usd.js';
