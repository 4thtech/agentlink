// Deterministic test seam (M1-1c, M1-1f): the same code paths as production with the randomness
// supplied by the caller, plus raw primitives for published vectors. Only tests and the vector
// harness use it.
// - M1-1c: wrapCek and encryptPayload with a fixed HPKE ephemeral key or AES-GCM IV, and the raw
//   RFC 9180 suite (hpkeSealSequence, hpkeOpen with any info) for the published CFRG vectors.
// - M1-1f: sealKeystoreFile and sealOwnerSeed with a fixed nonce, Argon2id with a secret value (K)
//   and associated data (X) for the RFC 9106 vector, and pairingDigest for the `labels` vectors.
//
// It never ships: this file is excluded from the build (tsconfig.json), so dist/ has no testing.js;
// package.json `exports` has no ./testing entry, so no consumer can resolve it; and the boundary
// guards allow `@agentlink/crypto/testing` only in test-vectors/, whose Vitest config maps it to this
// source file (tools/deps-check/policy.mjs RESTRICTED_ENTRY_POINTS). A fixed ephemeral key, nonce or
// IV in production would break HPKE and AES-GCM, so nothing outside tests may reach these functions.
import { argon2idRaw, type Argon2idParams } from './argon2.js';

export { hpkeOpen, hpkeSealSequence, wrapCekWithEphemeralKey, type HpkeSealed } from './hpke.js';
export { encryptPayloadWithIv } from './aead.js';

export {
  sealKeystoreFileWithNonceUnsafe as sealKeystoreFileWithNonce,
  sealOwnerSeedWithNonceUnsafe as sealOwnerSeedWithNonce,
} from './keystore-file.js';

// IR-M1-1f-1 L-7: pairingDigest without the commitment check is not public; the `labels` vectors
// (the same input under both tags) reach it here.
export { pairingDigest } from './safety-code.js';

/** RFC 9106 Argon2id v1.3 with K and X (empty = none) and any output length from 4 to 1024. */
export function argon2idWithSecretAndAd(
  password: Uint8Array,
  salt: Uint8Array,
  params: Argon2idParams,
  extras: { readonly secret: Uint8Array; readonly ad: Uint8Array; readonly length: number },
): Promise<Uint8Array> {
  return argon2idRaw(password, salt, params, extras);
}
