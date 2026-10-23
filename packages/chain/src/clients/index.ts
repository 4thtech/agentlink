// Chain registry, selection, RPC URL rule, read client and client-safe calls (07 §6; M1-4a).
export {
  checkRpcUrl,
  MAX_RPC_URL_LENGTH,
  type RpcUrlCheck,
  type RpcUrlRefusal,
} from './rpc-url.js';
export {
  autoSelectableChains,
  chainRegistry,
  getChainConfig,
  selectChain,
  type SelectChainOptions,
} from './registry.js';
export {
  DEFAULT_RPC_RETRY_COUNT,
  DEFAULT_RPC_RETRY_DELAY_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  MAX_USER_RPC_URLS,
  RPC_READ_METHODS,
  createReadClient,
  type ReadClient,
  type ReadClientOptions,
  type RpcFetchFn,
} from './read-client.js';
export {
  FEE_VAULT_CLIENT_ABI,
  NOTARY_CLIENT_ABI,
  encodeFeeVaultCall,
  encodeNotaryCall,
  feeVaultReader,
  notaryReader,
  type FeeVaultCall,
  type FeeVaultReader,
  type NotaryCall,
  type NotaryReader,
} from './calls.js';
export { ChainError, type ChainErrorCode } from './errors.js';
export {
  checkDirectCall,
  createChainState,
  type BlockInfo,
  type ChainState,
  type ContractName,
  type ContractTx,
  type FeeLevels,
  type StoredRecord,
  type TxSimulation,
} from './state.js';
export {
  createBroadcaster,
  createDirectMode,
  keyStoreDirectSigner,
  pollChain,
  sendDirect,
  waitForTx,
  type Broadcast,
  type BroadcasterOptions,
  type DirectKeys,
  type DirectMode,
  type DirectSend,
  type DirectSendOptions,
  type DirectSigner,
  type DirectTransaction,
  type PollOptions,
} from './direct.js';
