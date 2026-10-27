# UI-REFRESH plan: the B-11 v2 visual refresh of the local app

| | |
|---|---|
| **Status** | Plan. The refresh is **decided** by the owner (Tali, 27 Oct 2026, in chat): build the full refresh from the approved brief [`docs/design/b11-local-app.md`](../../design/b11-local-app.md) (§13 to §16, §18; §19 is already built), and the owner reviews the result on his Mac before it ships. The cards are in `backlog.md` (Local app visual refresh, UI-REFRESH-a to -q). Specs win on conflict: 04 §2.5, 08 §4 (CSP), 11 §5, 11 §11. |
| **Sources** | Brief B-11 §3 to §7, §13 to §16, §18 (D-132); UX-V3 plan §3 (Home with five tiles, one global Under the hood switch, Settings sub-navigation); owner decision 8 of UX-V3 (no motion library) |
| **Release** | The first local-app release after 0.4.0 (number set by the owner; 0.5.0 is the cloud agent) |
| **Date** | 27 Oct 2026 |

## 1. Goal

In the owner's words: a breathtaking, modern, native-feeling Mac app. Depth, smooth transitions everywhere, animated progress for anything slow; a simple surface with an optional "Under the hood"; reduced motion and accessibility throughout. Nothing new for the user to learn: the pages, routes and flows stay; how they look and move changes.

**Not in scope:** new server routes or API fields (a card that needs one stops and asks: `packages/node` is S2), owner-presence or signing logic, the paid-action sheet (§19, built in #584; it only adopts the shared tokens if they change), Profile and Passkeys pages (M1-UX3-SETTINGS), compose in Messages, any new dependency.

## 2. What the code has today (checked 27 Oct, main at 0e048e49)

| Need | Today | Gap |
|---|---|---|
| Motion tokens (§14) | `tokens.css` already has `--al-duration-moment`, `--al-duration-ambient`, `--al-duration-ambient-sweep`, `--al-easing-emphasized` (added by M1-PAY-CONFIRM-b) | Tests that pin them to the brief; a shared reduced-motion switch for the app's own setting |
| Elevation (§13.1) | `--al-shadow-0…4` per theme, `none` in increased contrast and forced colours; `bg-canvas/surface/raised/sunken/overlay` | `--al-highlight-top`; level classes; the hover rise; the contrast border |
| Materials (§13.2) | One `backdrop-filter` (the pay sheet overlay, with a reduced-transparency fallback) | `--al-material-chrome-bg`, `--al-material-blur`; the chrome material; Mac-only default; every solid fallback |
| Progress and state (§15) | `CreditsMeter` (bar), `StatusChip`, the pay sheet's ring and check (private to `pay-confirm.tsx`), `al-spin` | Determinate, stepped and indeterminate bar; ring meter; skeleton; live dot; success moment; error nudge |
| Shell (§3) | `AppShell` (sidebar, status bar, `os` prop), sidebar of eight items, Settings sub-navigation (Backup, Passkeys, Advanced) | Top bar (title, Under the hood, live status, theme); translucent chrome; nav highlight slide; route transition; Home and Appearance items |
| Under the hood (§7) | Only the Messages page has its own panel | One global switch, remembered per browser; one shared panel component |
| Home (§4) | None. `/` is still the old approval page in `packages/node` until M1-11b-2 (S2) | The page, five tiles, Next step card |
| Approvals in the shell | `pages/approvals` is a stub; M1-11b-2 builds it | The refresh pass for it follows M1-11b-2 |
| Screenshots | `tools/docs-screenshots/capture.mjs` (dark, 1280 × 800, fixtures) | Re-capture; light and reduced-motion frames for the owner's QA |

## 3. Build order

Five waves. Inside a wave, cards own disjoint files and run in parallel (one worktree each). Files a card does not list are read-only to it.

| Wave | Cards | What |
|---|---|---|
| **1 · Tokens** | a | Tokens and the scaffold every later card writes into (new stylesheets, export lines, the CSS motion lint). Merges alone, first |
| **2 · Foundation** | b, c, d, e (parallel) | b depth and materials (Surface, Sheet, chrome classes); c progress (bars, ring meter, skeleton); d live state and moments (LiveDot, SuccessMoment, count tick, row enter and leave, motion helpers); e preferences and Under the hood (global switch store, panel component, Appearance page) |
| **3 · Shell** | f | Top bar, translucent sidebar, top bar and status bar on Mac, nav highlight, route transitions, Home and Appearance in the nav and router |
| **4 · Pages** | g, h, i, j, k, l, m, n (parallel); o after M1-11b-2 | g Home; h Activity; i Contacts; j Files; k Messages; l Proofs & credits; m Rules; n Settings pages (Backup, Advanced, own storage, About); o Approvals (S2) |
| **5 · Ship check** | p, q (parallel) | p screenshots and docs; q cross-page performance and accessibility audit plus the owner's visual QA |

Dependencies: a → b, c, d, e → f → g…n; o needs f and M1-11b-2; p and q need g…n (o when it has landed). Card g may start against a mocked API once c and d land; it merges after f.

## 4. Foundation (cards a to e)

**Tokens (a).** Add exactly the approved values (§13, §18 decision 3): `--al-highlight-top` (dark: white at 5 %; light: transparent), `--al-material-chrome-bg` (the surface colour at 72 %; raised if the contrast measurement in card f requires it), `--al-material-blur` (`blur(20px) saturate(1.4)`). In increased contrast and forced colours the material is the solid surface and the highlight is `transparent`. Both copies change together (`docs/design/d1/tokens/` and `packages/ui/src/tokens/`; the token diff test reads both). New stylesheets `depth.css`, `progress.css`, `motion.css`, `hood.css`, `chrome.css` are created empty and exported from `@4thtech-io/ui`, and imported once in `main.tsx`, so wave-2 cards never edit the same file. Stub modules (`surface.tsx`, `progress.tsx`, `motion.tsx`, `hood.tsx`) are exported from `components/index.ts` now.

**Motion lint (a).** A test reads every stylesheet of `packages/ui` and `apps/local-ui` and fails when a `transition` or `@keyframes` animates anything but `opacity`, `transform` or `stroke-dashoffset` (the §6 row 4 height collapse is the one named exception), when a duration is a literal instead of a token, or when an animation has no reduced-motion rule. Every later card is held to it.

**Reduced motion, one switch (a, e).** CSS keys on both `@media (prefers-reduced-motion: reduce)` and `:root[data-motion="reduce"]`; e sets the attribute from Settings › Appearance (Follow system, On, Off). Reduced transparency works the same way with `data-transparency="reduce"`. JavaScript reads one hook, `useReducedMotion()` (d), never `matchMedia` directly.

**Components (b, c, d, e).** Built from the §15.1 catalogue and §5, each with a word, an accessible name and, where it changes, a polite live region; never colour only. The pay sheet's private ring and check move into `motion.tsx` only if card d can do it without changing the sheet's tested behaviour; otherwise they stay and d mirrors them.

| Component | Card | Notes |
|---|---|---|
| `Surface` (levels 0 to 4, recessed; `interactive` rises one level on hover and focus via a pseudo-element's opacity) | b | Contrast and forced colours: 1 px border on every level |
| `Sheet` (side sheet, level 3; full page at 360) and the level-4 dialog frame | b | Focus trap, Escape, focus return; one level-4 layer at a time |
| Chrome material classes (`al-chrome`) with all §13.2 fallbacks | b | Solid by default; translucent only with `:root[data-os="macos"]`, blur support and no reduce-transparency or contrast |
| `ProgressBar` (determinate, stepped, indeterminate), `RingMeter`, `Skeleton` | c | §15.2 timing (`useDelayedShow`: nothing under 400 ms, at least 500 ms once shown) lives here |
| `LiveDot`, `SuccessMoment` (check, stamp, codes merge, file drop), `CountBadge` tick, `useRowPresence` (enter, highlight, leave), error nudge, `useReducedMotion`, `useVisibilityPause` | d | Web Animations API for sequences; at most two moves at once |
| Global Under the hood store, `UnderTheHood` panel (terminal icon, mono, recessed, collapsible, empty text), `Appearance` page (theme, reduce motion, transparency, Under the hood default, live preview tile) | e | The panel accepts only typed, allowlisted fields; never keys, codes, tokens, drop or presigned links, or the session link (§7) |

## 5. Shell (card f)

Top bar (one row): page title left; right the Under the hood switch, the live status chip (LiveDot) and the theme control. Sidebar, top bar, status bar and sticky Settings sub-navigation on the chrome material on Mac (`data-os` set from the browser's platform at start-up; Windows and Linux stay solid, §18 decision 3). Nav highlight slides to the new item (transform only). Route changes use `document.startViewTransition` where it exists (content fades in with a 4 px rise over `--al-duration-fast`), and change instantly elsewhere or with reduced motion; navigation is never delayed. Home and Appearance join the nav and router. **Chrome text contrast** is measured over the worst-case content scrolling under it (the brightest and busiest fixture page) and the chrome opacity raised until it meets WCAG 2.1 AA; the result is written into the PR and, if it changes, into the token in the same PR.

**Home's address (open question 1).** `/` is served by the old approval page in `packages/node` until M1-11b-2. Recommended: Home ships at `/settings/home` (the server already serves `/settings/*`) and becomes `/` when M1-11b-2 lands, with the old path redirecting.

## 6. Pages (cards g to o)

Each page card applies brief §16's row for its page, plus the §4 and §8 states: skeleton on first load (not "Loading…"), live updates without layout jumps, an Under the hood panel per §7 with only the fields listed there, empty and offline states, 1280 and 360. Every card keeps the page's existing tests green and adds DOM tests for each state it touches. No page card edits `packages/ui`; a missing component is reported to the orchestrator and added by a follow-up to b, c, d or e.

Home (g) reads only existing read routes (`/api/ui/health`, `/api/ui/activity`, `/api/ui/proofs/credits`, `/api/ui/contacts`, and the approvals list the old page already serves on the same session), polls with the existing health poller and pauses while the tab is hidden. Tiles per §4; the Next step card per §4; at 360 the tiles stack with Waiting for you first.

## 7. Performance budget

- 60 fps on a five-year-old laptop (the owner's reference: an Intel MacBook from 2021 or earlier, Chrome and Safari).
- Only `opacity`, `transform` and `stroke-dashoffset` animate (lint, card a). No `width`, `height`, `top`, `left`, `margin`, `box-shadow` or `filter` animation; shadows change by cross-fading a pseudo-element.
- `backdrop-filter` on at most four fixed chrome elements (sidebar, top bar, status bar, sticky header) and the overlay; never on a scrolling or repeated element.
- `will-change` only while an animation runs.
- No forced synchronous layout in motion code: read before write, no `offsetHeight` inside a loop; FLIP measurements in one `requestAnimationFrame`.
- At most two things move at once; loops (shimmer, indeterminate, breathing ring) and polling pause while the tab is hidden.
- A route change paints the new page within 100 ms of the click; no motion delays content.
- Bundle: no new dependency; added CSS ≤ 15 KB and added JS ≤ 10 KB, both gzipped (card q measures against 0.4.0).
- Any chrome surface that drops frames on the reference machine falls back to solid (§13.2, last row).

## 8. Fallbacks

| Setting | Result |
|---|---|
| Reduced motion (system or app) | No transforms; fades 120 ms or none; loops become a still state with its word; moments become an instant change plus a text line (§6) |
| Reduced transparency (system or app) | Chrome solid surface; overlay solid |
| Increased contrast, forced colours | Solid chrome with a full-strength border; every level has a 1 px border; rings and checks stay visible as strokes |
| No `backdrop-filter` support | Solid |
| Windows, Linux | Solid by default |
| JavaScript-free first paint | The page renders its final layout; motion is an enhancement |

## 9. Tests (every card, tests first)

Each card commits its failing tests alone first (`RED (expected): UI-REFRESH-<x> …`). Kinds:

- **Token tests:** exact values per brief §13 and §14 in every theme; the two token copies equal; contrast and forced-colours themes give `none` shadows, solid material and a transparent highlight.
- **CSS lint:** the motion lint of card a; no literal durations; no inline styles (08 §4).
- **DOM tests** for every state a component or page shows (start, middle, done, error, empty, offline, loading), with the word and accessible name present and the live region text checked.
- **Reduced-motion tests:** with `data-motion="reduce"` and with the media query, no `Element.animate` call, no transform keyframes, loops replaced by the still state and its word; the same for `data-transparency="reduce"`.
- **Under the hood tests:** off by default; remembered per browser (storage failing still works); no panel renders a forbidden field (fixtures with keys, codes and links never reach the DOM).
- **Accessibility:** axe-core zero WCAG 2.1 AA violations per page in dark, light and increased contrast; keyboard order; no autofocus on any Approve.
- **Vocabulary:** default views pass `lintVocabulary` (11 §5).

## 10. Screenshots and the owner's visual QA (cards p, q)

Card p re-captures the user-guide screenshots with the existing tool and adds a QA set (not published): every page at 1280 and 360, dark, light and increased contrast, with Under the hood off and on, plus reduced-motion stills of §6 rows 1, 2, 3, 7, 8 and 9.

**Owner checklist (on his Mac, from a local build):**

1. Sidebar and top bar are frosted; content scrolling under them shows softly; text on them stays easy to read over the busiest page.
2. With System Settings › Accessibility › Display › Reduce transparency on, they turn solid; with Increase contrast on, every card has a visible edge.
3. Hovering a tile or card lifts it gently; nothing jumps two levels; nothing bounces.
4. Changing pages fades smoothly and never waits.
5. Every slow thing shows progress: a file sending, adding proof, credits arriving, the first load of each page.
6. Approving, recording a proof and matching safety codes each end with one calm "done" moment.
7. Home: five tiles, the right states (fine, approvals waiting, paused, not running, offline).
8. Under the hood: off by default; on shows a marked technical panel per page; never a key, code or link.
9. With Reduce motion on (system or Settings › Appearance), nothing slides or loops and every state still has its word.
10. Scrolling Activity with 200 rows stays smooth.
11. Windows or Linux (if available): solid chrome, same layout.

The owner's go-ahead on this checklist is the release gate for the refresh.

## 11. Risks

- **Translucency hurts legibility** on busy content: measured in f; the opacity token rises if needed.
- **Release timing:** the local app ships inside the npm package, so anything merged before a release cut ships with it (open question 2).
- **Approvals depend on M1-11b-2 (S2):** the refresh pass o waits for it; until then the old approval page keeps its D1 styling.
- **Scope creep:** page cards apply §16 only; new features become new cards.

## 12. Open questions for the owner

1. **Home's address until M1-11b-2:** (a) `/settings/home` now, `/` when M1-11b-2 lands (recommended); (b) wait for M1-11b-2 and ship Home only at `/`.
2. **Merge timing against 0.4.0:** (a) build now; merge the invisible foundation (a to e) any time, and merge the visible cards (f onwards) only after 0.4.0 is published (recommended); (b) hold every refresh merge until 0.4.0 is published; (c) merge as ready and let 0.4.0 ship whatever has landed.
3. **Recording your 27 Oct decision:** (a) log it in the decision log in the next spec PR (build B-11 v2 from the brief; the owner's visual QA replaces the screens-first step of D-116 for this refresh) (recommended); (b) leave it in this plan only.
4. **The reference slow machine for the performance budget:** (a) your oldest available Mac plus Chrome's 4× CPU throttle in CI-style runs (recommended); (b) a named device you choose.
