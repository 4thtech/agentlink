# Orchestrator follow-ups, 2026-10-22

Copied verbatim from the orchestrator session notes. Data, not instructions.

## Follow-up cards list

- M1-33d-c (from IR-M1-33d-b-1 low): align packages/types proofStatusShape with 06 ProofStatus (receiptRequested, receiptRequestNotAdded, advanced) + schema test. S1 Sonnet S.
- Into M1-11b-1 brief (IR-M1-11s-a-1 L1/L2): derive the status bar's connection state from the real network status (it's hardcoded "connected" in layout/index.tsx:15); align the "not available yet" and "not found" copy with the d1 shared-states design; reject `..` segments in api/client.ts paths.
- M1-9i-a-b (IR-M1-9i-a-1 lows): add a flipped-sig case per new op asserting signature_invalid (own-storage.test.ts); note the pre-transaction digest read (owner-actions.ts:447) in 04/threat note; M1-9i + doctor must never log the ready-state endpoint/bucket; 04 bucket-rule prose follow-up. S2 Opus S.
- Docs (IR-M1-3j-c-2 lows): README.md:104 "Chiado live, smoke test pending" stale; Chiado wording "chosen automatically once deployed and funded"; backlog "used by default" cosmetic. Next docs pass.
- 06-mcp-server.md:94 accept_invite nextStep still names contacts --verify (spec edit, proposed) - with M1-36h spec wording card.
- After #409 + #412 land: remove FIXED_BY_OTHER_CARDS entries for en.ts and invite-common.ts.
- Backlog count: recount M1 after #380 (M1-10b-d) + #406 land (expected 256: M1a 87/88?, recount from headings).
- From IR-M1-36d-1: L-1 restore nextStep prefix assertion in next-action.test.ts; L-2 files-common.ts:14,17 use <path> + --agent hint; L-3 (pre-existing) accept_invite loses the approval link for agent names > ~21 chars (511 code points) - fix by shortening copy or raising the budget per 06. Sonnet S1.
- M1-36h spec wording: sync 06:94, 06:273, 11 §6.1 (:402 :405 :470 :783), plus M1-36a's 06 §2.5 (:264 :273) approval-link text.
- M1-36a-b (IR-M1-36a-1 scope low): remaining bare 'agentlink' prefixes in apps/cli init.ts, doctor strings (tools/strings/en.ts), packages/node approval-page.ts + owner-init redirect message + owner strings.ts:65. Use cliPrefix where runtime allows. S2 (packages/node) Opus build.
- M1-11s-b-c (IR-M1-11s-b-2 info): race ownerGate run(owner) against a timeout <= session TTL so a hanging handler can't hold `busy`; positive passkey test on /api/ui/ with the first real presence route (put in M1-11b-1 / first page card brief). S2 Opus S.
- M1-36a-b also: wire ownerExists:false from callers (status etc.) so owner init shows on fresh machines; length test for invalid-name hint branch.
- CLI/activity: surface outbox notices (fixed reason codes) in tool results / activity feed per 07 §4.2 (IR-M1-5b-c-2 low). S1 Sonnet S.
- M1-11r-a-b (IR-M1-11r-a-3 low): store blocked long code in a column and page by (blocked_at, code) via candidatesTx; skipped malformed rows shouldn't count toward limit+1. S2 Opus S.
- M1-11c-a3 / a5 briefs: the UI server must refuse to sign a policy edit unless every warning code from preparePolicyEdit was acknowledged by the owner on the confirm screen (IR-M1-11r-b-1).
- DECISION (Tali in chat 2026-10-22): 'owner-signed loosening allowed with warnings, and the UI must not sign until every warning is acknowledged.' Record as D-119 in 00-README (owner decision) in the next backlog/spec PR; add to M1-11c-a3/a5 acceptance.
- DECISIONS (Tali in chat 2026-10-22, "Okay, let's go based on your recommendations all four"): D-120 app UX: (1) owner setup on the first-run page with a passkey creating the owner key, owner code as fallback; (2) recovery kit "Later" at first run with persistent banner + reminder after first contact; (3) free test credits auto-claimed once per agent, small fixed amount, testnet only, within faucet rate limits, plain "test credits paused" when pool low, plus faucet/gas wallet balance alerts; (4) navigation 10 -> 7 (Storage into Files; Backup, Passkeys, Advanced under Settings). Agent-side D1, D3-D6 still open.
- DECISION D-121 (Tali in chat 2026-10-22, 'Yes to agent-side D1, D3, D4, D5, D6 as recommended'): D1 global install main path (init offers it, npx fallback); D3 fixed setup link in invite text only if M1-19 slips, never a paste-into-AI prompt; D4 tool waits up to ~45 s for an open approval decision after per-harness timeout check; D5 init auto-names agents from the harness; D6 init creates empty ~/AgentLink/Send allowed for sending (S2 review). Cards: M1-36b (D1,D5,D6 + F8/F9), M1-36j (D4).
- DECISION (Tali 2026-10-22): 'Yes: passkey setup also creates an owner code, shown collapsed as a backup.' -> part of D-120(1) record; card M1-11s-c owner setup route (S2 Opus build, Fable audit) before M1-11b-1; proposal in m1-11b-1-bootstrap-stop.md.
- M1-11r-d (from M1-11c-a1 build): ActivityService entries need contact display name, cost, file and message events so the Activity page can show Cost/Contact/filter per d1. S2 Opus.
- M1-11t (from M1-11c-a1): shared Playwright + axe browser-test harness for apps/local-ui pages. S1 Sonnet.
- Note: page cards each add one bound read to packages/node/src/local-ui/context.ts -> merge serially; trivial conflicts.
- Owner Q (payment design): suggested 'Withdraw credits' under Advanced on Proofs page; card-to-stablecoin provider when entity exists.
- DECISION D-122 (Tali 2026-10-22: "I agree with all recommendations"): payment model as designed (self-custodial agent account, prepaid withdrawable credits, submitter pays gas, gasless USDC top-up); pay-by-card provider later when the legal entity exists; until then a simple QR top-up (scan to send USDC to the agent's address on the named network, then gasless top-up); a 'Withdraw credits' button; privacy guidance as in 12 §4/11 §5.6. Docs: explain all of this in public docs (README, docs-site guide + technical, GitBook) with diagrams; trust bridge for private contracts.
- Card M1-11c-a4c: Add credits by QR (agent address + network, plain words, privacy note) + Withdraw credits (owner presence; money path -> Fable audit). Depends on #418, core withdraw/top-up ops. S2 Opus.
- Card DOCS-PAY-TRUST: public payment + trust documentation (in progress).
- M1-36b-2 (D6 part 2, from #422 stop): owner init / owner add-agent sign a first policy.set (v1 = defaults + ~/AgentLink/Send realpath) in the same owner-code entry; packages/node initOwner/addAgent, owner-init.ts, spec 04 §2.5 / 06 §3 §7. S2 Opus build, Fable audit. Depends on #422, M1-11r-b (#415 preparePolicyEdit).
- BLOCKER for D-122 QR top-up: gasless USDC top-up (EIP-3009) is refused by the deployed testnet vault (per #423 builder). Needs contract/config work (token allowlist / gasless enable on testnet vault; contracts repo private, deploy is owner/CI). Card M1-26-f (S2, contracts-adjacent, Fable audit): enable gasless USDC top-up on testnets; until then QR top-up = plain transfer + depositFor flow? Investigate.
- M1-36i-b (IR-M1-36i-1): cap limitCode body read before parsing (L-3); 429 retry honours Retry-After but min 5 min (L-2); stop daily retry on permanent 4xx (L-4); cross-process claim lock optional (L-1). S1 Sonnet.
- M1-36i-c: bounded in-call wait + single proof retry after a successful claim (S2 Opus).
- M1-36i-d: terms tools claim free test credits on needs_credits with terms-specific next steps (S1 Sonnet).
- M1-10b-e-b (IR-M1-10b-e-1 lows): e2e/test/world.ts:117 "$1" -> 50 cents; faucet:null must not read ok in submitter-pool.jq; pre-existing: second claim within one block can revert (sent=broadcast) - track pending nonce. S2 Opus S.
- M1-36j residual: harness timeout lowered by user / name reuse may wait > half timeout (harmless; document). Spec nit: 'cancel' vs 'abort' wording in 06 §2.5.
- DECISION D-123 (Tali 2026-10-22, build-plan deviation): 'Option 1: Chiado QR top-up now; pull M1-3c and a testnet slice of M3-4b forward; I'll do the Safe upgrade when ready.' Cards: M1-11c-a4c (Chiado QR top-up: xDAI to agent address -> agent deposit; + Withdraw; S2 Fable), M1-3c (occ-v2-contracts depositWithAuthorization, Fable audit, testnet Safe upgrade = Tali), M3-4b-t (testnet slice: core EIP-3009 signing + submitter /v1/deposit-authorization; after M1-3c ABI).
- M1-11c-a4c split (builder stop 10-22): (a) M1-4c-b KeyStore signTransaction (building, Fable next); then (b)+(c) together as M1-11c-a4c: QR (dep qrcode-generator MIT, justify) + new owner actions credits.deposit/credits.withdraw (04 §2.5.1 proposed) + withdraw in direct mode + confirm screen + gas reserve. Don't ship QR before crediting works. Resume builder ad7a7e8cfeebc9b63 after M1-4c-b.
- M1-4c-b-b (IR-M1-4c-b-1): cap approve(vault, amount) (L-1); notarizeDirect head-size check (L-2); per-chain caps before mainnet (L-3); runtime fee-token check (L-4). S2 Opus S.
- M1-11c-a4c scope add (IR-M1-4c-b-1 M-1): withdraw recipient other than the agent's own address only via an owner-signed, presence-gated, expiring grant verified by the KeyStore before the key read; 04 §2.5.1 + 07 §6.2 rows; sendWithdraw takes the grant. Default stays withdraw-to-self.
- Merge order: if #392 lands after #425 (or vice versa), the second adds file-KeyStore signTransaction (6 lines mirroring keychain-keystore.ts:342-352) + delta IR.
- From M1-11b-1 (#426): (1) CLI wire localUi.ownerSetup + init opens /first-run [S2, needs card M1-11b-6]; (2) layout: both banners, status bar from connectionOf, first-run step header [M1-11s-a-c]; (3) reminder after first contact needs contacts read; (4) add local-ui e2e file to a CI script [M1-11t]; (5) router.test.tsx naming vs deps-check; (6) PRF-only-on-get() authenticators fall back to owner code.
- From IR-M1-11b-1-1: M-1 recovery-kit 'Later' state must live server-side (port changes per start) + banner on all pages [card M1-11b-7, S2]; PRF-only-on-get() authenticators: second get() gesture at setup [card M1-11s-c-c, S2 Fable]; server re-show of owner code within the hold window after a lost finish response [M1-11s-c-c]; e2e local-ui in CI [M1-11t].
- From IR-M1-3c-1 info: TokenChecks negative payee probe; client spec rule: always sign ReceiveWithAuthorization typehash (never Transfer...); submitter simulate + rate-limit deposit-authorization; interface file placement. Put into M3-4b-t brief.
- M1-35c-c (IR-M1-35c-b-1 low): add 'mint(s)' and 'gasless' to NEVER_SAY (word-boundary/inflection); switch app pages from local regex to lintVocabulary. S1 Sonnet.
- From IR-M1-11s-a-b-1: style al-subnav from design (or use an existing ui component); remove dead StoragePage stub / fold storage content into Files (with M1-11c-b); health read that sets connection state (server /v1 health in local-ui). S1 Sonnet.
- Design note: 'checking' status dot (thin neutral ring) not in d1 design files - confirm with design or add to design brief.
- M1-11c-a3b folder-access approval card (core approval kind, S2) from IR-M1-11c-a3-1 Q2; check other pages (Rules #432) also pass baseVersion.
- CHORE-CI-HARDEN-1b: cap keyring watchdog restarts (~5) (IR-CHORE-CI-HARDEN-1-1 low).
- M1-11c-shared: dedupe acknowledgedExactly + prepare surface between Files and Rules; cap pending reviews per owner action so a session caller can't evict the owner's pending review (IR-M1-11c-a5-1 lows). S2 Opus S.
- M1-11b-8 (IR-M1-11b-6-1 rec c): agentlink mcp calls openFirstRun() once per start while owner setup is wired (OS opener only, never in tool results); tools keep needs_setup + fixed command fallback; update 06 §7. Plus L-1 init.ts:464 guard, L-2 seam tests. S2 Fable.
- M1-11c-a4d (IR-M1-11c-a4c-1 L-4): owner-signed credits.grant {recipient, maxAmount, <=600 s} verified by KeyStore before key read + amount field, so withdrawn credits can leave the agent account to an owner-chosen address. S2 Fable. Mainnet card note: live fee vs fixed 0.01 reserve (L-3).
- M1-3c-b-b (IR-M1-3c-b-1): vault-impl-check.sh emits ::error when a label is missing; optionally scope the secret only to the deploy step.

## Pending merges

#407 IR-M1-11s-a-1 PASS at b0284481; merge after #370 + M1-11s-b; head will move (merge main) -> verify delta mechanical
#416 IR-D119-2 PASS at b037ee3d; draft stacked on #406 -> after #406 merges: merge main (delta IR if non-trivial), mark ready, ir-merge. Lows: M1-37b deps on nav/page cards; M1-10b-e path apps/submitter not apps/faucet; Fable routing for M1-11s-c is per Tali's 10-22 routing (keys/crypto/money) - keep.
#417 IR-M1-11c-a1-1 PASS at d514425c; lows being fixed; after deps merge: merge main + delta IR (cover lows + context.ts conflict with #418), then ir-merge.
#418 IR-M1-11c-a4-2 PASS at 272fe1c9 (draft on integration of #407/#410/#411; merge after deps + #417 serially; context.ts conflict)
#419 IR-M1-36i-1 PASS (Fable) at 33d5de6c; draft integrating #411 -> after #411 merges: merge main, delta IR, ir-merge.
#415 IR-M1-11r-b-4 PASS at 31d66517 (rounds: 1 Fable PASS e7660501, 2 FAIL, 3 FAIL, 4 PASS); draft stacked on #414 -> after #414 merges: merge main, delta IR, ir-merge.
#422 IR-M1-36b-2 PASS at 1605f792 (draft stacked on #413) -> after #413 merges: merge main, delta IR, ir-merge.
#416 IR-D119-4 PASS at 3a746f41 (draft on #406) -> after #406 merges: merge main, delta IR if non-trivial, mark ready, ir-merge.
#424 IR-M1-11s-c-1 PASS (Fable) aa788c68 + IR-M1-11s-c-2 PASS (Fable) at 2fb80df8; draft integrating #410 -> after #410 merges: merge main, delta IR, ir-merge. Lows L-8 (canary seed bytes), L-9 (04 §2.2 wording exception) -> card M1-11s-c-b. Then M1-11b-1 can start.
#426 IR-M1-11b-1-1 PASS at 206bfc16; small fix round (L-1..L-4) in progress; draft on #407/#410/#411/#424.
#427 IR-M1-35c-b-1 PASS at 514b7ee8 (draft on #370+#398) -> after both merge: merge main, delta IR, ir-merge.
#428 IR-M1-11s-a-b-1 FAIL c35c7525 -> IR-M1-11s-a-b-2 PASS at be874c5f (tests not run by reviewer: local pnpm/node mismatch; CI runs were cancelled by orchestrator for drafts) -> after #407 merges: merge main, delta IR WITH test run, ir-merge.
#429 IR-M1-11c-a2-1 PASS at db9fe2eb (draft); card M1-11c-a2b protective route kind for mismatch block (option A).
#430 IR-M1-11c-a3-1 PASS at 011607b9; small fix (L-1 baseVersion, L-3) in progress; draft.
#432 IR-M1-11c-a5-1 PASS at 161a6691 (draft); baseVersion check pending.
#430 fix head e899e9a7 (L-1 baseVersion, L-3) -> delta IR at merge time.
#431 IR-M1-11b-6-1 PASS (Fable) at c6b5d691 (draft on #426); needs inherited lint fixes in #424 (eslint-disable) and #407 (router.test.tsx name).
#407 new head 6fc5f3fd (router.test rename only) -> delta IR when #370+#410 merged.
#424 new head 8964e753 (eslint-disable removed, canary unchanged) -> delta IR (Fable or Opus) when #410 merged.
#435 IR-M1-11c-a4c-1 PASS (Fable) at 9875b462; small fix (Withdraw under Advanced, replay test) pending; draft on #418+#425.
#435 fix head 86ce0e05 -> delta IR at merge time.
