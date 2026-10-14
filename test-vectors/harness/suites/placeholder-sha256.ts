// Placeholder suite (M0-9): SHA-256 over published NIST and RFC test values. Its only job is to
// prove the harness. The "code under test" here is the platform's own WebCrypto, which is why this
// file calls crypto.subtle directly; real suites call @agentlink/crypto instead (04 §8.1). When the
// M0-10 boundary guard lands, this file needs either a narrow exemption or a switch to a SHA-256
// export of @agentlink/crypto.
import { bytesToHex, hexToBytes } from '../hex';
import type { SuiteModule } from '../suite';

interface Sha256Case {
  readonly hex: string;
  readonly repeat: number;
  readonly sha256: string;
}

function parse(input: unknown, expected: unknown): Sha256Case {
  const i = input as { hex?: unknown; repeat?: unknown } | null;
  const e = expected as { sha256?: unknown } | null;
  if (typeof i?.hex !== 'string' || !Number.isSafeInteger(i.repeat) || (i.repeat as number) < 1) {
    throw new TypeError('placeholder-sha256: input must be { hex: string, repeat: integer >= 1 }');
  }
  if (typeof e?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) {
    throw new TypeError('placeholder-sha256: expected must be { sha256: 64 lowercase hex digits }');
  }
  return { hex: i.hex, repeat: i.repeat as number, sha256: e.sha256 };
}

export const placeholderSha256: SuiteModule = {
  async evaluate(testCase) {
    const { hex, repeat, sha256 } = parse(testCase.input, testCase.expected);
    const unit = hexToBytes(hex);
    const message = new Uint8Array(unit.length * repeat);
    for (let i = 0; i < repeat; i += 1) message.set(unit, i * unit.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message));
    return [{ field: 'sha256', actual: bytesToHex(digest), expected: sha256 }];
  },
};
