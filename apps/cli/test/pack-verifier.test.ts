// M1-9h-b: one verifier source. `agentlink verify` (nodePackVerifier) and the MCP verify_proof_pack
// (nodeProofs().tools.verify) go through the same function, so the same pack gets the same verdict
// and reason on both paths (06 §8; 07 §8).
import { readFile } from 'node:fs/promises';
import * as chain from '@4thtech-io/chain';
import { describe, expect, it } from 'vitest';
import { nodePackVerifier } from '../src/commands/verify.js';
import { createPackVerifier, packVerifierReaders } from '../src/runtime/pack-verifier.js';
import { nodeProofs } from '../src/runtime/proofs.js';

const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');
const fetchFn = Object.defineProperty(
  (() => Promise.reject(new Error('no network'))) as unknown as chain.RpcFetchFn,
  ADDRESS_CHECKED,
  { value: true },
);

describe('one pack verifier (M1-9h-b)', () => {
  it('reads every shipped chain, Chiado included', () => {
    const readers = packVerifierReaders({ fetchFn });
    expect(readers.map((r) => r.config.chainId).sort()).toEqual(
      chain
        .chainRegistry()
        .map((c) => c.chainId)
        .sort(),
    );
  });

  it('the same malformed pack gets the same reason through the CLI and the MCP tool', async () => {
    const bytes = new TextEncoder().encode('{"type":"agentlink.proof","version":1');
    const cli = await nodePackVerifier({ fetchFn })(bytes);
    const proofs = nodeProofs({ fetchFn });
    if (proofs === undefined) throw new Error('proofs not available');
    const mcp = await proofs.tools.verify(bytes);
    const direct = await createPackVerifier({ fetchFn })(bytes);
    if (cli.valid || mcp.valid || direct.valid) throw new Error('expected a failure');
    expect(mcp.reason).toBe(cli.reason);
    expect(direct.reason).toBe(cli.reason);
    expect(mcp.verdict).toBe('failed');
  });

  it('both entry points use the shared module and neither calls the chain verifier itself', async () => {
    const files = await Promise.all([
      readFile(new URL('../src/commands/verify.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/runtime/proofs.ts', import.meta.url), 'utf8'),
    ]);
    for (const text of files) {
      expect(text).toContain("pack-verifier.js'");
      expect(text).not.toContain('chain.verifyProofPack');
    }
  });
});
