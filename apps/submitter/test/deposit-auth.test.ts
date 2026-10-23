// M3-4b-t-3: `POST /v1/deposit-authorization` under Miniflare (07 §7; 05 §2.5; 04 §7; 12 §4.1).
// Every request goes through the Worker's own fetch handler with its Durable Objects; each chain's
// relay is the FakeRelay of fake-relay.ts (the relay's own checks are tested in packages/chain).
// The test settings (vitest.config.ts) enable Base Sepolia and allow 12 requests per IP per hour;
// the per-agent limit is the default, 5 per hour. Agents, nonces and IPs are distinct per test.
// Nothing here is a real key or signature.
import { SELF, createExecutionContext, env as testEnv, runInDurableObject } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChainConfig, type Hex } from '@4thtech-io/chain';
import type { SubmitterEnv } from '../src/worker.js';
import { METRICS } from '../src/limits.js';
import worker from './worker-entry.js';
import { FakeRelay, fakeRelays } from './fake-relay.js';

const env = testEnv as SubmitterEnv;
const HOST = 'https://submitter.test';
const CHAIN_ID = 84532;
const config = getChainConfig(CHAIN_ID);
if (!config) throw new Error('test setup: no Base Sepolia deployment');
const VAULT = config.contracts.vault.toLowerCase() as Hex;
const TOKEN = `0x${'c5'.repeat(20)}` as Hex;
const PINNED_NOW = new Date('2030-01-01T11:30:00Z');
const NOW = Math.floor(PINNED_NOW.getTime() / 1000);

let relay: FakeRelay;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
  relay = new FakeRelay(CHAIN_ID, VAULT);
  fakeRelays.set(CHAIN_ID, relay);
});
afterEach(() => {
  vi.useRealTimers();
});

// Everything a log line or metric must never contain (lowercase, without `0x`).
const secrets = new Set<string>();
const captured: string[] = [];
const originals = new Map<string, (...args: unknown[]) => void>();
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const;
beforeAll(() => {
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const method of METHODS) {
    const original = target[method];
    if (original) originals.set(method, original);
    target[method] = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    };
  }
});
afterAll(() => {
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const [method, original] of originals) target[method] = original;
});

let counter = 0;
const next = (): number => {
  counter += 1;
  return counter;
};
function newAgent(): Hex {
  const agent = `0x${next().toString(16).padStart(40, 'a')}` as Hex;
  secrets.add(agent.slice(2));
  return agent;
}
let ipCounter = 0;
function newIp(): string {
  ipCounter += 1;
  if (ipCounter > 250) throw new Error('test setup: out of IPs');
  const ip = `203.0.113.${String(ipCounter)}`;
  secrets.add(ip);
  return ip;
}

interface AuthOptions {
  readonly from?: Hex;
  readonly to?: Hex;
  readonly value?: string;
  readonly validAfter?: string;
  readonly validBefore?: string;
  readonly nonce?: Hex;
  readonly r?: Hex;
  readonly chainId?: number;
}

/** A well-formed request ($10 of a 6-decimal token, valid for 15 minutes). */
function request(o: AuthOptions = {}) {
  const nonce = o.nonce ?? (`0x${next().toString(16).padStart(64, '9')}` as Hex);
  const r = o.r ?? (`0x${next().toString(16).padStart(64, '1')}` as Hex);
  const s = `0x${'22'.repeat(32)}` as Hex;
  secrets.add(nonce.slice(2));
  secrets.add(r.slice(2));
  secrets.add(s.slice(2));
  return {
    chainId: o.chainId ?? CHAIN_ID,
    token: TOKEN,
    auth: {
      from: o.from ?? newAgent(),
      to: o.to ?? VAULT,
      value: o.value ?? '10000000',
      validAfter: o.validAfter ?? '0',
      validBefore: o.validBefore ?? String(NOW + 900),
      nonce,
      v: 27,
      r,
      s,
    },
  };
}

function post(body: unknown, ip = newIp()): Promise<Response> {
  return SELF.fetch(`${HOST}/v1/deposit-authorization`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function answer(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('the switch (SUBMITTER_DEPOSIT_AUTH_CHAINS)', () => {
  it('keeps the route present but disabled while the flag is unset', async () => {
    for (const flag of [undefined, '']) {
      const off = { ...env, SUBMITTER_DEPOSIT_AUTH_CHAINS: flag } as SubmitterEnv;
      const res = await worker.fetch(
        new Request(`${HOST}/v1/deposit-authorization`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': newIp() },
          body: JSON.stringify(request()),
        }),
        off,
        createExecutionContext(),
      );
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: 'not_available' });
    }
    expect(relay.checks).toHaveLength(0);
    expect(relay.sends).toHaveLength(0);
  });

  it('answers 405 to anything but POST', async () => {
    const res = await SELF.fetch(`${HOST}/v1/deposit-authorization`);
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'method_not_allowed' });
  });

  it('refuses a chain the flag does not name before any chain read', async () => {
    const { status, body } = await answer(await post(request({ chainId: 10200 })));
    expect(status).toBe(400);
    expect(body).toEqual({ status: 'failed', error: 'unsupported_chain' });
    expect(relay.checks).toHaveLength(0);
  });

  it('is unavailable while the relay is not configured (no gas key or relay ABI)', async () => {
    fakeRelays.delete(CHAIN_ID);
    const { status, body } = await answer(await post(request()));
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'failed', error: 'unavailable' });
  });

  it('leaves /v1/health as it was', async () => {
    const res = await SELF.fetch(`${HOST}/v1/health`, { headers: { 'cf-connecting-ip': newIp() } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chains: Record<string, unknown>[] };
    expect(Object.keys(body).sort()).toEqual(['chains', 'ok']);
    for (const chain of body.chains) {
      expect(Object.keys(chain).sort()).toEqual([
        'available',
        'chainId',
        'faucet',
        'gas',
        'gasBalance',
        'queueDepth',
      ]);
    }
  });
});

describe('a valid authorization', () => {
  it('runs the relay checks, then sends once at the gas wallet nonce with the checked gas', async () => {
    const req = request();
    const { status, body } = await answer(await post(req));
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'submitted', txHash: relay.sends[0]?.hash });
    expect(relay.checks).toEqual([req]);
    expect(relay.sends).toHaveLength(1);
    expect(relay.sends[0]?.request).toEqual(req);
    expect(relay.sends[0]?.gasLimit).toBe(90_000n);
    expect(relay.sends[0]?.nonce).toBe(7);
  });

  it('answers a repeated identical request with the same transaction, never a second send', async () => {
    const req = request();
    const first = await answer(await post(req));
    const second = await answer(await post(req));
    expect(first.status).toBe(200);
    expect(second).toEqual(first);
    expect(relay.sends).toHaveLength(1);
    expect(relay.checks).toHaveLength(1);
  });

  it('sends concurrent identical requests once', async () => {
    relay.sendDelayMs = 20;
    const req = request();
    const all = await Promise.all(
      [post(req), post(req), post(req)].map(async (r) => answer(await r)),
    );
    expect(relay.sends).toHaveLength(1);
    for (const a of all) {
      expect(a).toEqual({
        status: 200,
        body: { status: 'submitted', txHash: relay.sends[0]?.hash },
      });
    }
  });

  it('serialises the gas wallet nonce across concurrent authorizations', async () => {
    relay.sendDelayMs = 10;
    const all = await Promise.all([post(request()), post(request()), post(request())]);
    for (const res of all) expect(res.status).toBe(200);
    // One relay instance serves the whole file and remembers its next nonce: consecutive, distinct.
    const nonces = relay.sends.map((s) => s.nonce).sort((a, b) => a - b);
    const first = nonces[0] ?? -1;
    expect(first).toBeGreaterThanOrEqual(7);
    expect(nonces).toEqual([first, first + 1, first + 2]);
  });

  it('keeps its own next nonce while the chain lags behind its sends', async () => {
    expect((await post(request())).status).toBe(200);
    const first = relay.sends[0]?.nonce ?? -1;
    relay.pending = first; // an RPC node that has not seen the first transaction yet
    expect((await post(request())).status).toBe(200);
    expect(relay.sends.map((s) => s.nonce)).toEqual([first, first + 1]);
  });

  it('refuses a different authorization under a used (from, nonce), never sending it', async () => {
    const req = request();
    expect((await post(req)).status).toBe(200);
    const other = request({ from: req.auth.from, nonce: req.auth.nonce, value: '20000000' });
    const { status, body } = await answer(await post(other));
    expect(status).toBe(409);
    expect(body).toEqual({ status: 'failed', error: 'already_used' });
    expect(relay.sends).toHaveLength(1);
  });

  it('reports a sent transaction that reverted on a repeat', async () => {
    const req = request();
    const first = await answer(await post(req));
    relay.statuses.set(first.body.txHash as string, 'reverted');
    const { status, body } = await answer(await post(req));
    expect(status).toBe(200);
    expect(body).toEqual({
      status: 'failed',
      error: 'simulation_failed',
      txHash: first.body.txHash,
    });
    expect(relay.sends).toHaveLength(1);
  });

  it('is unavailable when the send fails, and reads the nonce from the chain again', async () => {
    relay.failSend = true;
    const req = request();
    expect(await answer(await post(req))).toEqual({
      status: 503,
      body: { status: 'failed', error: 'unavailable' },
    });
    relay.failSend = false;
    relay.pending = 3;
    expect((await post(req)).status).toBe(200);
    expect(relay.sends.map((s) => s.nonce)).toEqual([3]);
  });
});

describe('refusals before any send', () => {
  it('refuses a malformed body with a fixed code and no chain read', async () => {
    const good = request();
    const bodies: unknown[] = [
      'not json',
      [],
      { ...good, extra: 1 },
      { chainId: CHAIN_ID, token: TOKEN },
      { ...good, token: TOKEN.toUpperCase().replace('0X', '0x') },
      { ...good, auth: { ...good.auth, v: 29 } },
      { ...good, auth: { ...good.auth, s: `0x${'ff'.repeat(32)}` } },
      { ...good, auth: { ...good.auth, value: 10_000_000 } },
      { ...good, auth: { ...good.auth, from: good.auth.from.toUpperCase().replace('0X', '0x') } },
      { ...good, auth: { ...good.auth, signature: '0x00' } },
    ];
    for (const body of bodies) {
      const res = await answer(await post(body));
      expect(res, JSON.stringify(body)).toEqual({ status: 400, body: { error: 'bad_request' } });
    }
    expect(relay.checks).toHaveLength(0);
  });

  it('refuses a body over the size limit', async () => {
    const res = await post(JSON.stringify({ ...request(), pad: 'x'.repeat(4096) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
  });

  it('refuses a payee other than the chain vault before any chain read', async () => {
    const { status, body } = await answer(
      await post(request({ to: `0x${'0b'.repeat(20)}` as Hex })),
    );
    expect(status).toBe(400);
    expect(body).toEqual({ status: 'failed', error: 'not_vault' });
    expect(relay.checks).toHaveLength(0);
  });

  it('refuses an expired, nearly expired, early or too long window before any chain read', async () => {
    const cases: [AuthOptions, string][] = [
      [{ validBefore: String(NOW - 1) }, 'expired'],
      [{ validBefore: String(NOW + 60) }, 'expired'],
      [{ validAfter: String(NOW), validBefore: String(NOW + 900) }, 'invalid_window'],
      [{ validAfter: String(NOW + 100), validBefore: String(NOW + 900) }, 'invalid_window'],
      [{ validBefore: String(NOW + 900 + 121) }, 'invalid_window'],
    ];
    for (const [o, error] of cases) {
      const res = await answer(await post(request(o)));
      expect(res, error).toEqual({ status: 400, body: { status: 'failed', error } });
    }
    expect(relay.checks).toHaveLength(0);
  });

  it('never sends when the relay check refuses, answering its fixed code', async () => {
    const cases: [string, number][] = [
      ['below_min_deposit', 400],
      ['above_max_top_up', 400],
      ['gasless_unavailable', 400],
      ['invalid_signature', 400],
      ['simulation_failed', 400],
      ['gas_too_high', 400],
      ['expired', 400],
      ['already_used', 409],
    ];
    for (const [error, status] of cases) {
      relay.checkAnswer = { ok: false, error } as never;
      const res = await answer(await post(request()));
      expect(res, error).toEqual({ status, body: { status: 'failed', error } });
    }
    expect(relay.checks).toHaveLength(cases.length);
    expect(relay.sends).toHaveLength(0);
  });

  it('is unavailable when the relay check cannot read the chain', async () => {
    relay.failCheck = true;
    const res = await answer(await post(request()));
    expect(res).toEqual({ status: 503, body: { status: 'failed', error: 'unavailable' } });
    expect(relay.sends).toHaveLength(0);
  });
});

describe('rate limits', () => {
  it('allows 5 top-ups per agent per hour, then refuses without sending', async () => {
    const from = newAgent();
    for (let i = 0; i < 5; i += 1) {
      expect((await post(request({ from }))).status).toBe(200);
    }
    const res = await post(request({ from }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ status: 'failed', error: 'rate_limited' });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(relay.sends).toHaveLength(5);
    // Another agent is not affected.
    expect((await post(request())).status).toBe(200);
  });

  it('counts only authorizations that pass the checks, so a forged `from` cannot block an agent', async () => {
    const from = newAgent();
    relay.checkAnswer = (r) =>
      r.auth.r.endsWith('ff')
        ? { ok: false, error: 'invalid_signature' }
        : { ok: true, gasLimit: 90_000n };
    for (let i = 0; i < 6; i += 1) {
      const forged = request({ from, r: `0x${String(i).padStart(62, '3')}ff` as Hex });
      expect((await post(forged)).status).toBe(400);
    }
    expect((await post(request({ from }))).status).toBe(200);
  });

  it('allows 12 requests per IP per hour, whatever their outcome, then refuses before reading', async () => {
    const ip = newIp();
    for (let i = 0; i < 12; i += 1) expect((await post('not json', ip)).status).toBe(400);
    const res = await post(request(), ip);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ status: 'failed', error: 'rate_limited' });
    expect(relay.checks).toHaveLength(0);
  });
});

describe('logging canary (07 §7, I-7)', () => {
  it('stored nothing that ties an IP to an agent', async () => {
    const req = request();
    expect((await post(req)).status).toBe(200);
    const stub = env.SUBMITTER_DEPOSIT_RELAY!.get(
      env.SUBMITTER_DEPOSIT_RELAY!.idFromName(`deposit:${String(CHAIN_ID)}`),
    );
    const stored = await runInDurableObject(stub, async (_i, state) =>
      JSON.stringify([...(await state.storage.list()).entries()]),
    );
    for (const secret of secrets) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(secret)) expect(stored).not.toContain(secret);
    }
    expect(stored).not.toContain(req.auth.r.slice(2));
    expect(stored).not.toContain(req.auth.s.slice(2));
  });

  it('wrote nothing to the console and kept only fixed counter names', async () => {
    expect(secrets.size).toBeGreaterThan(40);
    const all = captured.join('\n').toLowerCase();
    for (const secret of secrets) expect(all).not.toContain(secret);
    const stub = env.SUBMITTER_LIMITS.get(env.SUBMITTER_LIMITS.idFromName('metrics'));
    const metrics =
      (await runInDurableObject(stub, (_i, state) =>
        state.storage.get<Record<string, unknown>>('m'),
      )) ?? {};
    for (const name of ['request_deposit_auth', 'deposit_auth_submitted', 'deposit_auth_refused']) {
      expect(METRICS as readonly string[]).toContain(name);
      expect(metrics[name]).toBeGreaterThan(0);
    }
    const text = JSON.stringify(metrics).toLowerCase();
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});
