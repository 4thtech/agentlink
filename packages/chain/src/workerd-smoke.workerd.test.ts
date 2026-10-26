// M2-3t-w: the chain package (viem, ABI pin, record ids) loads and runs in the Cloudflare Workers
// runtime (workerd), where the cloud agent (M2-3a) will use it. Runs in the `workerd` project only.
import { describe, expect, it } from 'vitest';
import { OCC_V2_ABI_PIN, computeRecordId, isEvmAddress, randomNonce } from './index.js';

describe('@4thtech-io/chain in workerd (M2-3t-w)', () => {
  it('runs inside the Workers runtime, not Node', () => {
    const g = globalThis as { navigator?: { userAgent?: string }; WebSocketPair?: unknown };
    expect(g.navigator?.userAgent).toBe('Cloudflare-Workers');
    expect(typeof g.WebSocketPair).toBe('function');
  });

  it('computes a record id and checks addresses (viem ABI encoding and keccak256)', () => {
    const notary = `0x${'11'.repeat(20)}`;
    const signer = `0x${'22'.repeat(20)}`;
    const nonce = randomNonce();
    const id = computeRecordId(84532, notary, signer, nonce);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeRecordId(84532, notary, signer, nonce)).toBe(id);
    expect(computeRecordId(84532, notary, signer, nonce + 1n)).not.toBe(id);
    expect(isEvmAddress(signer)).toBe(true);
    expect(isEvmAddress('0x1234')).toBe(false);
    expect(OCC_V2_ABI_PIN.manifestSha256).toHaveLength(64);
  });
});
