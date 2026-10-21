// M1-10c: the submitter's deploy smoke test (release-and-deployment.md §4.5 job 4, D-25). One set of
// steps, two runners:
//   - test/smoke.test.ts runs them on every `pnpm test` against the Worker under Miniflare (workerd);
//   - test/smoke-remote.test.ts runs them in the deploy workflow against the deployed staging Worker
//     (`SUBMITTER_SMOKE_URL`), with plain fetch and no credentials.
//
// Steps (§4.5): `GET /v1/health` answers with every served chain available; a simulated notarize on
// each served chain; an uncovered receipt on each served chain (D-114, M1-34-b); the faucet refuses
// a mainnet chain ID (SUB-7).
//
// The simulated notarize never spends gas: its Record is signed by a fresh random agent key (a test
// key, never stored) that holds no credits, with `maxFee` 0, so the Notary's simulation reverts and
// the submitter answers `failed` with the contract's error without sending anything. A `submitted`
// or `held` answer fails the smoke: something accepted a record it must not have.
//
// The uncovered receipt never spends gas either: a correctly signed Receipt from a fresh agent that
// holds nothing, for a random record ID the Notary does not store. No proof fee was charged for that
// record, so the submitter must refuse it with `RecordNotFound` after reading the chain, never ask
// the recipient for credits (`InsufficientCredits`) and never send it (D-114).
//
// Zero access (AGENTS.md, I-7): nothing here prints a URL, address, signature or response body.
// Failures carry fixed text, HTTP status codes and the submitter's fixed error codes only.
import {
  RECORD_KIND,
  buildReceipt,
  buildRecord,
  getChainConfig,
  signReceipt,
  signRecord,
  type TypedDataSigner,
} from '@4thtech-io/chain';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';

export interface SmokeTarget {
  /** The submitter's origin, `https://host[:port]`, with no path. */
  readonly base: string;
  /** fetch for this target (SELF.fetch under Miniflare, global fetch remotely). */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Extra headers on every request (Miniflare: a client IP). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A fresh agent: its EVM address and a signer (the crypto test seam, injected by the test file). */
export interface SmokeAgent {
  readonly address: string;
  readonly signer: TypedDataSigner;
}

export class SmokeFailure extends Error {
  constructor(step: string, detail: string) {
    super(`submitter smoke: ${step}: ${detail}`);
    this.name = 'SmokeFailure';
  }
}

function check(condition: boolean, step: string, detail: string): void {
  if (!condition) throw new SmokeFailure(step, detail);
}

/** A mainnet chain ID the faucet must refuse (Base, 8453). */
export const MAINNET_CHAIN_ID = 8453;

/**
 * Errors the submitter decides before or without the Notary's simulation. A simulated notarize must
 * reach the chain, so none of these counts as a pass.
 */
const LOCAL_ERRORS: ReadonlySet<string> = new Set([
  'InvalidSignature',
  'Expired',
  'signer_refused',
  'gas_too_high',
  'rate_limited',
  'unavailable',
]);

/** The origin of `text` when it is a bare `https://host[:port]` origin, else null. */
export function smokeOrigin(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    return null;
  }
  return url.origin;
}

async function readJson(response: Response, step: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SmokeFailure(step, 'the answer is not JSON');
  }
  check(typeof body === 'object' && body !== null && !Array.isArray(body), step, 'not an object');
  return body as Record<string, unknown>;
}

function request(target: SmokeTarget, path: string, init: RequestInit = {}): Promise<Response> {
  return target.fetch(`${target.base}${path}`, {
    ...init,
    headers: { ...(target.headers ?? {}), ...((init.headers as Record<string, string>) ?? {}) },
  });
}

function post(target: SmokeTarget, path: string, body: unknown): Promise<Response> {
  return request(target, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * `GET /v1/health`: 200, `ok: true`, at least one chain, every chain available (its gas key loaded
 * and its balance read over RPC). Returns the served chain IDs.
 */
export async function smokeHealth(target: SmokeTarget): Promise<number[]> {
  const step = 'health';
  const response = await request(target, '/v1/health');
  check(response.status === 200, step, `HTTP ${String(response.status)}`);
  const body = await readJson(response, step);
  const chains = body.chains;
  check(Array.isArray(chains) && chains.length > 0, step, 'no chains served');
  const ids: number[] = [];
  for (const entry of chains as unknown[]) {
    const chain = entry as Record<string, unknown>;
    check(typeof chain.chainId === 'number', step, 'a chain without an ID');
    const id = chain.chainId as number;
    check(chain.available === true, step, `chain ${String(id)} is not available`);
    ids.push(id);
  }
  check(body.ok === true, step, 'ok is not true');
  return ids;
}

/**
 * A simulated notarize on `chainId` (§4.5): a correctly signed Record from an agent with no credits
 * and `maxFee` 0. The submitter must check the signature, simulate it on the chain and answer
 * `failed` with the Notary's error; nothing is sent.
 */
export async function smokeSimulatedNotarize(
  target: SmokeTarget,
  chainId: number,
  agent: SmokeAgent,
): Promise<string> {
  const step = `simulated notarize on chain ${String(chainId)}`;
  const config = getChainConfig(chainId);
  check(config !== undefined, step, 'this release has no deployment for the chain');
  if (!config) throw new SmokeFailure(step, 'unreachable');
  const feeToken = config.feeTokens[0]?.address ?? `0x${'0'.repeat(40)}`;
  const built = buildRecord({
    chainId,
    notary: config.contracts.notary,
    signer: agent.address,
    envelopeHash: `0x${encodeHex(randomBytes(32))}`,
    recipient: null,
    kind: RECORD_KIND.NOTE,
    feeToken,
    maxFee: 0n,
    deadline: Math.floor(Date.now() / 1000) + 600,
  });
  const signature = await signRecord(agent.signer, built);
  const response = await post(target, '/v1/notarize', {
    chainId,
    records: [{ record: built.record, signature }],
  });
  check(response.status === 200, step, `HTTP ${String(response.status)}`);
  const body = await readJson(response, step);
  const items = body.items;
  check(Array.isArray(items) && items.length === 1, step, 'not exactly one item in the answer');
  const item = (items as Record<string, unknown>[])[0] ?? {};
  check(
    item.status !== 'submitted' && item.status !== 'held',
    step,
    `the record was accepted for sending (${String(item.status)}): it must fail simulation`,
  );
  check(item.status === 'failed', step, `status ${String(item.status)}, expected failed`);
  const error = typeof item.error === 'string' ? item.error : '';
  check(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error), step, 'no error code');
  check(!LOCAL_ERRORS.has(error), step, `${error}: the simulation did not reach the chain`);
  return error;
}

/**
 * An uncovered receipt on `chainId` (D-114): a correctly signed DELIVERED Receipt from an agent that
 * holds nothing, for a record ID the Notary does not store (no proof fee was charged for it). The
 * submitter must read the chain and answer `failed` with `RecordNotFound`; nothing is sent, and the
 * recipient is never asked for credits.
 */
export async function smokeUncoveredReceipt(
  target: SmokeTarget,
  chainId: number,
  agent: SmokeAgent,
): Promise<void> {
  const step = `uncovered receipt on chain ${String(chainId)}`;
  const config = getChainConfig(chainId);
  check(config !== undefined, step, 'this release has no deployment for the chain');
  if (!config) throw new SmokeFailure(step, 'unreachable');
  const built = buildReceipt({
    chainId,
    notary: config.contracts.notary,
    signer: agent.address,
    recordId: `0x${encodeHex(randomBytes(32))}`,
    receiptType: 1,
    salt: `0x${encodeHex(randomBytes(32))}`,
    deadline: Math.floor(Date.now() / 1000) + 600,
  });
  const signature = await signReceipt(agent.signer, built);
  const response = await post(target, '/v1/receipt', {
    chainId,
    receipts: [{ receipt: built.receipt, signature }],
  });
  check(response.status === 200, step, `HTTP ${String(response.status)}`);
  const body = await readJson(response, step);
  const items = body.items;
  check(Array.isArray(items) && items.length === 1, step, 'not exactly one item in the answer');
  const item = (items as Record<string, unknown>[])[0] ?? {};
  check(
    item.status !== 'submitted' && item.status !== 'held',
    step,
    `the receipt was accepted for sending (${String(item.status)}): no fee covers it`,
  );
  check(item.status === 'failed', step, `status ${String(item.status)}, expected failed`);
  const error = typeof item.error === 'string' ? item.error : '';
  check(error !== 'InsufficientCredits', step, 'the recipient was asked for credits');
  check(error === 'RecordNotFound', step, `${error || 'no error code'}, expected RecordNotFound`);
}

/** The faucet refuses a mainnet chain ID (SUB-7): 400 `unsupported_chain`, nothing credited. */
export async function smokeFaucetRefusesMainnet(
  target: SmokeTarget,
  agent: SmokeAgent,
): Promise<void> {
  const step = 'faucet refuses a mainnet chain';
  const response = await post(target, '/v1/faucet', {
    chainId: MAINNET_CHAIN_ID,
    agent: agent.address,
  });
  check(response.status === 400, step, `HTTP ${String(response.status)}`);
  const body = await readJson(response, step);
  check(body.error === 'unsupported_chain', step, `error ${String(body.error)}`);
  check(body.txHash === undefined, step, 'a transaction hash in a refusal');
}

/** All smoke steps, in order. */
export async function smokeAll(
  target: SmokeTarget,
  newAgent: () => Promise<SmokeAgent>,
): Promise<void> {
  const chains = await smokeHealth(target);
  for (const chainId of chains) {
    await smokeSimulatedNotarize(target, chainId, await newAgent());
    await smokeUncoveredReceipt(target, chainId, await newAgent());
  }
  await smokeFaucetRefusesMainnet(target, await newAgent());
}
