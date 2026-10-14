// Placeholder suite (M0-9): SHA-256 over published NIST and RFC test values. Its only job is to
// prove the harness. The "code under test" here is the platform's own WebCrypto, which is why this
// file calls crypto.subtle directly; real suites call @agentlink/crypto instead (04 §8.1). When the
// M0-10 boundary guard lands, this file needs either a narrow exemption or a switch to a SHA-256
// export of @agentlink/crypto.
import type { SuiteModule } from '../suite';

export const placeholderSha256: SuiteModule = {
  evaluate() {
    // Tests first (S2): implemented in the next commit.
    return Promise.reject(new Error('placeholder-sha256: not implemented yet'));
  },
};
