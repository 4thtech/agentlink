// A semantic stand-in for one chain's Notary, behind the SubmitterChain port of @4thtech-io/chain
// (M1-10a). The engine tests (Node) and the Worker tests (Miniflare) drive it; the real port's
// JSON-RPC, ABI and gas-key wallet are tested in packages/chain against a mock RPC.
//
// Model: an item simulates `ok` unless the test says otherwise; a sent transaction is included when
// the test calls `include`, all-or-nothing as `notarizeBatch` is (05 §3.3): it reverts if any item
// fails at inclusion (`failAtInclusion`) or the Notary is paused, and items already on-chain are
// skipped. Nothing here is a real key or signature.
import {
  itemSignatureMatches,
  type BatchSimulation,
  type Hex,
  type ItemSimulation,
  type SubmitItem,
  type SubmitterChain,
  type TxInclusion,
} from '@4thtech-io/chain';

export interface SentTx {
  readonly hash: Hex;
  readonly ids: readonly string[];
  readonly signers: readonly string[];
  readonly gasLimit: bigint;
  readonly nonce: number;
  /** The simulated gas the engine was given for exactly these items. */
  readonly simulatedGas: bigint;
}

/** Simulated gas for a batch of n items (05 §3.4 shape: a base plus a per-item part). */
export const fakeBatchGas = (n: number): bigint => 60_000n + 95_000n * BigInt(n);

export class FakeChain implements SubmitterChain {
  readonly chainId: number;
  readonly notary: Hex;
  readonly gasAddress: Hex;
  /** `accept`: every signature matches (engine tests); `real`: the EOA check of @4thtech-io/chain. */
  signatureCheck: 'accept' | 'real' = 'accept';
  /** Signers with code (ERC-1271 accounts, EIP-7702 delegations). */
  readonly code = new Set<string>();
  /** Item IDs already on-chain in identical form. */
  readonly onChain = new Set<string>();
  /** Item ID -> the contract error its simulation reverts with. */
  readonly simulationErrors = new Map<string, string>();
  /** Item IDs that pass simulation but make an including transaction revert. */
  readonly failAtInclusion = new Set<string>();
  paused = false;
  /** Make `send` throw (an RPC failure). */
  sendFails = false;
  balance = 10n ** 17n;
  nonce = 7;
  readonly sent: SentTx[] = [];
  /** Gas the engine simulated, keyed by the joined item IDs. */
  private readonly simulated = new Map<string, bigint>();
  private readonly results = new Map<string, TxInclusion>();
  private counter = 0;

  constructor(chainId: number, notary: Hex) {
    this.chainId = chainId;
    this.notary = notary;
    this.gasAddress = `0x${'9'.repeat(40)}` as Hex;
  }

  signatureMatches(item: SubmitItem): boolean {
    return this.signatureCheck === 'accept'
      ? true
      : itemSignatureMatches(this.chainId, this.notary, item);
  }

  hasCode(address: Hex): Promise<boolean> {
    return Promise.resolve(this.code.has(address));
  }

  simulateItem(item: SubmitItem): Promise<ItemSimulation> {
    if (this.onChain.has(item.id)) return Promise.resolve({ outcome: 'skipped' });
    if (this.paused) return Promise.resolve({ outcome: 'paused' });
    const error = this.simulationErrors.get(item.id);
    if (error !== undefined) return Promise.resolve({ outcome: 'failed', error });
    return Promise.resolve({ outcome: 'ok' });
  }

  simulateBatch(items: readonly SubmitItem[]): Promise<BatchSimulation> {
    if (this.paused) return Promise.resolve({ ok: false, error: 'EnforcedPause', paused: true });
    for (const item of items) {
      const error = this.simulationErrors.get(item.id);
      if (error !== undefined && !this.onChain.has(item.id)) {
        return Promise.resolve({ ok: false, error, paused: false });
      }
    }
    const gas = fakeBatchGas(items.length);
    this.simulated.set(items.map((i) => i.id).join(','), gas);
    return Promise.resolve({ ok: true, gas });
  }

  pendingNonce(): Promise<number> {
    return Promise.resolve(this.nonce);
  }

  async send(
    items: readonly SubmitItem[],
    options: { readonly gasLimit: bigint; readonly nonce: number },
  ): Promise<Hex> {
    // Yield, so concurrent callers interleave here as they would around a real RPC request.
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (this.sendFails) throw new Error('The chain could not be reached.');
    this.counter += 1;
    const hash = `0x${this.counter.toString(16).padStart(64, 'e')}` as Hex;
    const ids = items.map((i) => i.id);
    this.sent.push({
      hash,
      ids,
      signers: items.map((i) => i.signer),
      gasLimit: options.gasLimit,
      nonce: options.nonce,
      simulatedGas: this.simulated.get(ids.join(',')) ?? -1n,
    });
    this.nonce = Math.max(this.nonce, options.nonce + 1);
    this.pendingItems.set(hash, [...items]);
    return hash;
  }

  private readonly pendingItems = new Map<string, SubmitItem[]>();

  /** Includes every sent, not yet included transaction, in order (a block). */
  includeAll(): void {
    for (const hash of this.pendingItems.keys()) this.include(hash as Hex);
  }

  /** Includes one sent transaction: all-or-nothing, identical items skipped (05 §3.3). */
  include(hash: Hex): void {
    const items = this.pendingItems.get(hash);
    if (!items) return;
    this.pendingItems.delete(hash);
    if (this.paused || items.some((i) => this.failAtInclusion.has(i.id) && !this.onChain.has(i.id))) {
      this.results.set(hash, { state: 'reverted' });
      return;
    }
    const outcomes = new Map<string, 'recorded' | 'skipped'>();
    for (const item of items) {
      outcomes.set(item.id, this.onChain.has(item.id) ? 'skipped' : 'recorded');
      this.onChain.add(item.id);
    }
    this.results.set(hash, { state: 'included', outcomes });
  }

  inclusion(txHash: Hex): Promise<TxInclusion> {
    return Promise.resolve(this.results.get(txHash) ?? { state: 'pending' });
  }

  gasBalance(): Promise<bigint> {
    return Promise.resolve(this.balance);
  }
}

/** The fake chains the Miniflare test Worker serves, by chain ID (test/worker-entry.ts). */
export const fakeChains = new Map<number, FakeChain>();

let itemCounter = 0;

/** A synthetic record item for engine tests (never parsed or signed). */
export function fakeRecordItem(signer: string, deadline = 4_000_000_000): SubmitItem {
  itemCounter += 1;
  const recordId = `0x${itemCounter.toString(16).padStart(64, '0')}` as Hex;
  return {
    type: 'record',
    id: recordId,
    recordId,
    signer: signer as Hex,
    deadline,
    record: { signer, nonce: String(itemCounter), deadline } as never,
    signature: '0x00' as Hex,
  };
}

/** A synthetic signer address. */
export const signerAddress = (n: number): Hex => `0x${n.toString(16).padStart(40, 'a')}` as Hex;
