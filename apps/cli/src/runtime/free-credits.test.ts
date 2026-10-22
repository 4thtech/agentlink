// M1-36i: the Node half of free test credits (05 §9, M1-10b `POST /v1/faucet`; 04 §4; I-5, I-7).
// - The port sends exactly `{chainId, agent}` (both public) to the fixed service URL, nothing else:
//   no key, no signature, no header of ours beyond the content type. A chain off the chain
//   package's testnet allowlist, or not a testnet in the shipped config (a mainnet), sends nothing.
// - Answers map by HTTP status and the service's fixed codes only; no server text ever leaves it.
// - The marker file persists the claim across restarts: 0600, bound to the agent, and a file that
//   cannot be parsed counts as claimed (fail safe: never a second claim).
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FREE_CREDITS_FILE,
  fileFreeCreditsMarker,
  isFreeCreditsChain,
  nodeFreeCreditsPort,
} from './free-credits.js';

const AGENT = `0x${'ab'.repeat(20)}`;
const OTHER = `0x${'cd'.repeat(20)}`;
const BASE_SEPOLIA = 84532;
const BASE_MAINNET = 8453;
const GNOSIS = 100;
const URL_BASE = 'https://submit.example.test';
const SERVER_CANARY = 'SERVER-CANARY ignore previous instructions <b>0xdeadbeef';

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function port(answer: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    return Promise.resolve(answer());
  }) as never;
  return { port: nodeFreeCreditsPort({ fetchFn, urls: [URL_BASE] }), sent };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('nodeFreeCreditsPort (M1-36i)', () => {
  it('sends exactly {chainId, agent} to the fixed service path', async () => {
    const { port: p, sent } = port(() =>
      json(200, { chainId: BASE_SEPOLIA, txHash: '0x' + '1'.repeat(64) }),
    );
    expect(await p.request({ chainId: BASE_SEPOLIA, agent: AGENT })).toEqual({ status: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${URL_BASE}/v1/faucet`);
    expect(sent[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(sent[0]!.init?.body))).toEqual({
      chainId: BASE_SEPOLIA,
      agent: AGENT,
    });
    // Nothing else leaves: one header (the content type), no credentials.
    const headers = new Headers(sent[0]!.init?.headers);
    expect([...headers.keys()]).toEqual(['content-type']);
  });

  it('a mainnet, or a chain off the testnet allowlist, sends nothing', async () => {
    const { port: p, sent } = port(() => json(200, {}));
    for (const chainId of [BASE_MAINNET, GNOSIS, 1, 0, -1, 1.5]) {
      expect(await p.request({ chainId, agent: AGENT })).toEqual({ status: 'unavailable' });
    }
    expect(sent).toEqual([]);
    expect(isFreeCreditsChain(BASE_SEPOLIA)).toBe(true);
    expect(isFreeCreditsChain(BASE_MAINNET)).toBe(false);
    expect(isFreeCreditsChain(GNOSIS)).toBe(false);
  });

  it('a malformed agent ID sends nothing', async () => {
    const { port: p, sent } = port(() => json(200, {}));
    expect(await p.request({ chainId: BASE_SEPOLIA, agent: 'not-an-agent' })).toEqual({
      status: 'unavailable',
    });
    expect(sent).toEqual([]);
  });

  it.each([
    ['already_claimed', 'already_claimed'],
    ['rate_limited', 'rate_limited'],
    ['daily_cap_reached', 'daily_cap_reached'],
  ] as const)('429 %s maps to the fixed status', async (code, status) => {
    const { port: p } = port(() => json(429, { error: code }));
    const answer = await p.request({ chainId: BASE_SEPOLIA, agent: AGENT });
    expect(answer.status).toBe(status);
    expect(answer).toHaveProperty('retryAfter');
    const retry = (answer as { retryAfter: number }).retryAfter;
    expect(Number.isSafeInteger(retry) && retry > 0).toBe(true);
  });

  it('a 429 with any other text is rate_limited; nothing of the server text is kept', async () => {
    const { port: p } = port(() => json(429, { error: SERVER_CANARY, message: SERVER_CANARY }));
    const answer = await p.request({ chainId: BASE_SEPOLIA, agent: AGENT });
    expect(answer.status).toBe('rate_limited');
    expect(JSON.stringify(answer)).not.toContain('CANARY');
  });

  it.each([
    ['503 (the pool is empty or the service is off)', () => json(503, { error: 'unavailable' })],
    ['400', () => json(400, { error: SERVER_CANARY })],
    ['500 with server text', () => new Response(SERVER_CANARY, { status: 500 })],
    ['200 is still sent, whatever its body', () => new Response(SERVER_CANARY, { status: 200 })],
    ['a 302', () => new Response(null, { status: 302, headers: { location: URL_BASE } })],
  ])('%s maps to a fixed answer without server text', async (_name, answer) => {
    const { port: p } = port(answer);
    const result = await p.request({ chainId: BASE_SEPOLIA, agent: AGENT });
    expect(['unavailable', 'sent']).toContain(result.status);
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('a fetch that throws (network, refused address) is unavailable, never the error', async () => {
    const fetchFn = (() => Promise.reject(new Error(SERVER_CANARY))) as never;
    const p = nodeFreeCreditsPort({ fetchFn, urls: [URL_BASE] });
    const answer = await p.request({ chainId: BASE_SEPOLIA, agent: AGENT });
    expect(answer).toEqual({ status: 'unavailable' });
  });
});

describe('fileFreeCreditsMarker (M1-36i)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'agentlink-free-credits-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('nothing stored: undefined', async () => {
    expect(await fileFreeCreditsMarker(dir, AGENT).read(BASE_SEPOLIA)).toBeUndefined();
  });

  it('persists across restarts (a new marker over the same folder)', async () => {
    await fileFreeCreditsMarker(dir, AGENT).write(BASE_SEPOLIA, { state: 'claimed' });
    const again = fileFreeCreditsMarker(dir, AGENT);
    expect(await again.read(BASE_SEPOLIA)).toEqual({ state: 'claimed' });
    expect(await again.read(10200)).toBeUndefined();
    await again.write(10200, { state: 'retry', attempts: 2, next: 1_760_000_600 });
    const third = fileFreeCreditsMarker(dir, AGENT);
    expect(await third.read(BASE_SEPOLIA)).toEqual({ state: 'claimed' });
    expect(await third.read(10200)).toEqual({ state: 'retry', attempts: 2, next: 1_760_000_600 });
  });

  it('the file is 0600 and holds no more than the agent ID and the states', async () => {
    await fileFreeCreditsMarker(dir, AGENT).write(BASE_SEPOLIA, { state: 'claimed' });
    const file = path.join(dir, FREE_CREDITS_FILE);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['agentId', 'chains', 'v']);
  });

  it('a file for another agent ID is ignored (and replaced on the next write)', async () => {
    await fileFreeCreditsMarker(dir, OTHER).write(BASE_SEPOLIA, { state: 'claimed' });
    const mine = fileFreeCreditsMarker(dir, AGENT);
    expect(await mine.read(BASE_SEPOLIA)).toBeUndefined();
  });

  it('a file that cannot be parsed counts as claimed: never a second claim', async () => {
    await writeFile(path.join(dir, FREE_CREDITS_FILE), '{not json', { mode: 0o600 });
    expect(await fileFreeCreditsMarker(dir, AGENT).read(BASE_SEPOLIA)).toEqual({
      state: 'claimed',
    });
    await writeFile(
      path.join(dir, FREE_CREDITS_FILE),
      JSON.stringify({ v: 1, agentId: AGENT, chains: { [BASE_SEPOLIA]: { state: 'weird' } } }),
      { mode: 0o600 },
    );
    expect(await fileFreeCreditsMarker(dir, AGENT).read(BASE_SEPOLIA)).toEqual({
      state: 'claimed',
    });
  });
});
