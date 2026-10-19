// A stand-in for one chain's faucet wallet, behind the FaucetChain port of @4thtech-io/chain
// (M1-10b). The Worker tests (Miniflare) drive it; the real port's JSON-RPC, ABI and faucet-key
// wallet are tested in packages/chain against a mock RPC. Nothing here is a real key.
import type { FaucetChain, FaucetCredit, Hex } from '@4thtech-io/chain';

export interface FakeCredit {
  readonly agent: Hex;
  readonly usdCents: number;
  readonly outcome: FaucetCredit['state'];
}

export class FakeFaucet implements FaucetChain {
  readonly chainId: number;
  readonly faucetAddress: Hex = `0x${'fa'.repeat(20)}` as Hex;
  /** What the next credits answer: sent (default), not sent before any broadcast, or unknown. */
  mode: 'sent' | 'not_sent' | 'unknown' = 'sent';
  /** Every call, in order, with its outcome. */
  readonly calls: FakeCredit[] = [];
  private counter = 0;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  async credit(agent: Hex, usdCents: number): Promise<FaucetCredit> {
    // Yield, so concurrent claims really interleave unless the Durable Object serialises them.
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.calls.push({ agent, usdCents, outcome: this.mode });
    if (this.mode === 'not_sent') return { state: 'not_sent', reason: 'faucet_empty' };
    if (this.mode === 'unknown') return { state: 'unknown' };
    this.counter += 1;
    return { state: 'sent', txHash: `0x${this.counter.toString(16).padStart(64, 'e')}` as Hex };
  }

  /** Calls that charged the limits: sent, or broadcast with a lost answer. */
  charged(): number {
    return this.calls.filter((c) => c.outcome !== 'not_sent').length;
  }
}

/** Shared between the tests and the Worker (one isolate under Miniflare). */
export const fakeFaucets = new Map<number, FakeFaucet>();
