# @talirezun — sync
**Headline:** 0.2.0 released 24 Oct; two-Mac owner test passed 25 Oct; UI chain for 0.3.0 and first run v2 are next.
_Updated 2026-10-25T10:30Z · claude-code / claude-haiku-5-5 · orchestrator, morning_

## Now
- 0.2.0 is released (24 Oct): npm `latest`, signed macOS and Windows bundles, SHA256SUMS.
- Owner two-Mac test passed (25 Oct): messages and a file both ways. Findings are carded.
- Drain before migration: no new builders near the end, and all merges closed. Keep the CI queue short (GitHub Free).

## Merged since 24 Oct (highlights)
- First run opens from `agentlink init`; new `agentlink ui` command; styled approval page.
- Init asks once, shows a summary, and guards Claude Desktop.
- Ambiguous contacts handled; README landing page; plain-language guide; docs fast lane.
- UX v2 onboarding spec (D-130); MCP tools moved to `packages/mcp-tools`; backlog counts no longer committed.
- Follow-up cards from the owner test.

## Open
- #531 Send folder for existing agents: review PASS, armed for merge once main is green.
- #522 release PR for 0.3.0: stays open until the 0.3.0 scope is merged.
- UI chain drafts (0.3.0): #418, #429, #430, #432, one at a time. #435 is stacked on #418. #423 is old and needs a check.

## Next wave
1. UI chain (0.3.0): #418 → #429 → #430 → #432. Sonnet keepers, Opus delta review, Fable where owner or policy paths change.
2. M1-UX-FIRSTRUN-V2 (S2): one Touch ID sets up the owner, the agent card and a first policy with a real `~/AgentLink/Send` folder. Backup code shown once, with a password-manager save; PRF fallback. Spec: D-130.
3. Cloud agent groundwork for 0.4.0: workerd test projects, then the cloud spec, then the first build (Fable audit). The owner's plan decisions are approved; a few follow-up questions remain open.
4. Release 0.3.0 once the UI chain and first run v2 are merged.

## Owner steps
- Cloudflare test account (owner creates).
- Manual Touch ID tests on Macs; iPhone and Android checks.
- Signed-bundle manual install test (0.2.0) still pending.

## Decisions made (still relevant)
- D-130: UX v2 onboarding (one Touch ID setup, real Send folder).
- Npm `latest` and deploy approvals stay with the owner.

## Asks
- None for @denisjazbec. No new input from Denis.

## Feedback log
- None recorded in this file yet.
