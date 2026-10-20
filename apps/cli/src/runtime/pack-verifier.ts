// The one proof pack verifier (M1-9h-b; 06 §8; 07 §8; 05 §9.1 (iv)). `agentlink verify` and the MCP
// tool `agentlink_verify_proof_pack` both build their readers and run the check here, so the same
// pack gets the same verdict and reason on both paths and the two cannot drift.
//
// Every chain of this release is readable for verification, Chiado included (it is held back only
// from automatic selection for paid actions, M1-3j-b). A pack carries its chain; each read goes to
// that chain's shipped RPC and its known Notary only, never to an address or URL from the pack.
import * as chain from '@4thtech-io/chain';
import { nodeRpcFetch } from '@4thtech-io/node';

/** Verifies the pack (bytes or parsed JSON) over the shipped chains. */
export type PackVerifierFn = (
  pack: Uint8Array | Readonly<Record<string, unknown>>,
) => Promise<chain.ProofPackResult>;

export interface PackVerifierOptions {
  /** The address-checked RPC fetch. Default: `nodeRpcFetch()`. */
  readonly fetchFn?: chain.RpcFetchFn;
  /** The chains a pack may name. Default: every shipped chain (`chainRegistry()`). */
  readonly configs?: readonly chain.ChainConfig[];
  /** Readers already built for some chains; reused instead of building a second client. */
  readonly reuse?: readonly chain.VerifyChain[];
}

/** One read client per chain a pack may name. */
export function packVerifierReaders(options: PackVerifierOptions = {}): chain.VerifyChain[] {
  const fetchFn = options.fetchFn ?? nodeRpcFetch();
  return (options.configs ?? chain.chainRegistry()).map((config) => {
    const own = options.reuse?.find((r) => r.config.chainId === config.chainId);
    return own ?? { config, client: chain.createReadClient(config, { fetchFn }) };
  });
}

/** The verifier. The readers are built on first use. */
export function createPackVerifier(options: PackVerifierOptions = {}): PackVerifierFn {
  let readers: chain.VerifyChain[] | undefined;
  return (pack) => {
    readers ??= packVerifierReaders(options);
    return chain.verifyProofPack(pack, { chains: readers });
  };
}
