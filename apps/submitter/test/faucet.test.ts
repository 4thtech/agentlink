// M1-10b, M1-10b-b: the testnet credits faucet under Miniflare (05 §9; 03 §4.4; audit-rules SUB-7; 04 §7).
// Every request goes through the Worker's own fetch handler (SELF) with its Durable Objects; the
// faucet wallet is the FakeFaucet (test/worker-entry.ts). Test limits (vitest.config.ts): 2 claims
// per IP per day, a global cap of 10 claims per day, 20 faucet requests per IP per hour; one claim
// per agent per day (default). Agents and IPs are distinct per test unless a test shares them.
//
// The global cap test runs last: it fills what is left of the day's cap with concurrent claims.
// The canary at the end searches the console for every IP and agent address used.
import { SELF } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hex } from '@4thtech-io/chain';
import { FakeFaucet, fakeFaucets } from './fake-faucet.js';

const HOST = 'https://submitter.test';
const CHAIN_ID = 84532;
const DAILY_CAP = 10;

const faucet = new FakeFaucet(CHAIN_ID);
beforeEach(() => {
  faucet.mode = 'sent';
  faucet.tokenUsdCents = 10_000n;
  faucet.nativeWei = 10n ** 17n;
  faucet.failBalances = false;
  fakeFaucets.set(CHAIN_ID, faucet);
});

const secrets = new Set<string>();
const captured: string[] = [];
const METHODS = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'dir',
  'dirxml',
  'table',
  'assert',
] as const;
const originals = new Map<string, (...args: unknown[]) => void>();

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

let agentCounter = 0;
function newAgent(): Hex {
  agentCounter += 1;
  const agent = `0x${agentCounter.toString(16).padStart(40, 'a')}` as Hex;
  secrets.add(agent.slice(2));
  return agent;
}

let ipCounter = 0;
function newIp(): string {
  ipCounter += 1;
  const ip = `203.0.113.${String(ipCounter)}`;
  secrets.add(ip);
  return ip;
}

async function claim(body: unknown, ip: string): Promise<Response> {
  return SELF.fetch(`${HOST}/v1/faucet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /v1/faucet: chains (SUB-7)', () => {
  it('rejects every mainnet chain ID before any send', async () => {
    const ip = newIp();
    for (const chainId of [1, 8453, 100, 42161, 10, 137]) {
      const res = await claim({ chainId, agent: newAgent() }, ip);
      expect(res.status, String(chainId)).toBe(400);
      expect(await res.json()).toEqual({ error: 'unsupported_chain' });
    }
    expect(faucet.calls).toHaveLength(0);
  });

  it('an allowlisted testnet this environment does not serve is unavailable, before any send (M1-3j-c)', async () => {
    // Chiado is on the allowlist since M1-3j-c, but this test environment's SUBMITTER_FAUCET_CHAINS
    // names Base Sepolia only (vitest.config.ts): the claim is refused as unavailable.
    const res = await claim({ chainId: 10200, agent: newAgent() }, newIp());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(faucet.calls).toHaveLength(0);
  });
});

describe('POST /v1/faucet: requests', () => {
  it('refuses malformed requests with fixed codes and never echoes input', async () => {
    const ip = newIp();
    const agent = newAgent();
    const cases: unknown[] = [
      '{not json',
      {},
      { chainId: CHAIN_ID },
      { agent },
      { chainId: String(CHAIN_ID), agent },
      { chainId: CHAIN_ID, agent: '0x1234' },
      { chainId: CHAIN_ID, agent: `0x${'0'.repeat(40)}` },
      { chainId: CHAIN_ID, agent, extra: 1 },
      [CHAIN_ID, agent],
    ];
    for (const body of cases) {
      const res = await claim(body, ip);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'bad_request' });
      expect(text).not.toContain(agent.slice(2));
    }
    const big = await claim(`{"pad":"${'x'.repeat(4_096)}"}`, ip);
    expect(big.status).toBe(413);
    expect(faucet.calls).toHaveLength(0);
  });

  it('answers 405 to anything but POST', async () => {
    const res = await SELF.fetch(`${HOST}/v1/faucet`);
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'method_not_allowed' });
  });

  it('limits faucet requests per IP per hour, whatever their outcome', async () => {
    const ip = newIp();
    for (let i = 0; i < 20; i += 1) {
      expect((await claim({ chainId: 1, agent: newAgent() }, ip)).status).toBe(400);
    }
    const blocked = await claim({ chainId: CHAIN_ID, agent: newAgent() }, ip);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'rate_limited' });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('POST /v1/faucet: claims', () => {
  it('credits a new agent once and answers with the transaction', async () => {
    const agent = newAgent();
    const before = faucet.calls.length;
    const res = await claim({ chainId: CHAIN_ID, agent }, newIp());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.chainId).toBe(CHAIN_ID);
    expect(body.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.keys(body).sort()).toEqual(['chainId', 'txHash']);
    // M1-10b-e: one grant is 50 cents by default (5 proofs at the beta price).
    expect(faucet.calls.slice(before)).toEqual([{ agent, usdCents: 50, outcome: 'sent' }]);
  });

  it('accepts an EIP-55 address and credits it in lowercase; refuses a bad checksum', async () => {
    // The first example address of EIP-55.
    const mixed = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    secrets.add(mixed.slice(2).toLowerCase());
    secrets.add(mixed.slice(2));
    const badSum = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
    expect((await claim({ chainId: CHAIN_ID, agent: badSum }, newIp())).status).toBe(400);
    const res = await claim({ chainId: CHAIN_ID, agent: mixed }, newIp());
    expect(res.status).toBe(200);
    expect(faucet.calls.at(-1)?.agent).toBe(mixed.toLowerCase());
  });

  it('rejects a repeat claim for the same agent inside the window, from any IP', async () => {
    const agent = newAgent();
    expect((await claim({ chainId: CHAIN_ID, agent }, newIp())).status).toBe(200);
    const calls = faucet.calls.length;
    const again = await claim({ chainId: CHAIN_ID, agent }, newIp());
    expect(again.status).toBe(429);
    expect(await again.json()).toEqual({ error: 'already_claimed' });
    const retry = Number(again.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(86_000);
    expect(retry).toBeLessThanOrEqual(86_400);
    expect(faucet.calls.length).toBe(calls);
  });

  it('limits claims per IP per day across agents', async () => {
    const ip = newIp();
    expect((await claim({ chainId: CHAIN_ID, agent: newAgent() }, ip)).status).toBe(200);
    expect((await claim({ chainId: CHAIN_ID, agent: newAgent() }, ip)).status).toBe(200);
    const calls = faucet.calls.length;
    const third = await claim({ chainId: CHAIN_ID, agent: newAgent() }, ip);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: 'rate_limited' });
    expect(faucet.calls.length).toBe(calls);
  });

  it('a claim the faucet could not send is not charged: the agent may claim again', async () => {
    const agent = newAgent();
    const ip = newIp();
    faucet.mode = 'not_sent';
    const failed = await claim({ chainId: CHAIN_ID, agent }, ip);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'unavailable' });
    faucet.mode = 'sent';
    expect((await claim({ chainId: CHAIN_ID, agent }, ip)).status).toBe(200);
  });

  it('a claim whose broadcast answer was lost is charged; a retry returns that transaction (M1-10b-b)', async () => {
    const agent = newAgent();
    faucet.mode = 'unknown';
    const lost = await claim({ chainId: CHAIN_ID, agent }, newIp());
    expect(lost.status).toBe(503);
    expect(await lost.json()).toEqual({ error: 'unavailable' });
    const lostCall = faucet.calls.length;
    faucet.mode = 'sent';
    const again = await claim({ chainId: CHAIN_ID, agent }, newIp());
    expect(again.status).toBe(200);
    const body = (await again.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['chainId', 'txHash']);
    expect(body.chainId).toBe(CHAIN_ID);
    expect(body.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // No second credit: the retry sent nothing.
    expect(faucet.calls.length).toBe(lostCall);
  });

  it('is unavailable when the faucet key is not the wallet this environment pins (M1-10b-b)', async () => {
    const other = new FakeFaucet(CHAIN_ID, `0x${'fb'.repeat(20)}` as Hex);
    fakeFaucets.set(CHAIN_ID, other);
    const res = await claim({ chainId: CHAIN_ID, agent: newAgent() }, newIp());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(other.calls).toHaveLength(0);
  });

  it('is unavailable when the chain has no faucet key', async () => {
    fakeFaucets.delete(CHAIN_ID);
    const res = await claim({ chainId: CHAIN_ID, agent: newAgent() }, newIp());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });
});

// M1-10b-e: a faucet below one grant refuses with the stable code `paused`, before its wallet is
// empty; `/v1/health` reports the faucet's state per chain. Paused claims charge no limit.
describe('POST /v1/faucet: paused below one grant (M1-10b-e)', () => {
  it('answers 503 `paused`, sends nothing, and claims resume once topped up', async () => {
    const agent = newAgent();
    const ip = newIp();
    faucet.tokenUsdCents = 49n;
    const before = faucet.calls.length;
    const res = await claim({ chainId: CHAIN_ID, agent }, ip);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'paused' });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(faucet.calls.length).toBe(before);
    faucet.tokenUsdCents = 50n;
    expect((await claim({ chainId: CHAIN_ID, agent }, ip)).status).toBe(200);
  });
});

describe('GET /v1/health: the faucet pool (M1-10b-e)', () => {
  async function faucetState(): Promise<unknown> {
    const res = await SELF.fetch(`${HOST}/v1/health`, { headers: { 'cf-connecting-ip': newIp() } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chains: Record<string, unknown>[] };
    const entry = body.chains.find((c) => c.chainId === CHAIN_ID);
    // Only states: no address, no balance of the faucet wallet.
    expect(JSON.stringify(body)).not.toContain('fa'.repeat(20));
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      'available',
      'chainId',
      'faucet',
      'gas',
      'gasBalance',
      'queueDepth',
    ]);
    return entry?.faucet;
  }

  it('ok at $20 or more, low under it, paused under one grant or when unreadable', async () => {
    faucet.tokenUsdCents = 2_000n;
    expect(await faucetState()).toBe('ok');
    faucet.tokenUsdCents = 1_999n;
    expect(await faucetState()).toBe('low');
    faucet.tokenUsdCents = 49n;
    expect(await faucetState()).toBe('paused');
    faucet.tokenUsdCents = 10_000n;
    faucet.failBalances = true;
    expect(await faucetState()).toBe('paused');
  });

  it('low when the faucet wallet is short of its own gas', async () => {
    faucet.nativeWei = 1n;
    expect(await faucetState()).toBe('low');
  });

  it('paused when the faucet wallet is not configured', async () => {
    fakeFaucets.delete(CHAIN_ID);
    expect(await faucetState()).toBe('paused');
  });
});

describe('POST /v1/faucet: the global daily cap', () => {
  it('holds under concurrent claims from distinct agents and IPs', async () => {
    const charged = faucet.charged();
    expect(charged).toBeLessThan(DAILY_CAP);
    const left = DAILY_CAP - charged;
    const answers = await Promise.all(
      Array.from({ length: left + 5 }, () =>
        claim({ chainId: CHAIN_ID, agent: newAgent() }, newIp()),
      ),
    );
    const statuses = answers.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(left);
    const refused = answers.filter((r) => r.status === 429);
    expect(refused).toHaveLength(5);
    for (const r of refused) {
      expect(await r.json()).toEqual({ error: 'daily_cap_reached' });
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect(faucet.charged()).toBe(DAILY_CAP);
  });
});

describe('logging canary (07 §7)', () => {
  it('the Worker wrote no IP and no agent address to the console', () => {
    expect(secrets.size).toBeGreaterThan(20);
    const all = captured.join('\n');
    for (const secret of secrets) expect(all).not.toContain(secret);
  });
});
