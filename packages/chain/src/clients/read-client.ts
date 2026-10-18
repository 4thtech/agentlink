// The read client per chain (07 §6.1, §6.2; M1-4a): a viem public client over a fallback of HTTP
// transports, one per RPC URL, with a per-request timeout and bounded retries.
//
// - The user's own RPC URLs (Advanced settings) come first, then the shipped public ones. Every URL
//   passes the 04 §4 rule (`checkRpcUrl`) before the client exists. No API key, no credentials.
// - Requests never follow a redirect (`redirect: "error"`), send no cookies and no referrer.
// - Only read methods reach an RPC: signing, accounts and transaction submission are refused before
//   any request. The client holds no key; signing is KeyStore.sign712 only (07 §6.2), and sending a
//   transaction (direct mode) is M1-4c.
import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  type Chain,
  type HttpTransportConfig,
  type PublicClient,
  type Transport,
} from 'viem';
import { ChainConfigError, type ChainConfig } from '../config/index.js';
import { checkRpcUrl } from './rpc-url.js';

/** The JSON-RPC methods the read client sends. Nothing that signs, sends or names an account. */
export const RPC_READ_METHODS: readonly string[] = Object.freeze([
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'net_version',
]);

export const DEFAULT_RPC_TIMEOUT_MS = 10_000;
export const DEFAULT_RPC_RETRY_COUNT = 2;
export const DEFAULT_RPC_RETRY_DELAY_MS = 150;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RETRY_COUNT = 10;
const MAX_RETRY_DELAY_MS = 10_000;

/** Options for `createReadClient`. */
export interface ReadClientOptions {
  /** The user's own RPC URLs for this chain, tried before the shipped ones (07 §6.1). */
  readonly rpcUrls?: readonly string[];
  /** Per-request timeout, 1 to 120 000 ms. */
  readonly timeoutMs?: number;
  /** Retries per URL before the next URL, 0 to 10. */
  readonly retryCount?: number;
  /** Base delay between retries (viem backs off exponentially), 0 to 10 000 ms. */
  readonly retryDelayMs?: number;
  /** The fetch to use; the platform fetch by default. Tests inject one. */
  readonly fetchFn?: HttpTransportConfig['fetchFn'];
}

/** A read-only public client for one supported chain. */
export type ReadClient = PublicClient<Transport, Chain>;

function bounded(
  value: number | undefined,
  fallbackValue: number,
  min: number,
  max: number,
  field: string,
): number {
  const v = value ?? fallbackValue;
  if (!Number.isSafeInteger(v) || v < min || v > max) {
    throw new ChainConfigError(
      'bad_client_option',
      `${field}: must be an integer from ${String(min)} to ${String(max)}`,
    );
  }
  return v;
}

/** The RPC URLs in order (user first), each checked, without duplicates. */
function rpcUrlsFor(config: ChainConfig, overrides: readonly string[]): string[] {
  const urls: string[] = [];
  for (const url of [...overrides, ...config.rpcUrls]) {
    if (!checkRpcUrl(url).ok) {
      // Never echo the URL: a user's endpoint may still carry something private in its path.
      throw new ChainConfigError(
        'bad_rpc_url',
        `chain ${String(config.chainId)}: an RPC URL breaks the rule (https, a public host name, no key)`,
      );
    }
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** Creates the read client for a supported chain (see `chainRegistry`, `selectChain`). */
export function createReadClient(config: ChainConfig, options: ReadClientOptions = {}): ReadClient {
  const timeout = bounded(
    options.timeoutMs,
    DEFAULT_RPC_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
    'timeoutMs',
  );
  const retryCount = bounded(
    options.retryCount,
    DEFAULT_RPC_RETRY_COUNT,
    0,
    MAX_RETRY_COUNT,
    'retryCount',
  );
  const retryDelay = bounded(
    options.retryDelayMs,
    DEFAULT_RPC_RETRY_DELAY_MS,
    0,
    MAX_RETRY_DELAY_MS,
    'retryDelayMs',
  );
  const urls = rpcUrlsFor(config, options.rpcUrls ?? []);
  const include = [...RPC_READ_METHODS];
  const transports = urls.map((url) =>
    http(url, {
      batch: false,
      timeout,
      retryCount,
      retryDelay,
      methods: { include },
      fetchOptions: { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' },
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    }),
  );
  const chain = defineChain({
    id: config.chainId,
    name: config.key,
    // Used only to format native balances; the gas coin is never a fee token outside Gnosis (D-46).
    nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: urls } },
    testnet: config.testnet,
  });
  // The fallback walks the URLs in order; each URL has already retried, so it does not retry again.
  return createPublicClient({
    chain,
    transport: fallback(transports, { rank: false, retryCount: 0 }),
  });
}
