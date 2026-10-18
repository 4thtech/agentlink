// The read client per chain (07 §6.1, §6.2; M1-4a): a viem public client over a fallback of HTTP
// transports, one per RPC URL, with a per-request timeout and bounded retries.
//
// - The user's own RPC URLs (Advanced settings, at most MAX_USER_RPC_URLS) come first, then the
//   shipped public ones. Every URL passes the 04 §4 raw-string rule (`checkRpcUrl`) before the client
//   exists. A URL may carry the owner's provider key in its path, so every URL is a secret: it is
//   never logged, never put in an error (every rejection is a fixed-code ChainError, M-2) and never
//   exposed on the client's `chain` object.
// - `fetchFn` is required: the platform decides how a host is resolved. In Node it is
//   `@4thtech-io/node` nodeRpcFetch, which refuses loopback, private, link-local and unique-local
//   answers at resolve time and pins the checked address per request (04 §4; IR-M1-4a-1 M-1).
// - Requests never follow a redirect (`redirect: "error"`), send no cookies and no referrer.
// - Only read methods reach an RPC: signing, accounts and transaction submission are refused before
//   any request, and the type has no send method. The client holds no key; signing is
//   KeyStore.sign712 only (07 §6.2), and sending a transaction (direct mode) is M1-4c.
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
import { toChainError } from './errors.js';
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
/** User RPC URLs per chain (Advanced settings). */
export const MAX_USER_RPC_URLS = 5;
const MAX_TIMEOUT_MS = 30_000;
/** With the delay cap, at most 1 + 2 + 4 s of back-off per URL (viem doubles the delay). */
const MAX_RETRY_COUNT = 3;
const MAX_RETRY_DELAY_MS = 1_000;

/** The platform fetch viem's HTTP transport calls. */
export type RpcFetchFn = NonNullable<HttpTransportConfig['fetchFn']>;

/** Options for `createReadClient`. */
export interface ReadClientOptions {
  /**
   * The fetch that sends RPC requests. Node: `@4thtech-io/node` nodeRpcFetch (resolve-time address
   * check and pinning). Tests inject one.
   */
  readonly fetchFn: RpcFetchFn;
  /** The user's own RPC URLs for this chain, tried before the shipped ones (07 §6.1); at most 5. */
  readonly rpcUrls?: readonly string[];
  /** Per-request timeout, 1 to 30 000 ms. */
  readonly timeoutMs?: number;
  /** Retries per URL before the next URL, 0 to 3. */
  readonly retryCount?: number;
  /** Base delay between retries (viem backs off exponentially), 0 to 1 000 ms. */
  readonly retryDelayMs?: number;
}

/** The send methods a read client never offers (refused by the transport too). */
type SendMethods = 'sendRawTransaction' | 'sendRawTransactionSync';

/** A read-only public client for one supported chain. Rejections are ChainErrors. */
export type ReadClient = Omit<PublicClient<Transport, Chain>, SendMethods>;

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
  if (overrides.length > MAX_USER_RPC_URLS) {
    throw new ChainConfigError(
      'too_many_rpc_urls',
      `chain ${String(config.chainId)}: at most ${String(MAX_USER_RPC_URLS)} own RPC URLs`,
    );
  }
  const urls: string[] = [];
  for (const url of [...overrides, ...config.rpcUrls]) {
    if (!checkRpcUrl(url).ok) {
      // Never echo the URL: it is a secret (it may carry a provider key in its path).
      throw new ChainConfigError(
        'bad_rpc_url',
        `chain ${String(config.chainId)}: an RPC URL breaks the rule (https, a public host name)`,
      );
    }
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * Every function of the client rejects (or throws) a URL-free ChainError instead of viem's error,
 * which names the URL. Contract readers built on it inherit this, since viem's actions look the
 * action up on the client.
 */
function redacting<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        try {
          const out: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
          return out instanceof Promise
            ? out.catch((error: unknown) => {
                throw toChainError(error);
              })
            : out;
        } catch (error) {
          throw toChainError(error);
        }
      };
    },
  });
}

/** Creates the read client for a supported chain (see `chainRegistry`, `selectChain`). */
export function createReadClient(config: ChainConfig, options: ReadClientOptions): ReadClient {
  if (typeof options.fetchFn !== 'function') {
    throw new ChainConfigError('bad_client_option', 'fetchFn: a platform RPC fetch is required');
  }
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
      fetchFn: options.fetchFn,
    }),
  );
  const chain = defineChain({
    id: config.chainId,
    name: config.key,
    // Used only to format native balances; the gas coin is never a fee token outside Gnosis (D-46).
    nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 },
    // The URLs live only inside the transports: the chain object is not a place to read them from.
    rpcUrls: { default: { http: [] } },
    testnet: config.testnet,
  });
  // The fallback walks the URLs in order; each URL has already retried, so it does not retry again.
  const client = createPublicClient({
    chain,
    transport: fallback(transports, { rank: false, retryCount: 0 }),
  });
  return redacting(client);
}
