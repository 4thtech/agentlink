# @4thtech-io/local-ui

## 0.0.9

### Patch Changes

- Updated dependencies [b72f9ad]
  - @4thtech-io/ui@0.4.6

## 0.0.8

### Patch Changes

- @4thtech-io/ui@0.4.5

## 0.0.7

### Patch Changes

- c338a75: U3-c: `agentlink ui` becomes the app host (D-138, 08 §1). It serves one agent at a time and switches to another of your agents in the same window, port and session (`POST /api/ui/agents/switch`, a new named route kind `switch` with no owner presence that signs nothing and writes only `~/.agentlink/app.json`). `GET /api/ui/agents` lists every agent on this computer, including ones made by older versions, with its label, contact count, whether an AI app is running it and whether its removal is unfinished. Every answer carries a generation number and the open agent's label; every change the page sends carries the generation and is refused with `agent_changed` when another agent was opened meanwhile, so the page reloads for the agent that is open. Every process that opens an agent now holds a shared lock on its folder. The other U3 routes are registered as stubs answering `not_available` until their cards land.
- 2eb812b: U3-g-b: `agentlink ui` with no agent at all opens the app on Welcome instead of stopping at "isn't set up here yet" (08 §1). The app host can start with no agent open (`AppHostOptions.initial` is optional, `firstRun` new): it then serves only the first-run page and the setup-time reads, and refuses every other route and the approval API with `409 no_agent`. First run's `begin`/`finish {label}` create the first agent (folder `default`, as `init` names it, with the label you typed) and the owner with one gesture, all or nothing, and open that agent in the same window without a restart. Run by an AI, `ui` still prints its fixed line and opens nothing. The successful first-run `finish` answer is marked `X-AgentLink-Generation-Adopted: 1`; the page's generation guard adopts the new generation on that answer only (no reload, so the backup code stays on screen). `GET /api/ui/first-run` answers the real owner state while no agent is open.
- 3307e7d: U3-h: the local app has an agent switcher in the top bar and an Agents page. The switcher shows the open agent, the AI app it works from and whether it is running, and switches to another agent with no Touch ID. The Agents page lists every agent with its AI apps (or "Not connected to an AI app"), its contacts and Switch, Rename, Connect and Remove, plus Add agent. Rename, Add and Remove ask for the owner's presence; their routes arrive with U3-d and U3-e, and until then the sheets say plainly that nothing was changed.
- a591518: U3-map-2: Messages and Files rows show "Sending" or "Receiving" with a small arrow while a message or file is moving for that contact. A word and a direction only: no content and no hover preview.
- b2f3aa0: U3-map: the Agents page has a Map view, "Live connections". Your agents are boxes with their AI app, the open agent's contacts sit on the right in a fixed two-column layout sorted by activity, and a line shows who exchanged something in the last 24 hours. A short dash travels the line while a message or file is moving, and the row says "Sending" or "Receiving". Names and words only: no message content and no hover preview. Clicking a box or line opens that conversation in Messages.
- @4thtech-io/ui@0.4.4

## 0.0.6

### Patch Changes

- 23ae7d8: UX2-d2: Contacts gets an Add contact button and side sheet (b11 §21). Invite someone creates an invite without Touch ID and hands it on through Copy invite, the system share sheet (only where the browser has one) or a QR code; the invite shows only in the sheet and never in an element attribute, the address, the title, a toast or a log. I have an invite checks a pasted invite first and asks "Is this who you expected?" with the name, label and short owner fingerprint before Connect asks for Touch ID. Home's contact step opens the sheet; the shared QR code no longer mirrors its value into `data-value` unless asked (Add credits still does).
- a9c7f57: UX2-e2: Add credits gets a three-step tracker under the QR code and account (B-11 §23): Waiting for your funds (the waiting mark), Arrived · $X with one "Add $X to your credits" button that opens the existing confirm screen and backup code, then Adding to your credits… until the credits read shows the new value, and Added to credits · $X now. Steps move only on the existing top-up and credits reads; a failed read keeps the step ("Couldn't check. Trying again."). Checking runs every 5 s, every 15 s after 2 minutes, stops after 30 minutes with Check again, and pauses while the tab is hidden. Replaces "Waiting for your credits…" after adding credits.
- d179054: UX2-f2: Messages and Contacts rows show a 24-hour pulse and an activity word (b11 §24). The word is Active now (static filled dot), Today (hollow ring) or Quiet (no dot); the pulse is 12 bars from `GET /api/ui/messages/pulse`, one image named "14 messages in the last 24 hours". One ring plays once when a row becomes Active now, never in a loop and never under reduced motion. One read serves the whole list, every 60 seconds while the tab is visible; a failed or partial read leaves a flat pulse and no word. A Sort control (Recent, Most active) is remembered in this browser. Counts and times only: no message text is read or shown.
- b045a4b: UX2-g: Home shows a Start here card (protect approvals, invite your first contact, check the safety code, send your first message, save your recovery kit) in place of the Next step card. Each step ticks only from what the app reads (passkey state, contacts, Sent messages, the kit flag), never from a click; the count is "x of 4" for steps 1, 2, 4 and 5; step 3 is recommended and never holds the card; the card cannot be dismissed and leaves once the four are done. The Home sidebar item carries a dot until then, and the empty states on Contacts, Messages and Files point to step 2. ui: a nav item can carry a dot with its own accessible name.
- befebc4: UX2-h: a compact view of the local app (b11 §25) at /settings/compact, opened as a small window from Home's new Open compact window button. It shows the agent state, how many requests wait with the soonest one and Review, the five most active contacts with their 24-hour pulse and "+n more", credits left and Open AgentLink. It never shows message text and never approves: Review and the other links open the main app. No new server route and no session token in the window's address.
- Updated dependencies [9540e5d]
- Updated dependencies [b045a4b]
  - @4thtech-io/ui@0.4.3

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
