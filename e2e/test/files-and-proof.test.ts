// M1-13c, deterministic variant (10 M1-13; 06 §9; 02 J2, J3, J5, J8; D-40, D-48, D-109). The files,
// proof and proof-of-agreement scenario (files-proof-scenario.ts) against the repo's fakes: the real
// agent stack in this process, a shared in-memory Notary (packages/core/src/testing FakeNotary) in
// place of the chain and the submitter, and an in-memory encrypted drop in place of the drop. No
// network beyond the local strfry relays, no secret, no key.
//
// Opt-in as in the other e2e suites: it runs only with AGENTLINK_REQUIRE_E2E=1 (the e2e workflow),
// because it writes test agent items to the OS keychain and starts Docker containers. With the flag
// set, a missing Docker or keychain FAILS the run instead of skipping it.
import { defineFilesProofScenario } from './files-proof-scenario.js';
import { createFakeWorld } from './world.js';

defineFilesProofScenario({
  title: 'M1-13c e2e (deterministic): files, proof and proof of agreement (J2, J3, J5, J8)',
  enabled: process.env['AGENTLINK_REQUIRE_E2E'] === '1',
  makeWorld: createFakeWorld,
  variant: 'deterministic',
});
