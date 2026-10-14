// Deterministic test seam (M1-1f): the same code paths as sealKeystoreFile and sealOwnerSeed with the
// nonce supplied by the caller, and Argon2id with a secret value (K) and associated data (X) for the
// RFC 9106 vector. Only tests and the vector harness use it.
//
// It never ships: this file is excluded from the build (tsconfig.json), so dist/ has no testing.js;
// package.json `exports` has no ./testing entry, so no consumer can resolve it; and the boundary
// guards allow `@agentlink/crypto/testing` only in test-vectors/, whose Vitest config maps it to this
// source file (tools/deps-check/policy.mjs RESTRICTED_ENTRY_POINTS). A fixed AES-GCM nonce in
// production would break AES-GCM, so nothing outside tests may reach these functions.
import { argon2idRaw, type Argon2idParams } from './argon2.js';

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
