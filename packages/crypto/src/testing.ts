// Deterministic test seam (M1-1c): the same code paths as wrapCek and encryptPayload, with the
// randomness (HPKE ephemeral key, AES-GCM IV) supplied by the caller, plus the raw RFC 9180 suite
// for the published CFRG vectors. Only tests and the vector harness use it.
//
// It never ships: this file is excluded from the build (tsconfig.json), so dist/ has no testing.js;
// package.json `exports` has no ./testing entry, so no consumer can resolve it; and the boundary
// guards allow `@agentlink/crypto/testing` only in test-vectors/, whose Vitest config maps it to this
// source file (tools/deps-check/policy.mjs RESTRICTED_ENTRY_POINTS). A fixed ephemeral key or IV in
// production would break HPKE and AES-GCM, so nothing outside tests may reach these functions.
export { hpkeOpen, hpkeSealSequence, wrapCekWithEphemeralKey, type HpkeSealed } from './hpke.js';
export { encryptPayloadWithIv } from './aead.js';
