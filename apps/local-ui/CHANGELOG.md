# @4thtech-io/local-ui

## 0.0.5

### Patch Changes

- cca491d: UI-REFRESH-o-b: Approvals follow-ups. Under the hood shows the approval ID (through the shared `id` kind); an approved card collapses out after the check and leaves its result as a line of text; the sidebar Approvals badge uses the shared tick badge (AppShell `NavItem.countLabel`) and counts down when a request is decided. What is approved, the presence steps and the requests sent are unchanged.
- c473e2f: UI-REFRESH-o-c: an applied denial now leaves the Approvals list the same way an approval does: the card holds "Denied." and every fact, collapses out with the shared row leave (reduced motion: removed at once) and leaves "Denied: <summary>" as text. A refused, expired or failed attempt and an open sheet keep the card. Presence, the decide calls and what is shown before deciding are unchanged.
- 75dd806: UX2-a: Approvals cards sit in a responsive grid (one column at 360, two at 1024, three at 1440) by default, with a "Layout" Grid/List control in the title row, hidden while only one column fits and remembered per browser in the prefs store. DOM order is the visual order; nothing autofocuses Approve; facts, Approve/Deny order, presence, the decide calls and the leave after a decision are unchanged. What the AI wrote now wraps instead of being cut off on a long line.
- b2d1dcc: UX2-b: the segmented control takes the Under the hood switch's look (recessed track, sliding thumb, check icon on the chosen option, ring on the focused option) and can carry tab semantics and count badges. The Switch can show a quiet note beside it. Messages Inbox/Sent and Files Received/Sent/Send folders are tabs, the Activity filter is a radio group, and Rules shows "Unsaved" beside a buy or sell switch that is not saved yet.
- Updated dependencies [77282d9]
- Updated dependencies [386887e]
- Updated dependencies [cca491d]
- Updated dependencies [b2d1dcc]
  - @4thtech-io/ui@0.4.2

## 0.0.4

### Patch Changes

- 9081ed4: UI-REFRESH-e: one Under the hood switch and panel, and the Appearance settings. The panel (`UnderTheHood`, `HoodProvider`) is read-only and accepts only allowlisted fields: plain details and the public proof record link on a public explorer; keys, codes, tokens, the session link and drop, upload, download and presigned links are refused in code. The local app gets one per-browser preference store (Under the hood, reduce motion, transparency, theme; storage that fails still works) that sets `data-motion`, `data-transparency` and `data-theme`, and an Appearance page with a live preview tile.
- 276951a: UI-REFRESH-f: the app shell. A top bar (page title; the Under the hood switch, a live status chip and the theme control), the sidebar, top bar, status bar and Settings sub-navigation on the chrome material on a Mac only (`data-os` is set at start-up; Windows, Linux and reduced transparency stay solid), one sliding nav highlight, a bottom bar at 360 px, route changes through the View Transitions API (instant with reduced motion or where missing), Home (at `/settings/home` for now) and Appearance in the menu and router, and an inert background behind every Sheet and dialog. The chrome material opacity is raised from 72 % to 85 % so the chrome text meets WCAG 2.1 AA over the worst content under it. The old approval page copies the new Home entry in its fixed sidebar list.
- d811dc6: UI-REFRESH-h: the Activity page. Events sit under sticky day headers, filter chips (All, Approvals, Proofs, Blocks and rules) swap the list without moving the chips, a live dot shows the list is live, new events are added at the top every 20 s (at most two enter with the highlight), the first load shows a skeleton, and a failed refresh keeps the rows and says when they were last up to date.
- 6cdf77b: UI-REFRESH-i: the Contacts page is refreshed. The list sits on a raised card, a contact opens in a side sheet (a full page on a narrow window), the waiting invite line breathes (still with reduced motion), a short codes-match moment plays after the safety-code check, the second-connection notice is a raised banner, and the optional Under the hood view shows the fingerprint, identity level and pairing date.
- 4141531: UI-REFRESH-k: the Messages page on level 1 surfaces, with the shared skeleton, entering contact rows (message text never moves) and the shared Under the hood panel (message ID, size, proof status).
- d5379a6: UI-REFRESH-l: Proofs & credits page refresh (credits ring on a raised card, skeletons, proof success moment, waiting line, Under the hood panel).
- 52a39f1: UI-REFRESH-o: the Approvals page on level 1 cards (the card being decided rises to level 2), a time-left ring per card, the approved check and a faded denied card, the shared skeleton and Under the hood (kind, exact expiry). Visual only: what is approved, the presence steps and the requests sent are unchanged.
- Updated dependencies [68e25ae]
- Updated dependencies [3f6637f]
- Updated dependencies [a57e7ce]
- Updated dependencies [231d021]
- Updated dependencies [9081ed4]
- Updated dependencies [e58cb2b]
- Updated dependencies [5200b72]
- Updated dependencies [50fa253]
- Updated dependencies [276951a]
  - @4thtech-io/ui@0.4.1

## 0.0.3

### Patch Changes

- de6a30f: UI-REFRESH-a: design-token foundation for the local app refresh. Elevation highlight and chrome material tokens in every theme, five empty stylesheets and four stub modules for the later cards, one reduced-motion switch (`data-motion="reduced"` and the system setting), and a lint that fails when anything animates other than opacity or transform.
- Updated dependencies [7bab3f5]
- Updated dependencies [de6a30f]
- Updated dependencies [f2f0a7b]
  - @4thtech-io/ui@0.4.0

## 0.0.2

### Patch Changes

- @4thtech-io/ui@0.3.0

## 0.0.1

### Patch Changes

- Updated dependencies [a070208]
- Updated dependencies [7e67af9]
- Updated dependencies [037cdf4]
- Updated dependencies [c9cf180]
- Updated dependencies [c2ef824]
- Updated dependencies [4173573]
  - @4thtech-io/ui@0.2.0
