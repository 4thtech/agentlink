# @4thtech-io/ui

## 0.4.3

### Patch Changes

- 9540e5d: UX2-e1: add the WaitingMark component (the AgentLink mark whose diamond alone turns while waiting for funds; still with reduced motion) and its styles in progress.css.
- b045a4b: UX2-g: Home shows a Start here card (protect approvals, invite your first contact, check the safety code, send your first message, save your recovery kit) in place of the Next step card. Each step ticks only from what the app reads (passkey state, contacts, Sent messages, the kit flag), never from a click; the count is "x of 4" for steps 1, 2, 4 and 5; step 3 is recommended and never holds the card; the card cannot be dismissed and leaves once the four are done. The Home sidebar item carries a dot until then, and the empty states on Contacts, Messages and Files point to step 2. ui: a nav item can carry a dot with its own accessible name.

## 0.4.2

### Patch Changes

- 77282d9: UI-REFRESH-e4: hardening of the Under the hood allowlist. Ids made of several parts are judged by their combined length, the split-value check handles shorter pieces and more separators, the sensitive-label list also covers salt, private, recovery and mnemonic wording, and look-alike spellings of the labels are treated like the plain ones.
- 386887e: UI-REFRESH-e5: further hardening of the Under the hood filter. Split values are now cut on any character outside the allowed piece characters instead of a fixed list of separators, and the table of look-alike letters in labels covers more alphabets and small capitals.
- cca491d: UI-REFRESH-o-b: Approvals follow-ups. Under the hood shows the approval ID (through the shared `id` kind); an approved card collapses out after the check and leaves its result as a line of text; the sidebar Approvals badge uses the shared tick badge (AppShell `NavItem.countLabel`) and counts down when a request is decided. What is approved, the presence steps and the requests sent are unchanged.
- b2d1dcc: UX2-b: the segmented control takes the Under the hood switch's look (recessed track, sliding thumb, check icon on the chosen option, ring on the focused option) and can carry tab semantics and count badges. The Switch can show a quiet note beside it. Messages Inbox/Sent and Files Received/Sent/Send folders are tabs, the Activity filter is a radio group, and Rules shows "Unsaved" beside a buy or sell switch that is not saved yet.

## 0.4.1

### Patch Changes

- 68e25ae: M1-11b-2c: the server-rendered approval page is removed. `/app.js` and `/app.css` are gone (404); Approvals live only in the local app, which the approval server serves on `/` and `/approve/<id>`. A server without the app bundle answers those two with a fixed page (503, no script, no CSRF token) that points to `approve` in the owner's own terminal. The session, CSRF, Origin, fetch-metadata and presence checks and the approval decision logic are unchanged. `@4thtech-io/ui`: a comment in the confirmation sheet no longer points to the removed page.
- 3f6637f: UI-REFRESH-b: depth for the local app. `Surface` (levels 0 to 4 and recessed, `interactive` rises one level through a pseudo-element's opacity), `Sheet` (level-3 side sheet, a full page at 360) and `DialogFrame` (level-4 dialog over the blurred overlay, one at a time), with focus trap, Escape and focus return. New `al-chrome` material: frosted only on macOS with blur support, solid for reduced transparency, increased contrast, forced colours, Windows and Linux.
- a57e7ce: UI-REFRESH-c: progress components. ProgressBar (determinate, stepped, indeterminate), RingMeter (with countdown), Skeleton, InlineError and the useDelayedShow timing hook (nothing under 400 ms, at least 500 ms once shown). Fills move by stroke-dashoffset, loops by transform only, with still states for reduced motion. The proof chip's spinner is removed.
- 231d021: UI-REFRESH-d: live state and moments in `@4thtech-io/ui`. `LiveDot` (six states, each a shape plus a word, one pulse on Connected), `SuccessMoment` (check, proof stamp, codes merge, file drop, always with a text line), `CountBadge` with a tick and "99+", `useRowPresence` (enter with a 1.2 s highlight, leave with a height collapse), `nudge`, `useReducedMotion` and `useVisibilityPause`. Reduced motion (system or `data-motion="reduced"`) means no animation calls.
- 9081ed4: UI-REFRESH-e: one Under the hood switch and panel, and the Appearance settings. The panel (`UnderTheHood`, `HoodProvider`) is read-only and accepts only allowlisted fields: plain details and the public proof record link on a public explorer; keys, codes, tokens, the session link and drop, upload, download and presigned links are refused in code. The local app gets one per-browser preference store (Under the hood, reduce motion, transparency, theme; storage that fails still works) that sets `data-motion`, `data-transparency` and `data-theme`, and an Appearance page with a live preview tile.
- e58cb2b: The switch knob now slides with a transform instead of its position, and the Under the hood panel can show a long local folder path (absolute paths only; links, keys, codes and tokens are still refused).
- 5200b72: UI-REFRESH-e3: the Under the hood panel's allowlist also checks each value and label in its folded (NFKC) and percent-decoded forms, refuses single-slash and slash-less schemes, scheme-less drop and storage hosts, key-shaped values split into pieces, and hidden control, bidi and format characters. Kind `id` is bounded by its own 40-character shape instead of the 24-character run rule, so message IDs (`env_` plus 22 characters) show. `holdInert` moves to an internal module and is no longer exported from the package index; Sheet, DialogFrame and PayConfirmSheet behave as before.
- 50fa253: UI-REFRESH-f-b: the paid-action confirmation sheet (`PayConfirmSheet`) holds the page behind it inert while it is open (no click, Tab or scripted focus reaches it) and releases it on close, unmount and after Done closes itself, before focus returns to the opener. `holdInert` is now exported from `surface.tsx`. Nothing the sheet shows, signs or sends changes.
- 276951a: UI-REFRESH-f: the app shell. A top bar (page title; the Under the hood switch, a live status chip and the theme control), the sidebar, top bar, status bar and Settings sub-navigation on the chrome material on a Mac only (`data-os` is set at start-up; Windows, Linux and reduced transparency stay solid), one sliding nav highlight, a bottom bar at 360 px, route changes through the View Transitions API (instant with reduced motion or where missing), Home (at `/settings/home` for now) and Appearance in the menu and router, and an inert background behind every Sheet and dialog. The chrome material opacity is raised from 72 % to 85 % so the chrome text meets WCAG 2.1 AA over the worst content under it. The old approval page copies the new Home entry in its fixed sidebar list.

## 0.4.0

### Minor Changes

- 7bab3f5: M1-11s-a-d: the local app's health read, `GET /api/ui/health`, answering a fixed shape (agent running, paused, not running or needs setup; relay counts; last sync time; app version), cached for 3 s and bounded, behind the owner's browser session. The app's status bar polls it (with backoff, paused while hidden) and shows Connected, Paused, Not running or Needs setup in a polite live region, instead of "Checking…" forever. `AppShell` gains the `not-running` and `needs-setup` states.

### Patch Changes

- de6a30f: UI-REFRESH-a: design-token foundation for the local app refresh. Elevation highlight and chrome material tokens in every theme, five empty stylesheets and four stub modules for the later cards, one reduced-motion switch (`data-motion="reduced"` and the system setting), and a lint that fails when anything animates other than opacity or transform.
- f2f0a7b: UX-031-QUICKWINS: the Rules navigation icon and five other icons now draw their lines (their line coordinates were missing).

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- 7e67af9: Design tokens as a typed module and `tokens.css` (four themes, `--al-` prefix), with the Geist and Geist Mono woff2 fonts, the OFL licence and the Lucide ISC notice shipped in the package (M1-35a).
- 037cdf4: Review together (brief B-2): the Waiting for you view with the ApprovalCard batch variant, the Approve, Deny and Later choice and the summary button that names exactly what it applies (M1-35b-b).
- c9cf180: The 31 core components of the design as React components with `components.css` (classes only, no inline styles): approvals, commitments, untrusted content, safety codes, secrets, status, files, credits, shell and tray, with the DESIGN-ADJ-1 fixes (M1-35b).
- c2ef824: M1-35c-b: the package root exports the shipped strings (`en`, `t`, `formatMessage`, the `StringKey` type, `pendingStrings`) and `lintVocabulary`, with the shared `NEVER_SAY` list, `isExemptKey` and `LintOptions`, so page code can lint its copy against 11 §5.1.
- 4173573: The shipped English strings with a small message formatter, a vocabulary lint and key-coverage tests; the 11 section 5.6 disclosure lines, rolling-window wording and the corrected owner-presence copy (M1-35c).

### Patch Changes

- a070208: The app shell status bar can show "Checking…" and "Not connected" (M1-11s-a-b).

## 0.1.2

No changes in this release.

## 0.1.1

No changes in this release.

## 0.1.0

No changes in this release.
