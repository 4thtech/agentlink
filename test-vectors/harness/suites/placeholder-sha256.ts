// Placeholder suite (M0-9): SHA-256 over published NIST and RFC test values. Its only job is to
// prove the harness. The "code under test" here is the platform's own WebCrypto, which is why this
// file calls crypto.subtle directly; real suites call @4thtech-io/crypto instead (04 §8.1). The M0-10
// boundary guard exempts exactly this path (test-vectors/**/placeholder-sha256.ts); keep the name.
import { bytesToHex, hexToBytes } from '../hex';
import type { SuiteModule } from '../suite';

function parseInput(input: unknown): { hex: string; repeat: number } {
  const i = input as { hex?: unknown; repeat?: unknown } | null;
  if (typeof i?.hex !== 'string' || !Number.isSafeInteger(i.repeat) || (i.repeat as number) < 1) {
    throw new TypeError('placeholder-sha256: input must be { hex: string, repeat: integer >= 1 }');
  }
  return { hex: i.hex, repeat: i.repeat as number };
}

export const placeholderSha256: SuiteModule = {
  async evaluate(testCase) {
    const { hex, repeat } = parseInput(testCase.input);
    const unit = hexToBytes(hex);
    const message = new Uint8Array(unit.length * repeat);
    for (let i = 0; i < repeat; i += 1) message.set(unit, i * unit.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message));
    return [{ field: 'sha256', actual: bytesToHex(digest) }];
  },
};
