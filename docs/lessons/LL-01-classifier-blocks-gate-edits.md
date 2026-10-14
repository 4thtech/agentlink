# LL-01 · The safety classifier blocks agent edits to merge-gate logic

**Problem.** Under D-51 the S2 approval check had to be removed from `review-gate.yml`.

**Symptom.** The harness safety classifier refused the agent's edit to the approval logic, even though the owner had authorised it in chat.

**Cause.** Edits that weaken a merge gate are treated as high-risk whatever the conversation says. A chat authorisation does not change that, and it should not: a prompt-injected session could produce the same chat.

**Rule.** Edits that relax or remove a gate (a `review-gate` check, a ruleset, an environment reviewer, a deny rule) are made by the owner himself; agents describe the exact change and stop, and never retry by another route ([RB-14](../runbooks/permission-denied.md)). Tightening changes follow the normal sensitive-path flow (Tali's "merge").

**Source.** D-51 rollout; `ci-cd.md` ("The owner removes the former approval check from `review-gate.yml` himself").
