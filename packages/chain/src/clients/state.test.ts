// M1-4c: the chain-state port over the read client (07 §6.2; 04 §5) and the direct-mode broadcaster.
// No network: an injected, branded fetch plays the RPC.
import {
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  type Hex as ViemHex,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { ChainConfig } from '../config/index.js';
import { ChainConfigError } from '../config/index.js';
import type { Hex } from '../ids/index.js';
import {
  ChainError,
  FEE_VAULT_CLIENT_ABI,
  NOTARY_CLIENT_ABI,
  checkDirectCall,
  createBroadcaster,
  createChainState,
  createReadClient,
  getChainConfig,
} from './index.js';

const config = getChainConfig(84532) as ChainConfig;
const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');
const filled = (byte: string): Hex => `0x${byte.repeat(20)}`;
const hash32 = (byte: string): Hex => `0x${byte.repeat(32)}`;
const PAYER = filled('11');

interface Req {
  method: string;
  params: unknown[];
}

function rpc(handler: (req: Req) => { result?: unknown; error?: unknown }) {
  const seen: Req[] = [];
  const impl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Req & { id: number };
    seen.push({ method: body.method, params: body.params });
    const out = handler(body);
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...out }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const fetchFn = vi.fn(impl);
  Object.defineProperty(fetchFn, ADDRESS_CHECKED, { value: true });
  return { fetchFn, seen };
}

function stateWith(handler: (req: Req) => { result?: unknown; error?: unknown }) {
  const { fetchFn, seen } = rpc(handler);
  const client = createReadClient(config, { fetchFn, retryCount: 0 });
  return { state: createChainState({ config, client }), seen };
}

const recordState = (signer: Hex) =>
  encodeFunctionResult({
    abi: NOTARY_CLIENT_ABI,
    functionName: 'getRecord',
    result: {
      signer,
      timestamp: 5n,
      kind: 1,
      receiptFlags: 0,
      envelopeHash: hash32('01'),
      recipientCommitment: hash32('02'),
      recordStructHash: hash32('03'),
      receiptAt: [7n, 0n, 0n, 0n],
    },
  } as never);

describe('createChainState', () => {
  it('getRecord: the stored state, at the given block', async () => {
    const { state, seen } = stateWith((req) => {
      if (req.method === 'eth_call') return { result: recordState(filled('22')) };
      if (req.method === 'eth_chainId') return { result: `0x${config.chainId.toString(16)}` };
      throw new Error(`unexpected ${req.method}`);
    });
    const got = await state.getRecord(hash32('aa'), 0x42n);
    expect(got).toEqual({
      signer: filled('22'),
      recordStructHash: hash32('03'),
      receiptAt: [7n, 0n, 0n, 0n],
    });
    const last = seen.filter((r) => r.method === 'eth_call').at(-1);
    expect(last?.params[1]).toBe('0x42');
  });

  it('getRecord: the Notary reverts RecordNotFound for an unknown ID; that reads as null', async () => {
    let error: string | null = 'RecordNotFound';
    const { state } = stateWith((req) => {
      if (req.method !== 'eth_call') throw new Error(`unexpected ${req.method}`);
      if (error === null) return { result: recordState(filled('22')) };
      return {
        error: {
          code: 3,
          message: 'execution reverted',
          data: encodeErrorResult({ abi: NOTARY_CLIENT_ABI, errorName: error as never }),
        },
      };
    });
    expect(await state.getRecord(hash32('aa'))).toBeNull();
    expect(await state.getRecord(hash32('aa'), 9n)).toBeNull();
    // Any other revert is not "absent": it fails, so nothing is decided from it.
    error = 'EnforcedPause';
    await expect(state.getRecord(hash32('aa'))).rejects.toBeInstanceOf(ChainError);
  });

  it('getRecord (M1-4d-h): only the bare RecordNotFound() selector reads as absent', async () => {
    // viem names a no-argument error from its selector and ignores any bytes after it, so a buggy
    // or malicious RPC could dress another answer up as RecordNotFound. Only the exact 4-byte
    // selector is the Notary's "absent"; anything else fails, so no replacement is decided on it.
    const bare = encodeErrorResult({
      abi: NOTARY_CLIENT_ABI,
      errorName: 'RecordNotFound' as never,
    });
    const errorString = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
      errorName: 'Error',
      args: ['RecordNotFound'],
    });
    let data: string = bare;
    const { state } = stateWith((req) => {
      if (req.method !== 'eth_call') throw new Error(`unexpected ${req.method}`);
      return { error: { code: 3, message: 'execution reverted', data } };
    });
    expect(bare).toMatch(/^0x[0-9a-f]{8}$/);
    for (const at of [undefined, 9n]) expect(await state.getRecord(hash32('aa'), at)).toBeNull();
    for (const notAbsent of [
      `${bare}${'00'.repeat(32)}`, // the same selector with extra bytes
      `${bare}ff`, // the same selector with one trailing byte
      errorString, // Error(string) whose text is the name
      '0x', // an empty revert
    ]) {
      data = notAbsent;
      for (const at of [undefined, 9n]) {
        const read = state.getRecord(hash32('aa'), at);
        await expect(read).rejects.toBeInstanceOf(ChainError);
        await expect(read).rejects.toMatchObject({ code: 'call_reverted' });
      }
    }
  });

  it('getRecord (M1-4c-d): a zero-signer struct is a bad answer, never "absent"', async () => {
    // The Notary never returns an empty slot: an unknown ID reverts RecordNotFound. A struct with a
    // zero signer comes from a misbehaving RPC or contract, so nothing may be decided on it.
    const { state } = stateWith((req) => {
      if (req.method === 'eth_call') return { result: recordState(filled('00')) };
      throw new Error(`unexpected ${req.method}`);
    });
    for (const at of [undefined, 9n]) {
      const read = state.getRecord(hash32('aa'), at);
      await expect(read).rejects.toBeInstanceOf(ChainError);
      await expect(read).rejects.toMatchObject({ code: 'bad_answer' });
    }
  });

  it('block: reads the finalized tag and a number', async () => {
    const { state, seen } = stateWith((req) => {
      if (req.method === 'eth_getBlockByNumber') {
        return { result: { number: '0x10', timestamp: '0x20' } };
      }
      throw new Error(`unexpected ${req.method}`);
    });
    expect(await state.block('finalized')).toEqual({ number: 16n, timestamp: 32n });
    await state.block(5n);
    expect(seen.map((r) => r.params[0])).toEqual(['finalized', '0x5']);
  });

  it('block: a missing block is a ChainError, never a zero timestamp', async () => {
    const { state } = stateWith(() => ({ result: null }));
    await expect(state.block('finalized')).rejects.toBeInstanceOf(ChainError);
  });

  it('txStatus: pending, success, reverted', async () => {
    let receipt: unknown = null;
    const { state } = stateWith(() => ({ result: receipt }));
    expect(await state.txStatus(hash32('aa'))).toBe('pending');
    receipt = { status: '0x1', blockNumber: '0x1' };
    expect(await state.txStatus(hash32('aa'))).toBe('success');
    receipt = { status: '0x0', blockNumber: '0x1' };
    expect(await state.txStatus(hash32('aa'))).toBe('reverted');
  });

  it('simulate: a revert names the contract error; success returns the estimated gas', async () => {
    let revert = true;
    const { state, seen } = stateWith((req) => {
      if (req.method === 'eth_call') {
        if (!revert) return { result: '0x' };
        return {
          error: {
            code: 3,
            message: 'execution reverted',
            data: encodeErrorResult({
              abi: NOTARY_CLIENT_ABI,
              errorName: 'InsufficientCredits',
              args: [PAYER, PAYER, 5n, 0n],
            }),
          },
        };
      }
      if (req.method === 'eth_estimateGas') return { result: '0x1d4c0' };
      throw new Error(`unexpected ${req.method}`);
    });
    const tx = {
      contract: 'vault' as const,
      to: config.contracts.vault,
      from: PAYER,
      value: 0n,
      functionName: 'deposit',
      args: [config.feeTokens[0]?.address as Hex, 5n],
    };
    expect(await state.simulate(tx)).toEqual({ ok: false, error: 'InsufficientCredits' });
    revert = false;
    expect(await state.simulate(tx)).toEqual({ ok: true, gas: 120_000n });
    const call = seen.find((r) => r.method === 'eth_call');
    const sent = call?.params[0] as { from: string; to: string; data: ViemHex };
    expect(sent.from.toLowerCase()).toBe(PAYER);
    expect(decodeFunctionData({ abi: FEE_VAULT_CLIENT_ABI, data: sent.data }).functionName).toBe(
      'deposit',
    );
  });

  it('simulate: refuses any function outside the direct-mode set before a request', async () => {
    const { state, seen } = stateWith(() => ({ result: '0x' }));
    for (const [contract, functionName] of [
      ['vault', 'depositFor'],
      ['vault', 'withdrawIntegrator'],
      ['vault', 'depositWithAuthorization'],
      ['notary', 'pause'],
      ['erc20', 'transfer'],
    ] as const) {
      await expect(
        state.simulate({
          contract,
          to: config.contracts.vault,
          from: PAYER,
          value: 0n,
          functionName,
          args: [],
        }),
      ).rejects.toMatchObject({ code: 'invalid_call' });
    }
    expect(seen).toHaveLength(0);
  });
});

describe('checkDirectCall (M1-4c-b)', () => {
  it('allows withdraw on the vault, for the typed withdraw API (sendWithdraw)', () => {
    expect(() => checkDirectCall({ contract: 'vault', functionName: 'withdraw' })).not.toThrow();
    expect(() => checkDirectCall({ contract: 'notary', functionName: 'withdraw' })).toThrow(
      ChainError,
    );
  });
});

describe('createBroadcaster', () => {
  it('requires the address-checked fetch', () => {
    expect(() => createBroadcaster(config, { fetchFn: fetch as never })).toThrow(ChainConfigError);
  });

  it('sends only eth_sendRawTransaction; a JSON-RPC error is a fixed-text ChainError', async () => {
    let fail = false;
    const { fetchFn, seen } = rpc(() =>
      fail
        ? { error: { code: -32000, message: 'nonce too low at https://x' } }
        : { result: hash32('ab') },
    );
    const broadcast = createBroadcaster(config, { fetchFn });
    await broadcast('0x02f0');
    expect(seen).toEqual([{ method: 'eth_sendRawTransaction', params: ['0x02f0'] }]);
    fail = true;
    const err = await broadcast('0x02f0').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainError);
    expect(String((err as Error).message)).not.toMatch(/https|nonce/);
  });
});
