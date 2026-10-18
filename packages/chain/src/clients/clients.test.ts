// M1-4a: the chain registry, automatic chain selection, the RPC URL rule and the read client
// (07 §6.1, §6.3; 03 §7; 04 §4; D-40; AUDIT-FABLE-OCC19-1 M-1, L-1). No network: every transport
// runs through an injected fetch.
import { FUNCTION_TAGS, getDeployment, occFeeVaultAbi, occNotaryAbi } from '@4thtech-io/occ-v2-abi';
import { encodeFunctionData } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA, GNOSIS_CHIADO } from '../config/index.js';
import type { ChainConfig, ChainNetwork } from '../config/index.js';
import { loadOccV2Contracts, type OccV2Contracts } from '../occ-v2.js';
import { composeChainConfig } from './registry.js';
import {
  ChainError,
  FEE_VAULT_CLIENT_ABI,
  MAX_USER_RPC_URLS,
  NOTARY_CLIENT_ABI,
  RPC_READ_METHODS,
  chainRegistry,
  checkRpcUrl,
  createReadClient,
  encodeFeeVaultCall,
  encodeNotaryCall,
  feeVaultReader,
  getChainConfig,
  notaryReader,
  selectChain,
} from './index.js';

const BASE = getDeployment(84532);
if (!BASE) throw new Error('test setup: the pinned release has no Base Sepolia deployment');

// --- RPC URL rule (04 §4 SSRF, 07 §6.1 keyless) -------------------------------------------------

describe('checkRpcUrl (04 §4 raw-string rule, applied to RPC URLs)', () => {
  it('accepts every shipped RPC URL', () => {
    for (const url of [...BASE_SEPOLIA.rpcUrls, ...GNOSIS_CHIADO.rpcUrls]) {
      expect(checkRpcUrl(url)).toEqual({ ok: true, url });
    }
    expect(checkRpcUrl('https://rpc.example-node.io:8443/v1/base')).toEqual({
      ok: true,
      url: 'https://rpc.example-node.io:8443/v1/base',
    });
  });

  const refused: [string, unknown][] = [
    ['not a string', 42],
    ['empty', ''],
    ['plain http', 'http://sepolia.base.org'],
    ['websocket', 'wss://sepolia.base.org'],
    ['upper-case scheme', 'HTTPS://sepolia.base.org'],
    ['localhost', 'https://localhost:8545'],
    ['a .localhost name', 'https://rpc.localhost'],
    ['an .internal name', 'https://metadata.google.internal/computeMetadata'],
    ['a .local name', 'https://node.local'],
    ['a .home.arpa name', 'https://router.home.arpa'],
    ['IPv4 loopback', 'https://127.0.0.1:8545'],
    ['IPv4 metadata address', 'https://169.254.169.254/latest'],
    ['a private IPv4', 'https://10.0.0.1'],
    ['decimal IPv4', 'https://2130706433'],
    ['hex IPv4', 'https://0x7f.1'],
    ['octal IPv4', 'https://0177.0.0.1'],
    ['a numeric label anywhere', 'https://1.rpc.example-node.io'],
    ['bracketed IPv6', 'https://[::1]:8545'],
    ['user info (a key)', 'https://key@rpc.example-node.io'],
    ['a query (a key)', 'https://rpc.example-node.io/?apikey=abc'],
    ['a fragment', 'https://rpc.example-node.io/#x'],
    ['a template', 'https://rpc.example-node.io/${KEY}'],
    ['percent-encoding', 'https://rpc%2eexample-node.io'],
    ['full-width dot', 'https://rpc。example-node.io'],
    ['non-ASCII host', 'https://rpc.exämple.io'],
    ['whitespace', 'https://rpc.example-node.io /x'],
    ['a backslash', 'https://rpc.example-node.io\\@evil.io'],
    ['an upper-case host', 'https://RPC.example-node.io'],
    ['a trailing dot', 'https://rpc.example-node.io.'],
    ['a single label', 'https://rpcnode'],
    ['port 0', 'https://rpc.example-node.io:0'],
    ['port with a leading zero', 'https://rpc.example-node.io:08545'],
    ['port above 65535', 'https://rpc.example-node.io:65536'],
    ['too long', `https://rpc.example-node.io/${'a'.repeat(2100)}`],
  ];
  for (const [name, url] of refused) {
    it(`refuses ${name}`, () => {
      const check = checkRpcUrl(url);
      expect(check.ok).toBe(false);
      // A refusal carries a fixed reason code, never the URL.
      expect(JSON.stringify(check)).not.toContain('example-node');
      expect(JSON.stringify(check)).not.toContain('apikey');
    });
  }
});

// --- registry (07 §6.1) ------------------------------------------------------------------------

describe('chain registry: network entry + pinned OCC v2 contracts', () => {
  it('lists the chains that have both an entry and a deployment: Base Sepolia only today', () => {
    const chains = chainRegistry();
    expect(chains.map((c) => c.chainId)).toEqual([84532]);
    expect(chains.every((c) => c.testnet)).toBe(true);
  });

  it('composes Base Sepolia from the shipped entry and the release addresses', () => {
    const c = getChainConfig(84532) as ChainConfig;
    expect(c.key).toBe('base-sepolia');
    expect(c.rpcUrls).toEqual(BASE_SEPOLIA.rpcUrls);
    expect(c.contracts).toEqual({
      notary: BASE.contracts.OCCNotary.toLowerCase(),
      vault: BASE.contracts.OCCFeeVault.toLowerCase(),
    });
    expect(c.feeTokens.map((t) => [t.symbol, t.address])).toEqual([
      ['USDC', '0x036cbd53842c5426634e7929541ec2318f3dcf7e'],
    ]);
  });

  it('advertises no EIP-3009 deposit while the vault refuses it (M1-3c; FA M-1)', () => {
    const c = getChainConfig(84532) as ChainConfig;
    expect(loadOccV2Contracts(84532)?.depositWithAuthorization).toBe(false);
    expect(c.feeTokens.every((t) => t.eip3009 !== true)).toBe(true);
  });

  it('knows no chain without a deployment, and no mainnet', () => {
    expect(getChainConfig(10200)).toBeUndefined(); // Chiado: entry shipped, not deployed yet
    for (const id of [1, 8453, 100, 42161, 10, 137, 0, -1]) {
      expect(getChainConfig(id)).toBeUndefined();
    }
  });

  it('is frozen, so no caller can redirect a payment', () => {
    const c = getChainConfig(84532) as ChainConfig;
    expect(Object.isFrozen(chainRegistry())).toBe(true);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.contracts)).toBe(true);
    expect(Object.isFrozen(c.feeTokens)).toBe(true);
    expect(Object.isFrozen(c.feeTokens[0])).toBe(true);
    expect(Object.isFrozen(c.rpcUrls)).toBe(true);
  });

  const contracts = loadOccV2Contracts(84532) as OccV2Contracts;
  const clone = (n: ChainNetwork): ChainNetwork => JSON.parse(JSON.stringify(n)) as ChainNetwork;

  it('rejects a deployment for another chain', () => {
    expect(() => composeChainConfig(clone(GNOSIS_CHIADO), contracts)).toThrow(
      expect.objectContaining({ code: 'chain_mismatch' }),
    );
  });

  it('rejects fee tokens that differ between the entry and the release', () => {
    const other = clone(BASE_SEPOLIA);
    (other.feeTokens[0] as { address: string }).address =
      '0x1111111111111111111111111111111111111111';
    expect(() => composeChainConfig(other, contracts)).toThrow(
      expect.objectContaining({ code: 'fee_token_mismatch' }),
    );
    const decimals = clone(BASE_SEPOLIA);
    (decimals.feeTokens[0] as { decimals: number }).decimals = 18;
    expect(() => composeChainConfig(decimals, contracts)).toThrow(
      expect.objectContaining({ code: 'fee_token_mismatch' }),
    );
    const extra: OccV2Contracts = {
      ...contracts,
      feeTokens: [
        ...contracts.feeTokens,
        {
          address: '0x2222222222222222222222222222222222222222',
          decimals: 6,
          eip3009: false,
          native: false,
          symbol: 'USDT',
        },
      ],
    };
    expect(() => composeChainConfig(clone(BASE_SEPOLIA), extra)).toThrow(
      expect.objectContaining({ code: 'fee_token_mismatch' }),
    );
  });

  it('rejects duplicate tokens and unknown chains (config schema)', () => {
    const dup = clone(BASE_SEPOLIA);
    dup.feeTokens.push(JSON.parse(JSON.stringify(dup.feeTokens[0])) as never);
    expect(() => composeChainConfig(dup, contracts)).toThrow(
      expect.objectContaining({ code: 'duplicate_token' }),
    );
    const unknown = { ...clone(BASE_SEPOLIA), chainId: 8453 };
    expect(() => composeChainConfig(unknown, { ...contracts, chainId: 8453 })).toThrow(
      expect.objectContaining({ code: 'unsupported_chain' }),
    );
  });

  it('rejects a release deployment that is not a testnet', () => {
    expect(() => composeChainConfig(clone(BASE_SEPOLIA), { ...contracts, testnet: false })).toThrow(
      expect.objectContaining({ code: 'not_testnet' }),
    );
  });
});

// --- automatic selection (D-40; 07 §6.3) -------------------------------------------------------

describe('selectChain: automatic, testnet only', () => {
  it('picks a chain with no input', () => {
    expect(selectChain().chainId).toBe(84532);
  });

  it('honours an Advanced override only for a supported chain', () => {
    expect(selectChain({ chainId: 84532 }).chainId).toBe(84532);
    for (const chainId of [10200, 8453, 1, 100]) {
      expect(() => selectChain({ chainId })).toThrow(
        expect.objectContaining({ code: 'unsupported_chain' }),
      );
    }
  });
});

// --- read client -------------------------------------------------------------------------------

type FetchInput = string | URL | Request;
type FetchArgs = [FetchInput, RequestInit];

/** viem hands fetch the URL in its serialised form (a bare origin gains a `/`). */
const sameUrl = (a: unknown, b: string | undefined): boolean =>
  b !== undefined && new URL(String(a)).href === new URL(b).href;

function rpcResult(result: unknown) {
  return async (_url: FetchInput, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { id: number };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function config(): ChainConfig {
  return getChainConfig(84532) as ChainConfig;
}

describe('createReadClient: fallback transport with timeouts and retries', () => {
  it('reads through the first RPC URL, with no redirects, credentials or referrer', async () => {
    const fetchFn = vi.fn(rpcResult('0x14a34'));
    const client = createReadClient(config(), { fetchFn });
    expect(await client.getChainId()).toBe(84532);
    const [url, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(sameUrl(url, BASE_SEPOLIA.rpcUrls[0])).toBe(true);
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
  });

  it('tries user RPC URLs first, then the shipped ones', async () => {
    const fetchFn = vi.fn(rpcResult('0x14a34'));
    const client = createReadClient(config(), {
      fetchFn,
      rpcUrls: ['https://my-own-rpc.example-node.io/base'],
    });
    await client.getChainId();
    expect(
      sameUrl((fetchFn.mock.calls[0] as FetchArgs)[0], 'https://my-own-rpc.example-node.io/base'),
    ).toBe(true);
  });

  it('retries a failing URL, then fails over to the next', async () => {
    const calls: string[] = [];
    const ok = rpcResult('0x14a34');
    const fetchFn = vi.fn(async (url: FetchInput, init?: RequestInit) => {
      calls.push(String(url));
      if (sameUrl(url, BASE_SEPOLIA.rpcUrls[0])) return new Response('busy', { status: 503 });
      return ok(url, init);
    });
    const client = createReadClient(config(), { fetchFn, retryCount: 2, retryDelayMs: 1 });
    expect(await client.getChainId()).toBe(84532);
    expect(calls.filter((u) => sameUrl(u, BASE_SEPOLIA.rpcUrls[0]))).toHaveLength(3);
    expect(calls.filter((u) => sameUrl(u, BASE_SEPOLIA.rpcUrls[1]))).toHaveLength(1);
  });

  it('times out a hanging URL and fails over', async () => {
    const ok = rpcResult('0x14a34');
    const fetchFn = vi.fn((url: FetchInput, init?: RequestInit) => {
      if (!sameUrl(url, BASE_SEPOLIA.rpcUrls[0])) return ok(url, init);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    const client = createReadClient(config(), {
      fetchFn,
      timeoutMs: 50,
      retryCount: 0,
      retryDelayMs: 1,
    });
    const started = Date.now();
    expect(await client.getChainId()).toBe(84532);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fetchFn.mock.calls.map(([u]) => new URL(String(u)).href)).toEqual([
      new URL(BASE_SEPOLIA.rpcUrls[0] as string).href,
      new URL(BASE_SEPOLIA.rpcUrls[1] as string).href,
    ]);
  });

  /** A user URL with a fake provider key in its path: no fragment of it may surface. */
  const CANARY_URL = 'https://canary-node.example-node.io/v3/canary0secret0key0abcdef0123456789';
  const CANARY_FRAGMENTS = ['canary-node', 'canary0secret', '/v3/', 'example-node.io'];

  /** Message, stack, JSON and every cause in the chain, as one string. */
  function everythingIn(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; current !== undefined && current !== null && depth < 16; depth++) {
      const e = current as { message?: unknown; stack?: unknown; cause?: unknown };
      parts.push(String(e.message), String(e.stack), JSON.stringify(current), String(current));
      for (const key of Object.getOwnPropertyNames(current)) {
        parts.push(`${key}=${String((current as Record<string, unknown>)[key])}`);
      }
      current = e.cause;
    }
    return parts.join('\n');
  }

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('expected a rejection');
  }

  it('fails when every URL fails, with a fixed code and no fragment of a user URL', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response('down', { status: 500 })));
    const client = createReadClient(config(), {
      fetchFn,
      retryCount: 0,
      retryDelayMs: 1,
      rpcUrls: [CANARY_URL],
    });
    const error = await rejection(client.getChainId());
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).code).toBe('rpc_unavailable');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    const text = everythingIn(error);
    for (const fragment of CANARY_FRAGMENTS) expect(text).not.toContain(fragment);
    expect(sameUrl((fetchFn.mock.calls[0] as unknown as FetchArgs)[0], CANARY_URL)).toBe(true);
  });

  it('a JSON-RPC error and a revert from a user URL leak no fragment of it', async () => {
    const revert = vi.fn(async (_url: FetchInput, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: 3, message: 'execution reverted', data: '0x' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = createReadClient(config(), { fetchFn: revert, rpcUrls: [CANARY_URL] });
    const reverted = await rejection(notaryReader(client, config()).read.paused());
    expect(reverted).toBeInstanceOf(ChainError);
    expect((reverted as ChainError).code).toBe('call_reverted');
    const rpcError = await rejection(client.getBlockNumber());
    expect(rpcError).toBeInstanceOf(ChainError);
    for (const error of [reverted, rpcError]) {
      const text = everythingIn(error);
      for (const fragment of CANARY_FRAGMENTS) expect(text).not.toContain(fragment);
    }
  });

  it('does not expose the RPC URLs on the client', () => {
    const client = createReadClient(config(), { fetchFn: vi.fn(), rpcUrls: [CANARY_URL] });
    expect(JSON.stringify(client.chain)).not.toContain('canary');
    expect(client.chain.rpcUrls.default.http).toEqual([]);
  });

  it('sends read methods only: no signing, accounts or transactions', async () => {
    const fetchFn = vi.fn(rpcResult('0x0'));
    const client = createReadClient(config(), { fetchFn });
    for (const method of [
      'eth_sendTransaction',
      'eth_sendRawTransaction',
      'eth_sign',
      'eth_signTypedData_v4',
      'personal_sign',
      'eth_accounts',
      'eth_requestAccounts',
      'wallet_addEthereumChain',
    ]) {
      await expect(
        client.request({ method, params: [] } as unknown as Parameters<typeof client.request>[0]),
      ).rejects.toMatchObject({ name: 'ChainError', code: 'method_refused' });
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect('sendRawTransaction' in client).toBe(true); // present at run time, refused above
    // @ts-expect-error the ReadClient type has no send method (IR-M1-4a-1 L-5)
    expect(typeof client.sendRawTransaction).toBe('function');
    expect(RPC_READ_METHODS).toContain('eth_call');
    expect(RPC_READ_METHODS.some((m) => /send|sign|account|wallet_|personal_/i.test(m))).toBe(
      false,
    );
  });

  it('refuses an RPC URL that breaks the rule, before any request, without echoing it', () => {
    for (const url of ['http://localhost:8545', 'https://127.0.0.1', 'https://k@node.example.io']) {
      let thrown: unknown;
      try {
        createReadClient(config(), { rpcUrls: [url], fetchFn: vi.fn() });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toEqual(expect.objectContaining({ code: 'bad_rpc_url' }));
      expect((thrown as Error).message).not.toContain(url);
    }
  });

  it('refuses out-of-range timeouts, retries and back-off, too many own URLs, and no fetch', () => {
    const fetchFn = vi.fn();
    const bad: Partial<Parameters<typeof createReadClient>[1]>[] = [
      { timeoutMs: 0 },
      { timeoutMs: 30_001 },
      { retryCount: -1 },
      { retryCount: 4 },
      { retryDelayMs: -1 },
      { retryDelayMs: 1_001 },
    ];
    for (const options of bad) {
      expect(() => createReadClient(config(), { fetchFn, ...options })).toThrow(
        expect.objectContaining({ code: 'bad_client_option' }),
      );
    }
    expect(() =>
      createReadClient(config(), {
        fetchFn,
        timeoutMs: 30_000,
        retryCount: 3,
        retryDelayMs: 1_000,
      }),
    ).not.toThrow();
    const own = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://rpc${'abcdef'[i] ?? 'z'}.example-node.io/x`);
    expect(MAX_USER_RPC_URLS).toBe(5);
    expect(() => createReadClient(config(), { fetchFn, rpcUrls: own(5) })).not.toThrow();
    expect(() => createReadClient(config(), { fetchFn, rpcUrls: own(6) })).toThrow(
      expect.objectContaining({ code: 'too_many_rpc_urls' }),
    );
    expect(() =>
      createReadClient(config(), {} as unknown as Parameters<typeof createReadClient>[1]),
    ).toThrow(expect.objectContaining({ code: 'bad_client_option' }));
  });
});

// --- client-safe calls only (FA L-1; 05 §5) -----------------------------------------------------

const ADMIN_NOTARY = Object.entries(FUNCTION_TAGS.OCCNotary)
  .filter(([, tag]) => tag !== 'client')
  .map(([name]) => name);
const NON_CLIENT_VAULT = Object.entries(FUNCTION_TAGS.OCCFeeVault)
  .filter(([, tag]) => tag !== 'client')
  .map(([name]) => name);

describe('calls: the client cannot encode admin, upgrade, module or pending functions', () => {
  it('the tag tables name the functions this test must refuse', () => {
    expect(ADMIN_NOTARY).toEqual(
      expect.arrayContaining(['pause', 'unpause', 'freezeUpgrades', 'upgradeToAndCall']),
    );
    expect(NON_CLIENT_VAULT).toEqual(
      expect.arrayContaining([
        'charge',
        'depositFromModule',
        'depositWithAuthorization',
        'upgradeToAndCall',
        'setProtocolFee',
        'registerModule',
        'setTreasury',
        'sweep',
        'registerApp',
      ]),
    );
  });

  it('the bound ABIs hold client-tagged functions only', () => {
    const fns = (abi: readonly { type: string; name?: string }[]) =>
      abi.filter((e) => e.type === 'function').map((e) => e.name as string);
    for (const name of fns(NOTARY_CLIENT_ABI)) {
      expect(FUNCTION_TAGS.OCCNotary[name as keyof typeof FUNCTION_TAGS.OCCNotary]).toBe('client');
    }
    for (const name of fns(FEE_VAULT_CLIENT_ABI)) {
      expect(FUNCTION_TAGS.OCCFeeVault[name as keyof typeof FUNCTION_TAGS.OCCFeeVault]).toBe(
        'client',
      );
    }
  });

  it('encodes a client call exactly as the full interface ABI would', () => {
    const signer = '0x52eaefebe4ec263f7ffd6ca678613e4d6195868a';
    expect(encodeNotaryCall({ functionName: 'computeRecordId', args: [signer, 7n] })).toBe(
      encodeFunctionData({
        abi: occNotaryAbi,
        functionName: 'computeRecordId',
        args: [signer, 7n],
      }),
    );
    expect(
      encodeFeeVaultCall({
        functionName: 'creditsOf',
        args: [signer, '0x036cbd53842c5426634e7929541ec2318f3dcf7e'],
      }),
    ).toBe(
      encodeFunctionData({
        abi: occFeeVaultAbi,
        functionName: 'creditsOf',
        args: [signer, '0x036cbd53842c5426634e7929541ec2318f3dcf7e'],
      }),
    );
  });

  it('refuses every non-client Notary function, at the type level and at run time', () => {
    // @ts-expect-error pause is an admin function, not in the client ABI
    expect(() => encodeNotaryCall({ functionName: 'pause' })).toThrow();
    // @ts-expect-error upgradeToAndCall is an upgrade function, not in the client ABI
    expect(() => encodeNotaryCall({ functionName: 'upgradeToAndCall' })).toThrow();
    // @ts-expect-error freezeUpgrades is an upgrade function, not in the client ABI
    expect(() => encodeNotaryCall({ functionName: 'freezeUpgrades' })).toThrow();
    for (const functionName of ADMIN_NOTARY) {
      expect(() =>
        encodeNotaryCall({ functionName } as unknown as Parameters<typeof encodeNotaryCall>[0]),
      ).toThrow();
    }
  });

  it('refuses every non-client vault function, depositWithAuthorization included', () => {
    // @ts-expect-error charge is module-only
    expect(() => encodeFeeVaultCall({ functionName: 'charge' })).toThrow();
    // @ts-expect-error depositWithAuthorization waits for M1-3c
    expect(() => encodeFeeVaultCall({ functionName: 'depositWithAuthorization' })).toThrow();
    for (const functionName of NON_CLIENT_VAULT) {
      expect(() =>
        encodeFeeVaultCall({ functionName } as unknown as Parameters<typeof encodeFeeVaultCall>[0]),
      ).toThrow();
    }
  });

  it('contract readers bind the client ABIs, read only, at the configured addresses', async () => {
    const fetchFn = vi.fn(rpcResult(`0x${'0'.repeat(64)}`));
    const client = createReadClient(config(), { fetchFn });
    const notary = notaryReader(client, config());
    const vault = feeVaultReader(client, config());
    expect(notary.address).toBe(config().contracts.notary);
    expect(vault.address).toBe(config().contracts.vault);
    expect('write' in notary).toBe(false);
    expect('write' in vault).toBe(false);
    expect(await notary.read.paused()).toBe(false);
    const call = JSON.parse(String((fetchFn.mock.calls.at(-1) as FetchArgs)[1].body)) as {
      method: string;
      params: [{ to: string }];
    };
    expect(call.method).toBe('eth_call');
    expect(call.params[0].to.toLowerCase()).toBe(config().contracts.notary);
    const reads = notary.read as unknown as Record<string, () => Promise<unknown>>;
    await expect(reads.pause?.()).rejects.toMatchObject({
      name: 'ChainError',
      code: 'invalid_call',
    });
  });
});
