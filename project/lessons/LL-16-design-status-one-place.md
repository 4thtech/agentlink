# LL-16 · The design status lives in one place, and session start reads it

**Problem.** UI cards must build from the owner's design once it has landed, and stay functional and unstyled only where no design exists (D-30).

**Symptom.** The owner's Claude Design export (D1 and a first pass of D2: tokens, 31 component specs, 46 screens) was ingested into `docs/design/` on 14 Oct 2026. For a week, sessions treated D2 as "not delivered" and built UI unstyled. On 2026-10-21 the owner noticed: "for some reason we did not know that it existed" (D-116).

**Cause.** Several places carried a design status: the build-plan row ("needs D2"), card dependencies on `DESIGN-D2`, card text ("functional and unstyled until the drop lands"), handoffs and memory. They said "D2 pending" while `docs/design/README.md` already recorded the first pass. No session-start step read that file before UI work was planned.

**Rule.**
- The design status lives only in `docs/design/README.md` (Status table and screen index). Other documents link to it and never restate it.
- Session start (`development-process.md` §13.1, step 5) reads it before planning or briefing UI work.
- A surface with a screen in the index is built styled from it, after the adjustment audit (DESIGN-ADJ-1); only a surface with no screen is built unstyled.

**Source.** Owner, in chat, 2026-10-21; D-116.
