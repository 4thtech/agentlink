// Gasless top-ups (07 §7 `POST /v1/deposit-authorization`; 05 §2.5; 04 §7 gas griefing; 12 §4.1;
// M3-4b-t-3): the submitter relays an agent's signed EIP-3009 `ReceiveWithAuthorization` to the fee
// vault's `depositWithAuthorization` and pays the network cost; the normal deposit fee applies.
//
//   POST /v1/deposit-authorization  {chainId, token, auth}
//     -> 200 {status: "submitted", txHash}
//     -> 200 {status: "failed", error, txHash}   a repeat of a sent authorization that reverted
//     -> 4xx/5xx {status: "failed", error}       a fixed code (DEPOSIT_AUTH_ERROR_CODES)
//
// - Off unless SUBMITTER_DEPOSIT_AUTH_CHAINS names the chain (config.ts readDepositAuthConfig);
//   while off the route answers 501 `not_available`, as before M3-4b.
// - The agent's key signs; the submitter never sees a key but its own relay gas key (index.ts).
//   The authorization moves funds only from `from` to the vault, as credits of `from` (05 §2.5):
//   the submitter can delay it, never redirect it.
// - Order: per-IP limit, strict body parse (@4thtech-io/chain parseDepositAuthorizationRequest),
//   chain on the switch, the cheap checks here (payee is the chain's vault, the validity window),
//   then one Durable Object per chain (`deposit:<chainId>`), one request at a time: a repeat of a
//   stored authorization answers from storage; otherwise every relay check of
//   @4thtech-io/chain `DepositRelayChain.check` (gasless token, $5 to $50, window, signature of an
//   EOA `from`, unused nonce, vault minDeposit, simulation and gas cap), then the per-agent limit
//   (only an authorization that passed the checks counts, so nobody can use up an agent's quota
//   with a forged `from`), then one send at the relay wallet's next nonce.
// - Idempotent on (chainId, from, nonce): the stored entry keeps a SHA-256 of the whole request,
//   so an identical repeat returns the same transaction and anything else under that nonce is
//   `already_used`; neither is sent again.
// - Privacy (07 §7, I-7): nothing is logged. Storage keeps `a:<from>:<nonce>` (the request digest,
//   the transaction hash and the time; all public once redeemed) and `n` (the relay wallet's next
//   nonce), never an IP, a signature or a body. Entries are deleted after RETENTION_SECONDS.
import { DurableObject } from 'cloudflare:workers';
import {
  DEPOSIT_AUTH_CLOCK_SKEW_SECONDS,
  DEPOSIT_AUTH_MIN_REMAINING_SECONDS,
  GASLESS_WINDOW_SECONDS,
  depositAuthorizationRequestBody,
  parseDepositAuthorizationRequest,
  type DepositAuthErrorCode,
  type DepositAuthorizationRequest,
  type DepositRelayChain,
  type Hex,
} from '@4thtech-io/chain';
import { encodeHex, encodeUtf8, sha256 } from '@4thtech-io/crypto';
import { readDepositAuthConfig } from './config.js';
import type { SubmitterLimits } from './limits.js';

/** Largest request body: `{chainId, token, auth}` is about 700 bytes. */
export const MAX_DEPOSIT_AUTH_BODY_BYTES = 2048;

/** How long a sent authorization is remembered (its window is at most 17 minutes). */
export const RETENTION_SECONDS = 86_400;

/**
 * How long the relay trusts its own next nonce over the chain's pending one: a node behind a load
 * balancer may not see a transaction sent seconds ago. After that the chain's count wins, so a
 * transaction that never landed cannot leave a gap.
 */
export const NONCE_MEMORY_SECONDS = 120;

export interface DepositRelayDeps {
  /** The relay of a gasless chain, or null when its gas key or relay ABI is not configured. */
  relayFor(env: unknown, chainId: number): DepositRelayChain | null;
}

export type RelayAnswer =
  | { readonly ok: true; readonly txHash: Hex }
  | {
      readonly ok: false;
      readonly error: DepositAuthErrorCode;
      readonly txHash?: Hex;
      readonly retryAfter?: number;
    };

/** The relay's RPC surface, as the Worker calls it. */
export interface SubmitterDepositRelayApi {
  relay(chainId: number, request: DepositAuthorizationRequest): Promise<RelayAnswer>;
}

/**
 * The checks the Worker runs before the Durable Object, without the chain: the payee is the
 * chain's vault, `validAfter` is past, and `validBefore` leaves at least a minute but is no further
 * than the 15-minute window plus clock skew. The relay checks repeat all of them.
 */
export function precheckDepositAuthorization(
  request: DepositAuthorizationRequest,
  vault: Hex,
  nowSeconds: number,
): DepositAuthErrorCode | null {
  const { auth } = request;
  if (auth.to !== vault.toLowerCase()) return 'not_vault';
  const now = BigInt(nowSeconds);
  const validBefore = BigInt(auth.validBefore);
  if (BigInt(auth.validAfter) >= now) return 'invalid_window';
  if (validBefore <= now + BigInt(DEPOSIT_AUTH_MIN_REMAINING_SECONDS)) return 'expired';
  if (validBefore > now + BigInt(GASLESS_WINDOW_SECONDS + DEPOSIT_AUTH_CLOCK_SKEW_SECONDS)) {
    return 'invalid_window';
  }
  return null;
}

/** SHA-256 of the request's canonical JSON (the parser fixes the field order), hex. */
function digestOf(request: DepositAuthorizationRequest): string {
  return encodeHex(sha256(encodeUtf8(JSON.stringify(depositAuthorizationRequestBody(request)))));
}

/** A sent authorization: request digest, transaction hash, unix seconds when sent. */
interface Sent {
  readonly d: string;
  readonly h: Hex;
  readonly at: number;
}

/** The relay wallet's next nonce and when it was set. */
type NextNonce = [number, number];

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const UNAVAILABLE: RelayAnswer = Object.freeze({ ok: false, error: 'unavailable' });
const refuse = (error: DepositAuthErrorCode): RelayAnswer => Object.freeze({ ok: false, error });

export interface DepositRelayEnv {
  readonly SUBMITTER_LIMITS: DurableObjectNamespace<SubmitterLimits>;
  readonly [name: string]: unknown;
}

/**
 * The relay class as other modules see it. Declared, because a declaration file cannot name an
 * anonymous class with private members (TS4094); at run time it is a Durable Object class.
 */
export type SubmitterDepositRelayClass = new (
  ctx: DurableObjectState,
  env: DepositRelayEnv,
) => SubmitterDepositRelayApi & { alarm(): Promise<void> };

export function createDepositRelayClass(deps: DepositRelayDeps): SubmitterDepositRelayClass {
  return class SubmitterDepositRelay
    extends DurableObject<DepositRelayEnv>
    implements SubmitterDepositRelayApi
  {
    /** Requests run one at a time: the stored entries, the per-agent limit and the nonce hold. */
    private tail: Promise<unknown> = Promise.resolve();

    relay(chainId: number, request: DepositAuthorizationRequest): Promise<RelayAnswer> {
      const run = this.tail.then(() => this.relayNow(chainId, request));
      this.tail = run.catch(() => undefined);
      return run.catch(() => UNAVAILABLE);
    }

    private async relayNow(
      chainId: number,
      raw: DepositAuthorizationRequest,
    ): Promise<RelayAnswer> {
      const config = readDepositAuthConfig(this.env);
      if (!config || !config.chains.includes(chainId)) return UNAVAILABLE;
      const relay = deps.relayFor(this.env, chainId);
      if (!relay || relay.chainId !== chainId) return UNAVAILABLE;
      let request: DepositAuthorizationRequest;
      try {
        request = parseDepositAuthorizationRequest(raw);
      } catch {
        return UNAVAILABLE; // the Worker parsed it already: not reachable from a request
      }
      if (request.chainId !== chainId) return UNAVAILABLE;
      const storage = this.ctx.storage;
      const key = `a:${request.auth.from}:${request.auth.nonce}`;
      const digest = digestOf(request);

      const sent = await storage.get<Sent>(key);
      if (sent !== undefined) {
        if (sent.d !== digest) return refuse('already_used');
        let state: 'pending' | 'success' | 'reverted' = 'pending';
        try {
          state = await relay.txStatus(sent.h);
        } catch {
          // Unknown for now: the agent confirms the credit on chain anyway.
        }
        return state === 'reverted'
          ? Object.freeze({ ok: false, error: 'simulation_failed', txHash: sent.h })
          : Object.freeze({ ok: true, txHash: sent.h });
      }

      const now = nowSeconds();
      const early = precheckDepositAuthorization(request, relay.vault, now);
      if (early !== null) return refuse(early);
      const checked = await relay.check(request, now); // a chain failure throws: unavailable
      if (!checked.ok) return refuse(checked.error);

      const limits = this.env.SUBMITTER_LIMITS;
      const limiter = limits.get(limits.idFromName(`d:${String(chainId)}:${request.auth.from}`));
      const taken = await limiter.take(1, config.agentRequestsPerHour, 3600, now);
      if (!taken.ok) {
        return Object.freeze({ ok: false, error: 'rate_limited', retryAfter: taken.retryAfter });
      }

      const pending = await relay.pendingNonce();
      const remembered = await storage.get<NextNonce>('n');
      const nonce =
        remembered !== undefined &&
        now - remembered[1] < NONCE_MEMORY_SECONDS &&
        remembered[0] > pending
          ? remembered[0]
          : pending;
      let txHash: Hex;
      try {
        txHash = await relay.send(request, { gasLimit: checked.gasLimit, nonce });
      } catch {
        // The nonce may or may not be used: read it from the chain next time.
        await storage.delete('n');
        return UNAVAILABLE;
      }
      await storage.put({
        [key]: { d: digest, h: txHash, at: now } satisfies Sent,
        n: [nonce + 1, now] satisfies NextNonce,
      });
      if ((await storage.getAlarm()) === null) {
        await storage.setAlarm((now + RETENTION_SECONDS + 60) * 1000);
      }
      return Object.freeze({ ok: true, txHash });
    }

    /** Deletes the entries older than RETENTION_SECONDS; runs again while any remain. */
    async alarm(): Promise<void> {
      const now = nowSeconds();
      const storage = this.ctx.storage;
      const stale: string[] = [];
      for (const [key, entry] of await storage.list<Sent>({ prefix: 'a:' })) {
        if (typeof entry?.at !== 'number' || now - entry.at >= RETENTION_SECONDS) stale.push(key);
      }
      for (let i = 0; i < stale.length; i += 128) {
        await storage.delete(stale.slice(i, i + 128));
      }
      const left = await storage.list({ prefix: 'a:', limit: 1 });
      if (left.size > 0) await storage.setAlarm((now + 3_600) * 1000);
      else await storage.delete('n');
    }
  };
}
