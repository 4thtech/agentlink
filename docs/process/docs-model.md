# Docs model: one way to write every AgentLink page

How every public page is built, so the guide, the technical docs, GitBook and the wiki read as one system (owner request, 2026-10-26). Upkeep and publishing: [`docs-site/MAINTAINING.md`](../../docs-site/MAINTAINING.md). Templates: [`docs-site/_templates/`](../../docs-site/_templates/README.md). Worked example: [Files page](../../docs-site/guide/local-app/files.md).

## 1. Readers and layers

| Space | Reader | Words |
|---|---|---|
| `docs-site/guide` | Anyone using AgentLink through their AI app | [11 §5](../foundation/11-claude-design-brief.md#5-vocabulary-and-microcopy) only |
| `docs-site/technical` | Builders, reviewers, verifiers, contributors | Technical terms, defined on first use; specs win |

Every page has two layers:
1. **Simple first.** The top answers "what is this, and what do I do?" in plain words. A reader who stops there is not misled.
2. **Deeper, clearly marked.** Guide pages end with **For the technically curious** (a collapsible block, §3). Technical pages open with **In short**, two or three sentences a non-developer understands, then the design.

Each guide page links to its technical page, and each technical page links back to the guide page.

## 2. Page types

| Type | Use for | Required outline |
|---|---|---|
| Get started | A first success, start to end | Title · status · what you get · before you start · numbered steps · how you know it worked · next step |
| How-to | One everyday task | Title · status · one-line goal · steps · what you see · if something goes wrong · related |
| Concept | One idea a user needs (guide) | Title · status · the idea in one paragraph · an everyday comparison · what it means for you · for the technically curious |
| Screen guide | One page of the local app | Title · status · what the page is for · screenshot · what you see (table) · tasks (steps) · messages you may see · for the technically curious (UI ↔ tech bridge) |
| Technical concept | One part of the design | Title · status · in short · why it is built this way · how it works (diagram) · guarantees and limits · where it is built (code, spec) · for users |
| Reference | Exact facts: tools, rules, commands, formats | Title · status · one-line scope · tables · examples · source of truth link |
| Troubleshooting | Symptoms | One heading per symptom, in the words the user sees · cause in one line · fix in steps |

The status line follows MAINTAINING §3: one short line, no release history.

## 3. Components (GitBook markdown that also reads on GitHub)

- **Callouts.** GitBook hints, tags on their own lines with a blank line around them. The first words are a bold label, so the meaning survives on GitHub, which shows the tags as plain text. `info` = "Good to know", `success` = "Tip", `warning` = "Before you continue", `danger` = only for secrets and money.

  ```
  {% hint style="warning" %}
  **Before you continue:** type your owner code only on this page. Never give it to your AI.
  {% endhint %}
  ```
- **Collapsible deeper part.** `<details><summary>For the technically curious</summary>` + a blank line + markdown + `</details>`. Both GitBook and GitHub render it.
- **What you see table.** Columns: *What you see* (the exact UI words, in bold) · *What it means* · *What happens behind* (one plain sentence).
- **Steps.** A numbered list, one action per step, UI words in **bold** exactly as on screen, the result in the same step.
- **Diagrams.** Mermaid, `flowchart LR` for flows, `sequenceDiagram` for exchanges, at most 9 boxes. Labels in the page's vocabulary (guide: "Your AI", "AgentLink on your computer", "4thTech", "Public record"). Groups say whose they are ("On your computer (only you)"). No custom colours by default, so light and dark themes both work. For emphasis, one class with stroke `#FF6A1A` (signal orange, [`docs/design`](../design/README.md)); never the 4thTech green. A dashed `-.-x` arrow means "cannot".
- **Screenshots.** See §5.

## 4. The UI ↔ tech bridge

Every screen guide ends with a table inside **For the technically curious**: *On the page* · *What happens* · *Where it is built*. The last column links the spec section, the technical docs page, the API route and the source file on GitHub. Code and route names stay in backticks (the guide vocabulary check skips them). The matching technical page links back to the screen guide.

## 5. Screenshots

**Updated 2026-11-12 (docs overhaul, owner request):** light theme, generated, one shared folder. The full pipeline is in [docs-architecture.md](docs-architecture.md) §3.

- **Real app, generated.** `pnpm docs:screenshots` renders the real app on the journey harness (temp homes, keychain stand-in, in-memory relay, virtual passkey): never a real home, keychain, key, code or person. The two people are **Tali** and **Natasa**.
- **Fixed frame.** 1280 × 800 at device scale 2, light theme, WebP, about 40 to 70 KB each.
- **Names.** `<page-or-moment>.webp`, lowercase with hyphens, for example `accept-invite.webp`. Add a shot by adding one `shot(page, '<name>')` step to the generator.
- **Stored** in `docs-site/assets/screens/`, shared by the README, the guide and the technical docs; embedded as `<figure><img src="../assets/screens/NAME.webp" alt="<what it shows and why>"><figcaption><p><caption></p></figcaption></figure>` (one more `../` per folder level).
- **Alt text** says what the reader should notice, not "screenshot".
- **Placeholder** until captured: `<!-- screenshot: <name> | shows: <state> -->`.
- **Refresh** with `pnpm docs:screenshots` when any string on a shot changes. Every image the guide shows is in `tools/docs-screenshots/manifest.json`; `pnpm docs:screenshots:check` fails on a mismatch ([runbook](../runbooks/docs-screenshots.md)).

## 6. Wording

- Guide words follow [11 §5](../foundation/11-claude-design-brief.md#5-vocabulary-and-microcopy); the vocabulary check (`tools/vocabulary.test.mjs`) enforces it.
- Short sentences. One idea per paragraph. Outcome first, then the next step.
- Say what changes and what does not ("Nothing was changed").
- The first use of a product term on a page links to the [glossary](../../docs-site/guide/help/glossary.md).
- UI words exactly as the app shows them. The source is the page's `strings.ts`, not memory.
- Never claim what is not released, and never overstate privacy or legal weight.

## 7. Links: repo, GitBook, wiki

- **One source:** `docs-site/` on `main`. Never edit in GitBook; GitBook only shows what the wiki repo holds (§8).
- Inside the docs: relative links. To specs or code: absolute `https://github.com/4thtech/agentlink/blob/main/...` URLs. Between the guide and the technical docs, relative links keep working because both folders are copied together (§8).
- **GitHub wiki of this repo:** a short map of a few pages (Home, Guide, Technical docs, Releases and roadmap) that links into GitBook ([wiki.4thtech.io](https://wiki.4thtech.io)) and the repo. Never a copy of a page.

## 8. GitBook: one space, the 4thTech Docs site

**Decided by Tali, 2026-10-26.**

- **One space.** GitBook has a single space, the 4thTech Docs site, Git-synced from the private repo `4thtech/wiki.4thtech.io` (domain `wiki.4thtech.io`). There is no AgentLink-specific space and no Git Sync from this repo.
- **Single source.** AgentLink's docs stay in this repo's `docs-site/`. They are copied into the wiki repo, never written there.
- **Sync model.**
  1. A script in the wiki repo will copy `docs-site/guide` and `docs-site/technical` from the **release tag** of AgentLink (tags only, never `main`) into the AgentLink section of the wiki repo.
  2. **Planned: the script is not built yet.** Today the AgentLink section of 4thTech Docs is a short summary. When it exists, it opens a pull request in the wiki repo; it needs no secrets (public repo read).
  3. A merge there publishes through that repo's Git Sync.
  4. After two releases done by hand with the script, it moves to a GitHub Action in the wiki repo.
- **Brand.** 4thTech is the master brand and AgentLink a sub-brand: "AgentLink by 4thTech". The site header uses the 4thTech logo from 4thTech's original file (never redrawn). AgentLink landing pages show its horizontal lockup; the footer uses the endorsed lockup ([brand rules](../../brand/README.md)). The two marks are never merged; the AgentLink mark is never put inside a hexagon.
- **Cross-links.** The AgentLink landing page says in one line that it builds on earlier 4thTech work and links it; earlier pages carry one line pointing to AgentLink as the current product.
- **Intro GIF** (on the repo README, today a relative path): pinning its URL to the release tag is planned for the 4thTech Docs copy, so a copied page never shows a newer or missing file.
- **Screenshots:** light theme, one set, from `docs-site/assets/screens/` (§5); the wiki sync copies that folder too.
- **OCC v1** (EUPL-1.2 with a non-commercial rider): reference only; link, never copy code.

## 9. Definition of done (every page)

- [ ] The right page type and its outline; status line present.
- [ ] Simple first; the deeper part is marked; the guide ↔ technical links go both ways.
- [ ] UI words match `strings.ts`; facts match the released code and the specs.
- [ ] Vocabulary check green; first product terms link to the glossary.
- [ ] Screenshots captured per §5, or placeholders listed in the PR.
- [ ] Every link resolves; the page is in its `SUMMARY.md` exactly once.
- [ ] Reads acceptably on GitHub (hints, details, figures).

## 10. Ownership and refresh

- MAINTAINING §4 says who fills which page, and when.
- A UI PR that changes a page's `strings.ts` updates that page's screen guide, and its screenshots or their placeholders, in the same PR.
- CI drift check: card DOCS-DRIFT-CHECK (follow-up, not built here).
- Rewrites to this model: DOCS-GUIDE-REWRITE, DOCS-TECH-REWRITE; screenshots: DOCS-SCREENSHOTS.
