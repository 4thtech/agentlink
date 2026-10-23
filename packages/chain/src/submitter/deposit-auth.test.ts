// M3-4b-t-2: the `POST /v1/deposit-authorization` wire format and client (07 §7; 04 §2.4.1 `auth`;
// 05 §2.5). Requests and answers are parsed strictly; errors never echo a signature or a URL. No
// network: the submitters are a mock fetch.
//
// Keys here are test values built at run time (a repeated byte), never a real secret.
import { encodeHex0x, hashTypedData, receiveWithAuthorizationTypedData } from '@4thtech-io/crypto';
import type { Hex as ViemHex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import type { Hex } from '../ids/index.js';
import {
  DEPOSIT_AUTH_ERROR_CODES,
  SubmitterError,
  createDepositAuthClient,
  depositAuthorizationRequestBody,
  parseDepositAuthorizationRequest,
  parseDepositAuthorizationResponse,
  type DepositAuthorizationRequest,
} from './index.js';

const testKey = (byte: string): ViemHex => `0x${byte.repeat(32)}` as ViemHex;
const AGENT_KEY = testKey('a1');
const AGENT = privateKeyToAccount(AGENT_KEY).address.toLowerCase() as Hex;
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' as Hex;
const VAULT = `0x${'5a'.repeat(20)}` as Hex;
const N = (byte: string): Hex => `0x${byte.repeat(32)}` as Hex;
const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');

async function signedRequest(): Promise<DepositAuthorizationRequest> {
  const auth = {
    from: AGENT,
    to: VAULT,
    value: '10000000',
    validAfter: '0',
    validBefore: '1800000900',
    nonce: N('3c'),
  };
  const td = receiveWithAuthorizationTypedData(
    { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC },
    auth,
  );
  const sig = (await sign({
    hash: encodeHex0x(hashTypedData(td).digest) as ViemHex,
    privateKey: AGENT_KEY,
    to: 'hex',
  })) as string;
  return {
    chainId: 84532,
    token: USDC,
    auth: {
      ...auth,
      r: `0x${sig.slice(2, 66)}` as Hex,
      s: `0x${sig.slice(66, 130)}` as Hex,
      v: Number.parseInt(sig.slice(130, 132), 16) as 27 | 28,
    },
  };
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe('parseDepositAuthorizationRequest', () => {
  it('round-trips the request body through JSON', async () => {
    const req = await signedRequest();
    const body = depositAuthorizationRequestBody(req);
    expect(Object.keys(body).sort()).toEqual(['auth', 'chainId', 'token']);
    const parsed = parseDepositAuthorizationRequest(JSON.parse(JSON.stringify(body)));
    expect(parsed).toEqual(req);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.auth)).toBe(true);
  });

  it('refuses unknown or missing fields at every level', async () => {
    const req = await signedRequest();
    const bodies: unknown[] = [
      { ...req, extra: 1 },
      { chainId: req.chainId, auth: req.auth },
      { ...req, auth: { ...req.auth, extra: 1 } },
      { ...req, auth: { ...req.auth, signature: '0x' } },
      { ...req, auth: (({ nonce: _n, ...rest }) => rest)(req.auth) },
      { ...req, auth: (({ v: _v, ...rest }) => rest)(req.auth) },
      null,
      [],
      'x',
    ];
    for (const body of bodies) {
      expect(() => parseDepositAuthorizationRequest(body)).toThrow(
        expect.objectContaining({ code: 'invalid_deposit_auth_body' }),
      );
    }
  });

  it('refuses other spellings: upper-case hex, bare hex, numbers for amounts, v outside {27, 28}', async () => {
    const req = await signedRequest();
    const up = (s: string) => `0x${s.slice(2).toUpperCase()}`;
    const bad: unknown[] = [
      { ...req, chainId: 0 },
      { ...req, chainId: '84532' },
      { ...req, token: up(USDC) },
      { ...req, auth: { ...req.auth, from: up(AGENT) } },
      { ...req, auth: { ...req.auth, to: up(VAULT) } },
      { ...req, auth: { ...req.auth, nonce: up(req.auth.nonce) } },
      { ...req, auth: { ...req.auth, nonce: req.auth.nonce.slice(2) } },
      { ...req, auth: { ...req.auth, value: 10_000_000 } },
      { ...req, auth: { ...req.auth, value: '010' } },
      { ...req, auth: { ...req.auth, value: (2n ** 256n).toString() } },
      { ...req, auth: { ...req.auth, validBefore: '0' } },
      { ...req, auth: { ...req.auth, v: 0 } },
      { ...req, auth: { ...req.auth, v: 1 } },
      { ...req, auth: { ...req.auth, v: '27' } },
      { ...req, auth: { ...req.auth, r: up(req.auth.r) } },
      { ...req, auth: { ...req.auth, s: `0x${'00'.repeat(32)}` } },
    ];
    for (const body of bad) {
      expect(() => parseDepositAuthorizationRequest(body)).toThrow(
        expect.objectContaining({ code: 'invalid_deposit_auth_body' }),
      );
    }
  });

  it('refuses the malleated high-s twin of a valid signature', async () => {
    const req = await signedRequest();
    const highS = SECP256K1_N - BigInt(req.auth.s);
    const twin = {
      ...req,
      auth: {
        ...req.auth,
        s: `0x${highS.toString(16).padStart(64, '0')}`,
        v: req.auth.v === 27 ? 28 : 27,
      },
    };
    expect(() => parseDepositAuthorizationRequest(twin)).toThrow(
      expect.objectContaining({ code: 'invalid_deposit_auth_body' }),
    );
  });

  it('never echoes the input in an error', async () => {
    const req = await signedRequest();
    try {
      parseDepositAuthorizationRequest({ ...req, auth: { ...req.auth, v: 0 } });
      expect.unreachable();
    } catch (e) {
      const text = `${(e as Error).message} ${JSON.stringify(e)}`;
      expect(text).not.toContain(req.auth.r.slice(2, 20));
      expect(text).not.toContain(AGENT.slice(2, 20));
    }
  });
});

describe('parseDepositAuthorizationResponse', () => {
  it('accepts submitted with a txHash, and failed with a fixed code', () => {
    expect(parseDepositAuthorizationResponse({ status: 'submitted', txHash: N('55') })).toEqual({
      status: 'submitted',
      txHash: N('55'),
    });
    for (const error of DEPOSIT_AUTH_ERROR_CODES) {
      expect(parseDepositAuthorizationResponse({ status: 'failed', error })).toEqual({
        status: 'failed',
        error,
      });
    }
    expect(
      parseDepositAuthorizationResponse({
        status: 'failed',
        error: 'simulation_failed',
        txHash: N('66'),
      }),
    ).toEqual({ status: 'failed', error: 'simulation_failed', txHash: N('66') });
  });

  it('pins the error codes T3 answers with', () => {
    expect([...DEPOSIT_AUTH_ERROR_CODES].sort()).toEqual(
      [
        'above_max_top_up',
        'already_used',
        'below_min_deposit',
        'expired',
        'gas_too_high',
        'gasless_unavailable',
        'invalid_signature',
        'invalid_window',
        'not_vault',
        'rate_limited',
        'simulation_failed',
        'unavailable',
        'unsupported_chain',
      ].sort(),
    );
  });

  it('refuses anything else', () => {
    const bad: unknown[] = [
      { status: 'submitted' },
      { status: 'submitted', txHash: N('55'), error: 'expired' },
      { status: 'submitted', txHash: N('55').toUpperCase() },
      { status: 'failed' },
      { status: 'failed', error: 'Something happened' },
      { status: 'failed', error: 'not_a_known_code' },
      { status: 'recorded', txHash: N('55') },
      { status: 'submitted', txHash: N('55'), extra: true },
      null,
    ];
    for (const value of bad) {
      expect(() => parseDepositAuthorizationResponse(value)).toThrow(
        expect.objectContaining({ code: 'invalid_submitter_answer' }),
      );
    }
  });
});

// --- the client (failover; 07 §6.2, §7) ----------------------------------------------------------

function clientFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  Object.defineProperty(fn, ADDRESS_CHECKED, { value: true });
  return fn;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createDepositAuthClient', () => {
  const A = 'https://submitter-a.example-host.io';
  const B = 'https://submitter-b.example-host.io/base';

  it('refuses a plain fetch and a URL that breaks the 04 §4 rule', () => {
    expect(() =>
      createDepositAuthClient({ urls: [A], fetchFn: (async () => json(200, {})) as typeof fetch }),
    ).toThrow();
    const fetchFn = clientFetch(() => json(200, {})) as unknown as typeof fetch;
    expect(() =>
      createDepositAuthClient({ urls: ['http://submitter-a.example-host.io'], fetchFn }),
    ).toThrow();
    expect(() => createDepositAuthClient({ urls: [], fetchFn })).toThrow();
  });

  it('posts the signed authorization as JSON, without redirects or credentials', async () => {
    const req = await signedRequest();
    const fetchFn = clientFetch((url, init) => {
      expect(url).toBe(`${A}/v1/deposit-authorization`);
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.credentials).toBe('omit');
      expect(JSON.parse(String(init.body))).toEqual(JSON.parse(JSON.stringify(req)));
      return json(200, { status: 'submitted', txHash: N('55') });
    });
    const client = createDepositAuthClient({
      urls: [A],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await client.submit(req)).toEqual({ status: 'submitted', txHash: N('55') });
  });

  it('fails over on a network error, a 5xx, a 429, an unserved chain or a malformed answer', async () => {
    const req = await signedRequest();
    const firsts: (() => Response)[] = [
      () => {
        throw new TypeError('down');
      },
      () => json(503, { error: 'unavailable' }),
      () => json(429, { error: 'rate_limited' }),
      () => json(400, { error: 'unsupported_chain' }),
      () => json(404, { error: 'not_found' }),
      () => json(501, { error: 'not_available' }),
      () => json(200, { status: 'submitted' }),
      () => new Response('not json', { status: 200 }),
    ];
    for (const first of firsts) {
      const seen: string[] = [];
      const fetchFn = clientFetch((url) => {
        seen.push(url);
        return new URL(url).origin === new URL(A).origin
          ? first()
          : json(200, { status: 'submitted', txHash: N('77') });
      });
      const client = createDepositAuthClient({
        urls: [A, B],
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      expect((await client.submit(req)).txHash).toBe(N('77'));
      expect(seen).toEqual([`${A}/v1/deposit-authorization`, `${B}/v1/deposit-authorization`]);
    }
  });

  it('stops at a refusal of the request itself, with the fixed code and no URL', async () => {
    const req = await signedRequest();
    const seen: string[] = [];
    const fetchFn = clientFetch((url) => {
      seen.push(url);
      return json(400, { error: 'below_min_deposit' });
    });
    const client = createDepositAuthClient({
      urls: [A, B],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const err = await client.submit(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmitterError);
    expect((err as SubmitterError).code).toBe('refused');
    expect((err as SubmitterError).reason).toBe('below_min_deposit');
    expect((err as Error).message).not.toContain('example-host');
    expect(seen).toHaveLength(1);
  });

  it('refuses a malformed request before any request is sent', async () => {
    const req = await signedRequest();
    const fetchFn = clientFetch(() => json(200, { status: 'submitted', txHash: N('55') }));
    const client = createDepositAuthClient({
      urls: [A],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const bad = { ...req, auth: { ...req.auth, v: 1 } } as unknown as DepositAuthorizationRequest;
    const err = await client.submit(bad).catch((e: unknown) => e);
    expect((err as SubmitterError).code).toBe('invalid_input');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('every submitter down: unavailable, fixed text', async () => {
    const req = await signedRequest();
    const fetchFn = clientFetch(() => json(503, {}));
    const client = createDepositAuthClient({
      urls: [A, B],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const err = await client.submit(req).catch((e: unknown) => e);
    expect((err as SubmitterError).code).toBe('unavailable');
  });
});
