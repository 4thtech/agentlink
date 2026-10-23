// A stand-in for one chain's gasless top-up relay, behind the DepositRelayChain port of
// @4thtech-io/chain (M3-4b-t-3). The Worker tests (Miniflare) drive it; the real relay's checks
// (payee, amount bounds, window, signature, used nonce, simulation, gas cap), its JSON-RPC and its
// gas-key wallet are tested in packages/chain (deposit-relay.test.ts). Nothing here is a real key.
import type {
  DepositAuthorizationRequest,
  DepositRelayChain,
  DepositRelayCheck,
  Hex,
  SendOptions,
} from '@4thtech-io/chain';

export interface FakeSend {
  readonly request: DepositAuthorizationRequest;
  readonly gasLimit: bigint;
  readonly nonce: number;
  readonly hash: Hex;
}

export class FakeRelay implements DepositRelayChain {
  readonly chainId: number;
  readonly vault: Hex;
  readonly gasAddress: Hex = `0x${'ab'.repeat(20)}` as Hex;
  /** What the next check answers; a function sees the request. */
  checkAnswer:
    | DepositRelayCheck
    | ((request: DepositAuthorizationRequest) => DepositRelayCheck) = Object.freeze({
    ok: true,
    gasLimit: 90_000n,
  });
  /** The check throws (an RPC outage). */
  failCheck = false;
  /** The send throws (an RPC outage while broadcasting). */
  failSend = false;
  /** Milliseconds each send waits before it answers (to overlap concurrent requests). */
  sendDelayMs = 0;
  /** The gas wallet's pending nonce, as the chain reports it. */
  pending = 7;
  /** Receipt status per sent hash; `pending` when absent. */
  readonly statuses = new Map<string, 'pending' | 'success' | 'reverted'>();
  /** Every check and send, in order. */
  readonly checks: DepositAuthorizationRequest[] = [];
  readonly sends: FakeSend[] = [];
  private counter = 0;

  constructor(chainId: number, vault: Hex) {
    this.chainId = chainId;
    this.vault = vault.toLowerCase() as Hex;
  }

  check(request: DepositAuthorizationRequest, nowSeconds: number): Promise<DepositRelayCheck> {
    this.checks.push(request);
    if (this.failCheck || !Number.isSafeInteger(nowSeconds)) {
      return Promise.reject(new Error('rpc down'));
    }
    const answer =
      typeof this.checkAnswer === 'function' ? this.checkAnswer(request) : this.checkAnswer;
    return Promise.resolve(answer);
  }

  authorizationUsed(): Promise<boolean> {
    return Promise.resolve(false);
  }

  pendingNonce(): Promise<number> {
    return Promise.resolve(this.pending);
  }

  latestNonce(): Promise<number> {
    return Promise.resolve(this.pending);
  }

  async send(request: DepositAuthorizationRequest, options: SendOptions): Promise<Hex> {
    if (this.sendDelayMs > 0) await new Promise((r) => setTimeout(r, this.sendDelayMs));
    if (this.failSend) throw new Error('rpc down');
    this.counter += 1;
    const hash = `0x${'de'}${this.counter.toString(16).padStart(62, '0')}` as Hex;
    this.sends.push({ request, gasLimit: options.gasLimit, nonce: options.nonce, hash });
    // A real chain counts the transaction in its pending nonce once broadcast.
    this.pending = Math.max(this.pending, options.nonce + 1);
    return hash;
  }

  txStatus(txHash: Hex): Promise<'pending' | 'success' | 'reverted'> {
    return Promise.resolve(this.statuses.get(txHash) ?? 'pending');
  }
}

/** The relays the Worker under test sees, per chain (test/worker-entry.ts). */
export const fakeRelays = new Map<number, FakeRelay>();
