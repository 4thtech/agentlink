// M1-10a: the submitter Worker under Miniflare (07 §7; 05 §3.3; 04 §7). Every request goes through
// the Worker's own fetch handler (SELF) with its Durable Objects; each chain is the in-memory
// FakeChain (test/worker-entry.ts). Test limits (vitest.config.ts): 12 items per IP per hour,
// 3 new items per signer per hour. Signers and IPs are distinct per test, so tests do not share
// counters. Nothing here is a real key or signature.
//
// The canary block at the end searches everything the Worker wrote to the console, and the
// aggregate metrics it kept, for the IPs, signers, recipients, record IDs, salts, signatures and
// transaction hashes the tests used (07 §7, D-109 (8), OPS-PRIV-1: no request logging; no log line
// or metric carries any of them).
import { SELF, env as testEnv, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECORD_KIND,
  buildReceipt,
  buildRecord,
  getChainConfig,
  type Hex,
} from '@4thtech-io/chain';
import type { SubmitterEnv } from '../src/worker.js';
import { METRICS } from '../src/limits.js';
import { POLL_MS } from '../src/queue.js';
import { FakeChain, fakeChains } from './fake-chain.js';
import { FakeFaucet, fakeFaucets } from './fake-faucet.js';

const env = testEnv as SubmitterEnv;
const HOST = 'https://submitter.test';
const CHAIN_ID = 84532;
const config = getChainConfig(CHAIN_ID);
if (!config) throw new Error('test setup: no Base Sepolia deployment');
const NOTARY = config.contracts.notary as Hex;
const ZERO = `0x${'0'.repeat(40)}`;

let chain: FakeChain;
// CHORE-DEFLAKE-1: the per-IP limiter is a fixed window aligned to the clock hour (src/limits.ts),
// so a run that crosses the hour could reset a counter mid-test. The clock is pinned to half past
// an hour (the date is far enough ahead that the real clock never reaches the limiter's cleanup
// alarm), so the window cannot roll inside a test; tests that cross a boundary set their own time.
const PINNED_NOW = new Date('2030-01-01T11:30:00Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
  chain = new FakeChain(CHAIN_ID, NOTARY);
  chain.signatureCheck = 'real';
  fakeChains.set(CHAIN_ID, chain);
});
afterEach(() => {
  vi.useRealTimers();
});

// Everything a log line or metric must never contain, collected as the tests run. Hex values are
// kept without `0x`, lowercase, and compared case-insensitively (an address may be checksummed).
const secrets = new Set<string>();
let txHashes = 0;
function secretHex(value: string | null | undefined): void {
  if (typeof value === 'string' && value.length > 2) secrets.add(value.slice(2).toLowerCase());
}
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
      captured.push(args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' '));
    };
  }
});

afterAll(() => {
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const [method, original] of originals) target[method] = original;
});

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

let signerCounter = 0;
/** A fresh signer address; `code` makes it an account with code (ERC-1271 / EIP-7702). */
function newSigner(code = true): Hex {
  signerCounter += 1;
  const address = `0x${signerCounter.toString(16).padStart(40, 'b')}` as Hex;
  if (code) chain.code.add(address);
  secretHex(address);
  return address;
}

let ipCounter = 0;
function newIp(): string {
  ipCounter += 1;
  const ip = `198.51.100.${String(ipCounter)}`;
  secrets.add(ip);
  return ip;
}

let sigCounter = 0;
/** A signature in JSON form: 65 bytes that are not a valid ECDSA signature for anyone here. */
function newSignature(): Hex {
  sigCounter += 1;
  const sig = `0x${sigCounter.toString(16).padStart(8, '0')}${'5c'.repeat(61)}1b` as Hex;
  secrets.add(sig.slice(2));
  return sig;
}

function record(signer: Hex, recipient: Hex | null = null) {
  const built = buildRecord({
    chainId: CHAIN_ID,
    notary: NOTARY,
    signer,
    envelopeHash: `0x${'12'.repeat(32)}`,
    recipient,
    kind: RECORD_KIND.NOTE,
    feeToken: ZERO,
    maxFee: 1000n,
    deadline: Math.floor(Date.now() / 1000) + 3600,
  });
  secretHex(built.recordId);
  secretHex(built.salt);
  return { record: built.record, recordId: built.recordId, signature: newSignature() };
}

async function post(path: string, body: unknown, ip: string): Promise<Response> {
  return SELF.fetch(`${HOST}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

type Item = { id: string; recordId: string; status: string; txHash?: string; error?: string };

async function notarize(
  records: ReturnType<typeof record>[],
  ip = newIp(),
): Promise<{ status: number; items: Item[]; body: Record<string, unknown> }> {
  const res = await post(
    '/v1/notarize',
    {
      chainId: CHAIN_ID,
      records: records.map((r) => ({ record: r.record, signature: r.signature })),
    },
    ip,
  );
  const body = (await res.json()) as Record<string, unknown>;
  const items = (body.items ?? []) as Item[];
  for (const item of items) {
    if (item.txHash) txHashes += 1;
    secretHex(item.txHash);
  }
  return { status: res.status, items, body };
}

const queueStub = () =>
  env.SUBMITTER_QUEUE.get(env.SUBMITTER_QUEUE.idFromName(`chain:${String(CHAIN_ID)}`));

describe('GET /v1/health', () => {
  it('reports per-chain gas balance, queue depth and the gas and faucet pool states', async () => {
    fakeFaucets.set(CHAIN_ID, new FakeFaucet(CHAIN_ID));
    const res = await SELF.fetch(`${HOST}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      chains: [
        {
          chainId: CHAIN_ID,
          available: true,
          gasBalance: String(10n ** 17n),
          queueDepth: 0,
          gas: 'ok',
          faucet: 'ok',
        },
      ],
    });
    fakeFaucets.delete(CHAIN_ID);
  });
});

describe('POST /v1/notarize', () => {
  it('relays signed records and answers with the transaction and record IDs', async () => {
    const r = record(newSigner());
    const { status, items, body } = await notarize([r]);
    expect(status).toBe(200);
    expect(body.chainId).toBe(CHAIN_ID);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: r.recordId, recordId: r.recordId, status: 'submitted' });
    expect(chain.sent).toHaveLength(1);
    expect(items[0]?.txHash).toBe(chain.sent[0]?.hash);
  });

  it('refuses an invalid signature before sending (EOA signer)', async () => {
    const r = record(newSigner(false));
    const { status, items } = await notarize([r]);
    expect(status).toBe(200);
    expect(items[0]).toMatchObject({ status: 'failed', error: 'InvalidSignature' });
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses an item with insufficient credits before sending', async () => {
    const r = record(newSigner());
    chain.simulationErrors.set(r.recordId, 'InsufficientCredits');
    const { items } = await notarize([r]);
    expect(items[0]).toMatchObject({ status: 'failed', error: 'InsufficientCredits' });
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses malformed, oversized and unserved requests with a fixed code', async () => {
    const ip = newIp();
    const r = record(newSigner());
    const cases: [unknown, number, string][] = [
      ['{not json', 400, 'bad_request'],
      [{ chainId: CHAIN_ID, records: [] }, 400, 'bad_request'],
      [
        { chainId: 1, records: [{ record: r.record, signature: r.signature }] },
        400,
        'unsupported_chain',
      ],
      [`{"pad":"${'x'.repeat(140_000)}"}`, 413, 'too_large'],
    ];
    for (const [body, status, error] of cases) {
      const res = await post('/v1/notarize', body, ip);
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error });
      expect(text).not.toContain(r.signature.slice(2));
    }
    expect(chain.sent).toHaveLength(0);
  });

  it('limits new items per signer; over the limit an item fails with rate_limited', async () => {
    const signer = newSigner();
    const first = await notarize([record(signer), record(signer), record(signer)]);
    expect(first.items.map((i) => i.status)).toEqual(['submitted', 'submitted', 'submitted']);
    const over = await notarize([record(signer)]);
    expect(over.items[0]).toMatchObject({ status: 'failed', error: 'rate_limited' });
    expect(chain.sent.flatMap((tx) => tx.ids)).toHaveLength(3);
  });

  it('limits items per IP with 429; replays of another signer’s items leave its limit unchanged (FA-3)', async () => {
    const victim = newSigner();
    const known = record(victim);
    chain.onChain.add(known.recordId);
    const ip = newIp();
    for (let i = 0; i < 12; i += 1) {
      const { status, items } = await notarize([known], ip);
      expect(status).toBe(200);
      expect(items[0]).toMatchObject({ status: 'skipped', recordId: known.recordId });
    }
    const blocked = await post(
      '/v1/notarize',
      { chainId: CHAIN_ID, records: [{ record: known.record, signature: known.signature }] },
      ip,
    );
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'rate_limited' });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(chain.sent).toHaveLength(0);
    // The victim's own limit (3 per hour) is untouched by the replays.
    const own = await notarize([record(victim), record(victim), record(victim)]);
    expect(own.items.map((i) => i.status)).toEqual(['submitted', 'submitted', 'submitted']);
  });

  it('serialises transaction nonces across concurrent requests', async () => {
    const results = await Promise.all([0, 1, 2, 3, 4].map(() => notarize([record(newSigner())])));
    for (const { items } of results) expect(items[0]?.status).toBe('submitted');
    // The queue keeps its own next nonce across tests (Durable Object storage), so the run starts
    // wherever the previous test left it: five distinct, consecutive nonces.
    const nonces = chain.sent.map((tx) => tx.nonce).sort((a, b) => a - b);
    const first = nonces[0] ?? -1;
    expect(nonces).toEqual([first, first + 1, first + 2, first + 3, first + 4]);
    expect(new Set(chain.sent.map((tx) => tx.hash)).size).toBe(5);
  });

  it('accepts 20 items with full-length (2048-byte) signatures within the body cap', async () => {
    const signer = newSigner();
    const records = Array.from({ length: 20 }, () => ({
      ...record(signer),
      signature: `0x${'ab'.repeat(2048)}` as Hex,
    }));
    const res = await post(
      '/v1/notarize',
      {
        chainId: CHAIN_ID,
        records: records.map((r) => ({ record: r.record, signature: r.signature })),
      },
      newIp(),
    );
    // Read and parsed in full: the per-IP item limit (12 in these tests) is checked only after a
    // successful parse, so 429 here means the body cap and the strict parser accepted it.
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
  });

  it('refuses before sending an item whose ERC-1271 check burns gas (H-1)', async () => {
    const r = record(newSigner());
    chain.itemGas.set(r.recordId, 5_000_000n);
    const { items } = await notarize([r]);
    expect(items[0]).toMatchObject({ status: 'failed', error: 'gas_too_high' });
    expect(chain.sent).toHaveLength(0);
  });

  it('holds items while the Notary is paused', async () => {
    chain.paused = true;
    const { items } = await notarize([record(newSigner())]);
    expect(items[0]?.status).toBe('held');
    expect(chain.sent).toHaveLength(0);
    const health = (await (await SELF.fetch(`${HOST}/v1/health`)).json()) as {
      chains: { queueDepth: number }[];
    };
    expect(health.chains[0]?.queueDepth).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /v1/receipt', () => {
  it('relays a signed receipt', async () => {
    // The receipt's signer is the record's recipient (05 §3.1); the salt is revealed on-chain only.
    const signer = newSigner();
    secretHex(`0x${'34'.repeat(32)}`);
    secretHex(`0x${'56'.repeat(32)}`);
    const built = buildReceipt({
      chainId: CHAIN_ID,
      notary: NOTARY,
      signer,
      recordId: `0x${'34'.repeat(32)}`,
      receiptType: 1,
      salt: `0x${'56'.repeat(32)}`,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    const signature = newSignature();
    // The record is stored, so its proof fee was charged (D-114: it covers up to 3 receipts).
    chain.records.add(`0x${'34'.repeat(32)}`);
    const res = await post(
      '/v1/receipt',
      { chainId: CHAIN_ID, receipts: [{ receipt: built.receipt, signature }] },
      newIp(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Item[] };
    expect(body.items[0]).toMatchObject({ id: `0x${'34'.repeat(32)}:1`, status: 'submitted' });
  });
});

describe('GET /v1/status/:txHash', () => {
  it('reports pending, then the per-item status after inclusion', async () => {
    const r = record(newSigner());
    const { items } = await notarize([r]);
    const txHash = items[0]?.txHash as string;
    const pending = await SELF.fetch(`${HOST}/v1/status/${txHash}`);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({ chainId: CHAIN_ID, txHash, state: 'pending' });
    chain.includeAll();
    expect(await runDurableObjectAlarm(queueStub())).toBe(true);
    const done = (await (await SELF.fetch(`${HOST}/v1/status/${txHash}`)).json()) as {
      state: string;
      items: Item[];
    };
    expect(done.state).toBe('included');
    expect(done.items[0]).toMatchObject({ id: r.recordId, status: 'recorded', txHash });
  });

  // The queue Durable Object is one instance per chain for the whole file, and earlier tests leave
  // items in it (held, or sent to a FakeChain a later test replaced), so its alarm stays armed. If
  // that alarm fired on the wall clock, a poll could start between a test's `includeAll()` and its
  // `runDurableObjectAlarm()`, which then finds no alarm and answers false (merge-queue flake). The
  // test Worker therefore schedules the alarm far ahead: it runs only when a test runs it.
  it('polls only when a test runs the alarm, not on the wall clock', async () => {
    const r = record(newSigner());
    const { items } = await notarize([r]);
    const txHash = items[0]?.txHash as string;
    chain.includeAll();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS + 500));
    const before = (await (await SELF.fetch(`${HOST}/v1/status/${txHash}`)).json()) as {
      state: string;
    };
    expect(before.state).toBe('pending');
    expect(await runDurableObjectAlarm(queueStub())).toBe(true);
    const after = (await (await SELF.fetch(`${HOST}/v1/status/${txHash}`)).json()) as {
      state: string;
    };
    expect(after.state).toBe('included');
  });

  it('answers 404 for an unknown transaction and 400 for a malformed hash', async () => {
    expect((await SELF.fetch(`${HOST}/v1/status/0x${'ab'.repeat(32)}`)).status).toBe(404);
    expect((await SELF.fetch(`${HOST}/v1/status/0x12`)).status).toBe(400);
  });
});

describe('per-IP window boundary (CHORE-DEFLAKE-1)', () => {
  it('refuses reads inside the hour and allows them again once the clock crosses the hour', async () => {
    vi.setSystemTime(new Date('2030-01-01T11:59:50Z'));
    const ip = newIp();
    const read = () => SELF.fetch(`${HOST}/v1/health`, { headers: { 'cf-connecting-ip': ip } });
    for (let i = 0; i < 30; i += 1) {
      if ((await read()).status === 429) break;
    }
    const blocked = await read();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBe(10);
    vi.setSystemTime(new Date('2030-01-01T12:00:00Z'));
    expect((await read()).status).toBe(200);
  });
});

describe('read limits (IR-M1-10a-1 L-2)', () => {
  it('limits /v1/status and /v1/health per IP', async () => {
    const ip = newIp();
    const read = (path: string) =>
      SELF.fetch(`${HOST}${path}`, { headers: { 'cf-connecting-ip': ip } });
    for (let i = 0; i < 15; i += 1) {
      expect((await read('/v1/health')).status).toBe(200);
      expect((await read(`/v1/status/0x${'cd'.repeat(32)}`)).status).toBe(404);
    }
    const blocked = await read('/v1/health');
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'rate_limited' });
    expect((await read(`/v1/status/0x${'cd'.repeat(32)}`)).status).toBe(429);
  });
});

describe('other routes', () => {
  it('keeps /v1/deposit-authorization present but disabled', async () => {
    const res = await post('/v1/deposit-authorization', { chainId: CHAIN_ID }, newIp());
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'not_available' });
  });

  it('answers 404 and 405 with fixed codes', async () => {
    expect((await SELF.fetch(`${HOST}/v1/nothing`)).status).toBe(404);
    expect((await SELF.fetch(`${HOST}/v1/notarize`)).status).toBe(405);
    expect((await post('/v1/health', {}, newIp())).status).toBe(405);
  });
});

describe('logging canary (07 §7, OPS-PRIV-1)', () => {
  it('notarizes a record to a recipient, so a recipient and its salt are canaries too', async () => {
    const r = record(newSigner(), newSigner(false));
    const { status, items } = await notarize([r]);
    expect(status).toBe(200);
    expect(items[0]?.recordId).toBe(r.recordId);
  });

  it('the Worker logged no IP, signer, recipient, record ID, salt, signature or tx hash', () => {
    expect(secrets.size).toBeGreaterThan(40);
    expect(txHashes).toBeGreaterThan(0);
    const all = captured.join('\n').toLowerCase();
    for (const secret of secrets) expect(all).not.toContain(secret);
  });

  it('keeps only fixed counter names with integer values, carrying none of them', async () => {
    const stub = env.SUBMITTER_LIMITS.get(env.SUBMITTER_LIMITS.idFromName('metrics'));
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<Record<string, unknown>>('m'),
    );
    const metrics = stored ?? {};
    expect(Object.keys(metrics).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(metrics)) {
      expect(METRICS as readonly string[]).toContain(name);
      expect(Number.isSafeInteger(value)).toBe(true);
    }
    const text = JSON.stringify(metrics).toLowerCase();
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});
