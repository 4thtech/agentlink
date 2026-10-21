// A stand-in for one chain's faucet wallet, behind the FaucetChain port of @4thtech-io/chain
// (M1-10b). The Worker tests (Miniflare) drive it; the real port's JSON-RPC, ABI and faucet-key
// wallet are tested in packages/chain against a mock RPC. Nothing here is a real key.
import type { FaucetChain, FaucetCredit, Hex } from '@4thtech-io/chain';

export interface FakeCredit {
  readonly agent: Hex;
  readonly usdCents: number;
  readonly outcome: FaucetCredit['state'];
}

/** The faucet address the Miniflare tests pin (vitest.config.ts, SUBMITTER_FAUCET_ADDRESS_84532). */
export const FAKE_FAUCET_ADDRESS = `0x${'fa'.repeat(20)}` as Hex;

export class FakeFaucet implements FaucetChain {
  readonly chainId: number;
  readonly faucetAddress: Hex;
  /** What the next credits answer: sent (default), not sent before any broadcast, or unknown. */
  mode: 'sent' | 'not_sent' | 'unknown' = 'sent';
  /** Why a `not_sent` credit sent nothing. */
  notSentReason: Extract<FaucetCredit, { state: 'not_sent' }>['reason'] = 'faucet_empty';
  /** Called at the start of every credit, before it answers (to look at storage then). */
  onCredit: (() => void | Promise<void>) | null = null;
  /** Every call, in order, with its outcome. */
  readonly calls: FakeCredit[] = [];
  private counter = 0;

  constructor(chainId: number, faucetAddress: Hex = FAKE_FAUCET_ADDRESS) {
    this.chainId = chainId;
    this.faucetAddress = faucetAddress;
  }

  async credit(agent: Hex, usdCents: number): Promise<FaucetCredit> {
    if (this.onCredit) await this.onCredit();
    // Yield, so concurrent claims really interleave unless the Durable Object serialises them.
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.calls.push({ agent, usdCents, outcome: this.mode });
    if (this.mode === 'not_sent') return { state: 'not_sent', reason: this.notSentReason };
    this.counter += 1;
    const txHash = `0x${this.counter.toString(16).padStart(64, 'e')}` as Hex;
    if (this.mode === 'unknown') return { state: 'unknown', txHash };
    return { state: 'sent', txHash };
  }

  /** Calls that charged the limits: sent, or broadcast with a lost answer. */
  charged(): number {
    return this.calls.filter((c) => c.outcome !== 'not_sent').length;
  }
}

/** Shared between the tests and the Worker (one isolate under Miniflare). */
export const fakeFaucets = new Map<number, FakeFaucet>();
