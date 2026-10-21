// M1-13c, live variant (10 M1-13; 02 J2, J3, J5, J8): the same scenario against the real testnet
// services, through the CLI's default platform: the 4thTech submitter on Base Sepolia, its faucet,
// the shipped RPC, the encrypted drop. Only the relays are local. Automatic chain selection is the
// only selection; Chiado is not auto-selected yet and is not covered here.
//
// Opt-in twice, so it can never run by accident or on an ordinary pull request:
//   AGENTLINK_E2E_LIVE=1             set only by the `e2e-live` job of e2e.yml (manual dispatch on main,
//                                    environment `e2e-live`), or by hand in a developer's shell.
//   AGENTLINK_E2E_LIVE_CONFIRM=testnet-only
//                                    a second, explicit acknowledgement that this spends testnet
//                                    credits from the faucet and talks to live services.
// Without both the suite is skipped (it is not part of the deterministic job's expected counts).
//
// Faucet etiquette: one claim for Alice, never retried; a refusal (already claimed, rate limited,
// daily cap) ends the credit-dependent tests as skipped, not failed, and sends no second request. The
// amounts are the faucet's own $1; the scenario records at most two proofs.
import { defineFilesProofScenario } from './files-proof-scenario.js';
import { createLiveWorld } from './world.js';

defineFilesProofScenario({
  title: 'M1-13c e2e (live, Base Sepolia): files, proof and proof of agreement (J2, J3, J5, J8)',
  enabled:
    process.env['AGENTLINK_E2E_LIVE'] === '1' &&
    process.env['AGENTLINK_E2E_LIVE_CONFIRM'] === 'testnet-only',
  makeWorld: createLiveWorld,
  variant: 'live',
});
