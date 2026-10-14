// Suite `owner-wrap` (M1-1f): Argon2id v1.3 (RFC 9106) through @agentlink/crypto, at the RFC's own
// parameters and at the owner-wrap and file KeyStore parameters (04 §2.3, §2.8). A case with no
// secret value (K) and no associated data (X) runs the production function; the RFC 9106 case, which
// has both, runs the same code path through the test seam. Runs in all five runtimes: the timing at
// m = 64 MiB in browsers and workerd is part of M1-1f's acceptance.
import { argon2id } from '@agentlink/crypto/keystore';
import { argon2idWithSecretAndAd } from '@agentlink/crypto/testing';
import { bytesToHex, hexToBytes } from '../hex';
import type { SuiteModule } from '../suite';

interface Argon2idInput {
  op: 'argon2id';
  password: string;
  salt: string;
  secret: string;
  ad: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  length: number;
}

function parseInput(input: unknown): Argon2idInput {
  const i = input as Record<string, unknown> | null;
  const str = (key: string): boolean => typeof i?.[key] === 'string';
  const num = (key: string): boolean => typeof i?.[key] === 'number';
  if (
    i?.op === 'argon2id' &&
    ['password', 'salt', 'secret', 'ad'].every(str) &&
    ['memoryKiB', 'iterations', 'parallelism', 'length'].every(num)
  ) {
    return i as unknown as Argon2idInput;
  }
  throw new TypeError('owner-wrap: input does not match any op of case.schema.json');
}

export const ownerWrap: SuiteModule = {
  async evaluate(testCase) {
    const input = parseInput(testCase.input);
    const params = {
      memoryKiB: input.memoryKiB,
      iterations: input.iterations,
      parallelism: input.parallelism,
    };
    const password = hexToBytes(input.password);
    const salt = hexToBytes(input.salt);
    const tag =
      input.secret === '' && input.ad === '' && input.length === 32
        ? await argon2id(password, salt, params)
        : await argon2idWithSecretAndAd(password, salt, params, {
            secret: hexToBytes(input.secret),
            ad: hexToBytes(input.ad),
            length: input.length,
          });
    return [{ field: 'tag', actual: bytesToHex(tag) }];
  },
};
