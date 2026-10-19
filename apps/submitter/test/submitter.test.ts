// M1-10a: the submitter Worker under Miniflare (07 §7; 05 §3.3; 04 §7). Every request goes through
// the Worker's own fetch handler (SELF) with its Durable Objects; each chain is the in-memory
// FakeChain (test/worker-entry.ts). Test limits (vitest.config.ts): 12 items per IP per hour,
// 3 new items per signer per hour. Signers and IPs are distinct per test, so tests do not share
// counters. Nothing here is a real key or signature.
//
// The canary block at the end searches everything the Worker wrote to the console for the IPs and
// signatures the tests used (07 §7: no request logging; never signatures with IPs).
import { SELF, env as testEnv, runDurableObjectAlarm } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RECORD_KIND, buildReceipt, buildRecord, getChainConfig, type Hex } from '@4thtech-io/chain';
import type { SubmitterEnv } from '../src/worker.js';
import { FakeChain, fakeChains } from './fake-chain.js';

const env = testEnv as SubmitterEnv;
const HOST = 'https://submitter.test';
const CHAIN_ID = 84532;
const config = getChainConfig(CHAIN_ID);
if (!config) throw new Error('test setup: no Base Sepolia deployment');
const NOTARY = config.contracts.notary as Hex;
const ZERO = `0x${'0'.repeat(40)}`;

let chain: FakeChain;
beforeEach(() => {
  chain = new FakeChain(CHAIN_ID, NOTARY);
  chain.signatureCheck = 'real';
  fakeChains.set(CHAIN_ID, chain);
});

// Everything a log line must never contain, collected as the tests run.
const secrets = new Set<string>();
const captured: string[] = [];
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
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

function record(signer: Hex) {
  const built = buildRecord({
    chainId: CHAIN_ID,
    notary: NOTARY,
    signer,
    envelopeHash: `0x${'12'.repeat(32)}`,
    recipient: null,
    kind: RECORD_KIND.NOTE,
    feeToken: ZERO,
    maxFee: 1000n,
    deadline: Math.floor(Date.now() / 1000) + 3600,
  });
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
  return { status: res.status, items: (body.items ?? []) as Item[], body };
}

const queueStub = () => env.SUBMITTER_QUEUE.get(env.SUBMITTER_QUEUE.idFromName(`chain:${String(CHAIN_ID)}`));

describe('GET /v1/health', () => {
  it('reports per-chain gas balance and queue depth', async () => {
    const res = await SELF.fetch(`${HOST}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      chains: [{ chainId: CHAIN_ID, available: true, gasBalance: String(10n ** 17n), queueDepth: 0 }],
    });
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
      [{ chainId: 1, records: [{ record: r.record, signature: r.signature }] }, 400, 'unsupported_chain'],
      [`{"pad":"${'x'.repeat(70_000)}"}`, 413, 'too_large'],
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
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map(() => notarize([record(newSigner())])),
    );
    for (const { items } of results) expect(items[0]?.status).toBe('submitted');
    expect(chain.sent.map((tx) => tx.nonce).sort((a, b) => a - b)).toEqual([7, 8, 9, 10, 11]);
    expect(new Set(chain.sent.map((tx) => tx.hash)).size).toBe(5);
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
    const signer = newSigner();
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

  it('answers 404 for an unknown transaction and 400 for a malformed hash', async () => {
    expect((await SELF.fetch(`${HOST}/v1/status/0x${'ab'.repeat(32)}`)).status).toBe(404);
    expect((await SELF.fetch(`${HOST}/v1/status/0x12`)).status).toBe(400);
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

describe('logging canary (07 §7)', () => {
  it('the Worker wrote no IP and no signature to the console', () => {
    expect(secrets.size).toBeGreaterThan(10);
    const all = captured.join('\n');
    for (const secret of secrets) expect(all).not.toContain(secret);
  });
});
