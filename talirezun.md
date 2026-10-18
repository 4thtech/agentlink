# @talirezun — sync
**Headline:** M1b in progress: ~35 PRs merged on 2026-10-17 (wave 1 + most of waves 3–4); npm latest still 0.1.0; two-Mac M1 gate test started
_Updated 2026-10-18 06:30 UTC · claude-code / claude-opus-5-5 · orchestrator_

## Now
- **2026-10-17 merged:** live relay subscriptions; `init --harness claude-desktop`; Gemini CLI vs Antigravity detection; "no card from your owner yet" status/doctor; owner recovery without an attached agent; local approval server on localhost (passkey-ready, D-79); terms idempotency; SSRF-safe fetch + path guard (Windows fixes); storage adapters; files/proof policy engine; EIP-712 proof hashing + vectors; ALKP/ALKR backup formats spec (D-82); G-26/G-20 resolved (D-80/D-81); Node ≥ 22.14 check; contact names instead of addresses; changelog fragments (`changelog.d/`); CI gates (bundle-check, e2e in merge gate, Windows/macOS path tests, sync pin guard); knowledge/ consolidated; beginner setup page; two-machine dogfood.
- **2026-10-18: Two-Mac gate run PASSED 17/17** (auto-sync mode, run 20261018-054102): Mac A Claude Code (main build) ↔ Mac B OpenCode (npm 0.1.0), two owners; J1, J4, J9, I-5, F1, J8 verified; secret scan clean both Macs. J2/J3/J5 wait for M1b files/credits/proof.
- **Two-Mac gate run 1:** pairing + receive passed; sends hit AMBIGUOUS_CONTACT (stale duplicate test contact; product behaved correctly). Rerun with fresh agent names pending.

## In flight
- 2026-10-18: MERGED owner change-code, contacts rename/remove, passkey unlock (M1-8e), encrypted drop Worker (M1-27a), STREAM/Revocation vectors, invite approval shows inviter, storage integration CI; nightly two-machine CI live. Only #195 (next 0.1.x release, owner approval) open.
- #228 M1-1k ALKP/ALKR code (queued); #237 docs pass; e2e J8 flake fix; #218 encrypted drop and #230 STREAM/Revocation vectors await owner confirmation of spec details.

## Next
1. Two-Mac rerun (Tali); confirm drop + STREAM spec details.
2. M1-1d STREAM, M1-6b/c, M1-7f/7g, M1-9d file + proof tools; OPS-REL-2 internal scope → @4thtech-io/* (private).
3. Next 0.1.x release (owner approval for npm latest).
## Decisions (still relevant)
- D-79 approval page on localhost (127.0.0.1+::1); D-80 STREAM AAD binds header; D-81 Revocation struct; D-82 ALKP/ALKR blobs.
- Proof default per 06 §3 (≤$1/proof, ≤$5/24h without approval); M1b changesets patch-only until the M1 gate (0.2.0).
- D-72 request accept/block; D-73 M1-9 owner answers; D-74 terms rules.
- D-75 default relays: nos.lol, relay.primal.net, relay.snort.social, nostr.mom.
- D-76 MCP SDK, with module-graph guard; D-77 interim Unicode table.
- D-52/D-57: build → independent review → CI → merge; services auto-deploy.
- D-61/D-62: G-4 batches all-or-nothing; notarize gas ≤ 170k; pause blocks receipts; replacement at finalized block; held envelopes 48 h; `soloAfterRevertSeconds` 1 h.
- D-67: same-user agent risk (G-1) accepted for M1 testnets; re-decided at M2 gate.
- D-68: batch owner approval, one code per reviewed batch, no unlock session; commitments never batched.
- D-69: invite links use raw DEFLATE (RFC 1951).
- D-70: paired contacts Talk without approval by default.
- D-71: deployer keys (testnets: repo secret; mainnet: separate hardware key).

## Asks
- [ ] @denisjazbec: start with `docs/README.md` and `docs/process/onboarding.md`. (2026-10-12)
- [ ] @denisjazbec: D-59 proposes you hold one of two ops pause hardware keys. OK? Needed before M3. (2026-10-14)
- [ ] @denisjazbec: review spec 05 §5.1 and the contract cards M1-3*; D-61 changes pause scope (receipts too). (2026-10-14)
- [ ] @denisjazbec: Tali will share a private review of the Encryptor extension; please look when you can (2026-10-15)

## Heads-up
- OCC v2 is clean-room (D-20); no v1 code is copied.
- Your GitHub approval is not required (D-51); feedback through Tali is welcome.

## Feedback log
_(none yet)_

## Blocked on
- None.
