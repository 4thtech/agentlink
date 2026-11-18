# LL-02 · PR titles must start with a task ID or an allowed prefix

**Problem.** A decision-log PR was titled after its decision, starting with "D-5x:".

**Symptom.** `pr-hygiene` failed: "Title must start with a task ID".

**Cause.** The title regex in `pr-hygiene.yml` accepts `M<n>-<n>[a-z]`, `M<n>-GATE`, `OPS-<n>`, `OPS-L<n>`, `DESIGN-D<n>`, `DOCS`, `CHORE` and `DEPS`. A decision ID such as `D-52` is not a task ID.

**Rule.** Prefix documentation PRs with `DOCS `, for example `DOCS D-52 delivery pipeline`. Fix a title with `gh pr edit <n> --title "…"`.

**Source.** PR #3 and earlier decision-log PRs; `.github/workflows/pr-hygiene.yml`.
