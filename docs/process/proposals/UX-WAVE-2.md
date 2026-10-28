# UX-WAVE-2 proposal: the next local-app wave, from the owner's feedback of 28 Oct

| | |
|---|---|
| **Status** | Proposal. Nothing here is decided. The owner (Tali) picks the options in §12; the cards in §10 go into `backlog.md` only after that, in a separate cards PR. |
| **Source** | The owner's feedback on the refreshed local app, 28 Oct 2026, after his visual QA (8 items). The refresh ships as is; this wave adds a "wow" factor and functionality and keeps hiding complexity (UX north star). |
| **Specs that win on conflict** | 04 (I-1…I-10, §2.5 owner presence, §3.6 pairing and invites, §3.6.1 safety code), 06 §2.1 and §7.1 (invites), 07 §3, 08 §1 (local UI hosting), 11 §5 (vocabulary), D-36, D-39, D-40, D-41, D-109, D-116, D-130, D-135, the brand guidelines |
| **Release** | Quick polish: **0.4.2** (§11, group 1). The rest: the next minor releases, and the desktop app in M2 |
| **Date** | 28 Oct 2026 |

## 1. Goal

In the owner's words: "wow" factor plus functionality, to the latest industry standards, with complexity hidden. A newcomer should know the first step (invite someone), see at a glance who their agents are talking to, watch real progress for everything slow, and keep an eye on many agents from a small window.

**Not in scope:** changes to the pairing protocol, the invite format, owner presence or the policy engine. Writing messages from the app (B-11 §18 decision 6 stays: "To reply, ask your AI."). Any new dependency (every card below is built from the platform and `packages/ui`).

## 2. What exists today (checked 28 Oct, main at 4eb54fd6)

| Item | Today | Gap |
|---|---|---|
| 1 Add contact | MCP `agentlink_create_invite` returns `{inviteUrl, shareText, ownerFingerprint, expiresAt}` (06 §2.1); CLI `agentlink invite` (`apps/cli/src/commands/invite.ts`); codec and pairing in `packages/core/src/pairing.ts`. Contacts shows pending invites and the safety code. Home's Next step "Add a contact" links to `/settings/contacts`, whose empty state says "Ask your AI to create an invite" | No `/api/ui/` route creates or accepts an invite, so the app cannot do it itself. The Next step button leads to a page with no button |
| 2 Toggle style | `Switch` (`packages/ui/src/components/forms.tsx`, `role="switch"`, On/Off word) and `SegmentedControl` exist; the global Under the hood switch uses the first | No rule for which control goes where; some view choices are tabs or buttons |
| 3 Funding | Add credits panel (`pages/proofs/top-up.tsx`) with a QR code; the top-up read returns `received` (funds that arrived in the agent's account but are not credits yet), `addable` and `credits`; turning funds into credits is the owner operation `credits.deposit` (04 §2.5.1, D-122, D-123). After a top-up the page polls and shows "Waiting for your credits…" with an indeterminate bar (B-11 §15.3) | No staged Waiting → Arrived → Added view; no branded waiting state. **The brand guidelines forbid rotating the mark** ("Don't: … rotate or stretch"), so the owner's spinning diamond needs a guideline exception (§12 decision 3) |
| 4 Activity per contact | The Messages list returns, per contact, `lastAt` and `lastInAt` only (`pages/messages/api.ts`). The store keeps timestamps in clear for indexing (07 §3) | No counts over time, so no rate. Computing one in the browser would mean paging every conversation: too slow at scale |
| 5 Compact mode, widget | The local UI is a web page served by the CLI/MCP process on `http://localhost:<random port>`, with a session token kept in memory and passed in the opening URL (08 §1, D-79). It lives only while that process runs. The desktop apps (D-36, D-41) are M2 cards M2-11a to M2-11f (framework decision first); D2 already has tray menus (`d2/screens/desktop/tray-menus--all`) and the tray icon status variants (brand guidelines; 11 §2.4, §6.2.2) | No compact layout; no process that stays running without an AI app open; no menu-bar or tray surface |
| 6 Files progress | The Sent tab reads real statuses from the store: `queued` → Waiting to send, `sent` → Sent, `receipt: true` → Delivered, `not_delivered` (`pages/files/io.tsx`, `api/files-io.ts`). Not faked | The list refreshes only on page load and when the tab becomes visible again: **a row does not move while you watch it.** No upload byte count (B-11 §15.3 wanted a determinate fill). Delivered only comes when the recipient allows receipts (D-109), so Sent can be the final state |
| 7 Approvals | One column of cards (`pages/approvals/approvals.css`) | Empty space at 1280 and wider |
| 8 First run, navigation | First run creates the owner and passkey (D-130). Home has one Next step card at a time (brief §4: "never a checklist wall"). M1-37b item 13 (backlog) already lists a "getting-started checklist (deviation note)" | No visible path from first run to the first contact; the Next step for contacts is a dead end (item 1) |

## 3. Item 1: Add contact and invite delivery

**User problem.** People have to know to ask their AI for an invite. The app has no button, and the Home Next step leads to a page without one.

**Pattern.** Slack and Linear "Invite people" sheets; Signal and WhatsApp linked-device and contact QR codes; Apple's share sheet. One primary button, a ready-to-send link, then the platform's own ways to deliver it.

**Recommendation.**
- **Add contact** button on Contacts (top right) and as the Home Next step action. It opens a level-3 side sheet (full page at 360) with two choices:
  - **Invite someone** (default): "Who is it for?" (optional name, stored as the invite `label`) → **Create invite** → the sheet shows the ready-to-send text with three ways to deliver it:
    1. **Copy invite** (primary; copies `shareText`, the fixed template with the link and expiry).
    2. **Share…** through the operating system's share sheet (Web Share API, `navigator.share`; `localhost` is a secure context). Shown only where the browser supports it: Messages, Mail, AirDrop, Slack and others then appear without us integrating any of them.
    3. **Show QR code**, for someone in the same room (reuses the QR renderer in `pages/proofs/qr.tsx`, no new dependency). Their phone opens the invite page, which shows the install-and-accept prompt.
  - **I have an invite**: a paste field → the same accept path as `agentlink_accept_invite`, which still ends in the owner's pairing approval under `contacts.acceptInvites` (04 §3.6 Accept step 2).
- After creation the sheet closes into the existing pending row ("Waiting for {name} to accept", ring meter with days left, B-11 §15.3), then the safety-code step when they answer.
- **The best way to reach the other agent** is still a person-to-person channel the user already trusts. AgentLink has no channel to someone who is not yet a contact, and building one would mean a 4thTech service handling the invite secret. The share sheet makes that channel one click.

**What may be in the link, and where it may go.** The link is `https://<invite-host>/i#<payload>` (04 §3.6). The payload holds the one-time `secret`, `inviteId`, the inviter's signed card, its display name, relay list, `codeCommit` and expiry. **No private key, owner code, session link or storage credential.** The payload sits in the URL fragment, which browsers never send to the invite host.
- **Safe over any private channel to the intended person** (chat, email, text message, in person by QR). It is single use, expires (7 days by default), and a swapped or copied invite is caught by the safety code (04 §3.6.1).
- **Not safe to post publicly** (social posts, group channels, issue trackers): whoever answers first gets the pairing. The sheet says so in one line: "Send it only to {name}. Anyone with this link can connect once."
- **Never** through a 4thTech service: no link shortener, no "email it for me", no relay delivery, no analytics on the link. The secret never appears in a URL of the local app, the page title, a notification, a toast, Activity, logs or an error. It is shown only in the sheet's DOM, and the "Copy" action is the only way out.

**Spec and security impact.**
- New local API routes `POST /api/ui/invites` (create) and `POST /api/ui/invites/accept` in `packages/node`: **S2** (pairing protocol; inbound invite parsing through the one D-69 codec; the relay URL SSRF rules of 04 §4).
- Owner presence: creating an invite through the MCP tool needs none today, so the route needs none either (parity; a shell-capable agent can already do it). It keeps the session, CSRF, Origin and fetch-metadata gate of the other write routes. Accepting already leads to the owner's approval. Recorded as §12 decision 1.
- The `label` the owner types here is owner-typed, but 06 §2.1 rule 1 treats only owner-set or owner-confirmed text as an alias; it stays a suggested alias until the pairing approval confirms it (no rule change).
- Spec edits (proposed, owner confirms at merge): 08 §1 (two routes), 06 §7.1 (the app as a second way to create invites), 11 §6.1 (sheet copy).

## 4. Item 2: The toggle style where it fits

**User problem.** The owner likes the Under the hood switch and wants that feel elsewhere.

**Pattern.** Apple HIG and Material: a **switch** only for an on/off setting that takes effect at once; a **segmented control** (the same pill track and sliding thumb) for choosing between two to four views; a **button** for an action. Putting a switch on an action ("Approve") would mislead and break screen-reader expectations.

**Recommendation.** One control map, applied page by page:
- Switches: Rules on/off settings, Appearance choices that are binary, notification and receipt settings.
- Segmented control in the switch's visual language: Approvals Grid/List (item 7), Messages Inbox/Sent, Files Received/Sent/Send folders, the Activity filter, Proofs/Credits views.
- Buttons stay buttons: Approve, Add contact, Add credits, Copy.

**Spec and security impact.** None beyond 11 §5 words. Saving Rules still goes through the owner-presence prompt; a switch there shows "Unsaved" until saved, never a state that is not in force.

## 5. Item 3: Waiting for funds, with the AgentLink mark

**User problem.** After sending funds, people stare at a static page and wonder whether it worked.

**Pattern.** Wise's transfer tracker and Revolut's and Stripe's payout timelines: named steps with timestamps, the current step animated, an honest "usually takes about a minute", and the amount shown as arrived only when it has.

**Recommendation.** A three-step tracker inside Add credits:
1. **Waiting for your funds** — the mark with the diamond turning slowly (the owner's idea), "Usually takes about a minute." After 10 minutes: "Still waiting. Check that you sent it to this account." with **Show details again** (QR and account).
2. **Arrived · $5.00** — shown only when the top-up read returns `received` above what it was when the panel opened. The diamond stops, a check draws, and one button **Add to credits** follows (owner presence, `credits.deposit`).
3. **Added to credits** — after the owner operation succeeds and `/api/ui/proofs/credits` shows the new value; the ring meter fills (B-11 §15.3).

**Never implying funds arrived early.** Each step is driven only by a server read: step 2 by `received`, step 3 by the credits read after the owner operation succeeded. No timer advances a step, and no amount is shown before the read that proves it. If the read fails, the tracker stays on its current step with "Couldn't check. Trying again." On reduced motion the diamond is still and the step word carries the meaning.

**Spec and security impact.** No new route: `received`, `addable` and `credits` already exist; the panel polls the existing top-up read while it is open and the tab is visible (capped, as Proofs does today). Words follow the lint: "funds", "account", "credits"; never wallet, deposit, transaction, network names or address in the default view. **Brand:** the guidelines forbid rotating the mark. Proposed exception for a brief §23 to define: only the diamond turns, about its own centre, in the waiting state only, at the ambient duration; the brackets never move; not used for any other loading state. §12 decision 3.

## 6. Item 4: Activity at a glance per contact

**User problem.** With many contacts, people cannot see who is busy without opening each conversation.

**Pattern.** Slack and Discord presence dots for "now"; GitHub's contribution graph and Linear's project pulse for "how much lately"; Datadog-style sparklines for many rows at once.

**Recommendation.** In the Messages list (and the Contacts list):
- A **pulse**: a small 24-hour sparkline of 12 two-hour bars, messages in and out combined, with an accessible summary ("14 messages in the last 24 hours").
- An **activity word with a shaped marker**: **Active now** (exchange in the last 5 minutes; filled dot with a slow heartbeat), **Today** (hollow dot), **Quiet** (no dot). Never colour only; the heartbeat stops with reduced motion.
- Sort option "Most active" next to "Recent". The detail (messages, times) stays one click deeper.
- We say "Active now", not "Online": AgentLink knows only when messages moved, not whether the other agent is running.

**Spec and security impact.** New read route `GET /api/ui/messages/pulse` in `packages/node` (**S2** by path; read-only): per contact, counts per two-hour bucket for 24 hours and the last exchange time. Counts and times only: no text, file names or sizes. These are columns the store already keeps in clear (07 §3), the data stays on this computer, and nothing new goes to 4thTech. Spec edit: 08 §1 (proposed, owner confirms at merge).

## 7. Item 5: Compact mode and a menu-bar widget

**User problem.** People running many agents want a small, always-visible view of activity and anything waiting, and the full app only when needed.

**Pattern.** Raycast and Arc's small windows; Linear's compact density; Apple HIG menu-bar extras (a template icon whose shape shows the state, a popover with the few things that matter, everything else one click away in the main window); Slack's status bar.

**What the compact view shows** (the same content as the widget): live status word and dot; **Waiting for you** count with the soonest item and **Review**; the top five contacts by activity with their pulse (item 4), the rest as "+12 more"; credits left; **Open AgentLink**. At scale it lists "Needs you" first, then by activity, and never more than one screen.

**Where it runs: options.**

| Option | What it is | Can it be a widget? | Cost and risk |
|---|---|---|---|
| **A. Compact view in today's web app** | A `/compact` route with a dense layout; "Open compact window" opens it as a small browser window from a click | No: lives only while the CLI/MCP process runs, no menu-bar icon, no always-on-top | **S** to **M**, S1. No new process, no new trust surface |
| B. Installable web app (PWA) | Install the local page as an app | No | Blocked: the port is random and the session token lives in memory and in the opening URL (08 §1, D-79), so the origin changes each run and the token cannot be stored. Fixing that weakens the local security model. **Not recommended** |
| **C. Desktop app with a tray / menu-bar popover** | The signed native app of D-36 and D-41 (M2-11a to f; e.g. Tauri with a Node sidecar). It hosts the MCP server and keeps running in the menu bar | **Yes**: the popover is the widget; the compact view becomes its main window's small size | **L** to **XL**, S2: framework decision, signing and notarization, auto-update. Already planned for M2; the D2 tray menus exist |
| D. Claude Desktop extension | Packages the MCP server for one AI app | No: it has no window or menu-bar surface of its own | Already carded as an optional bundle; does not solve this |
| E. Small native helper reading the local API | A separate menu-bar process | Yes, but it needs the session token on disk or a new auth path | Breaks 08 §1 (token never written to disk). **Rejected** |

**Recommendation.** Build **A now**, designed as the exact content of the future popover, so nothing is designed twice. Build the **widget as part of C** by adding a "menu-bar popover" scope to M2-11b (macOS) and M2-11c/d (Windows, Linux), and ask the owner whether to pull the M2-11a framework decision forward (§12 decision 5). The popover shows only counts, names under the contact-name rule and pulses, never message text (B-11 §17.4).

**Spec and security impact.** A: none beyond 08 §1 (one route, same session). C: the M2-11a threat model (G-1, G-42) and 04 §2.5 (desktop owner presence) apply; the popover never approves on its own; Review opens the native approval window. No wallet words anywhere (D-39); no chain picker (D-40).

## 8. Item 6: Files progress that follows the real delivery

**User problem.** The Waiting → Sent → Delivered steps are liked, but they must move when the real thing happens.

**Finding.** The steps already come from real stored statuses, not a timer. They do not refresh while the page is open, so a row only moves after a reload or a tab switch.

**Recommendation.**
- While any row is `queued`, or `sent` without a receipt and still available, re-read the first page every 5 seconds while the tab is visible, with backoff after 2 minutes and a stop after 30 minutes (the pattern Proofs uses).
- A row that moves plays the existing step transition once; with reduced motion the word changes.
- When the recipient does not send receipts (D-109), the row ends at **Sent** with "Delivery receipts are off for {name}", instead of waiting for Delivered forever. This needs a "receipts expected" flag; if the API does not have it, the row says "Sent · no receipt yet" after a day (§12 decision 6).
- A determinate upload fill (bytes sent) would need upload progress from the core: a new S2 route. Not recommended now: files are small and the step change is the information people want.

**Spec and security impact.** Polling only, S1, no new route (unless decision 6 picks the flag: a field on the existing Sent read, S2 by path).

## 9. Items 7 and 8: Approvals grid, and a clear first step

### 9.1 Approvals (item 7)

**Pattern.** Responsive card grids (Linear and Trello boards, Apple Mail's layouts) with a Grid/List switch remembered per browser, as Finder and Notion offer.

**Recommendation.** CSS grid with `repeat(auto-fill, minmax(360px, 1fr))`: one column at 360, two at 1024, three at 1440 and wider; a Grid/List segmented control (item 2) in the page header, remembered per browser (storage failing still works). Keyboard order runs row by row; the card being decided still rises one level; no autofocus on any Approve; at most one presence prompt at a time.

**Spec and security impact.** S1 (approval UI). No data change.

### 9.2 First run and navigation (item 8)

**Pattern.** Product onboarding checklists (Stripe's dashboard "Get started", Linear, Notion): three to five steps, ticked automatically from real state, progress shown ("2 of 4"), one highlighted next action, dismissible, gone when done.

**Recommendation.** A **Start here** card at the top of Home while setup is incomplete:
1. Protect approvals (passkey) — done after first run.
2. **Invite your first contact** — the Add contact sheet (item 1).
3. Check the safety code with them.
4. Send your first message — "Ask your AI to say hello to {name}." with a copyable prompt.

Optional fifth: Save your recovery kit. Each step ticks itself from existing reads (health, contacts, backup state, messages). One primary button only, on the next step, so it is a short list rather than a "checklist wall". The Home nav item carries a dot until it is done; empty states on Contacts, Messages and Files point to step 2. The navigation order stays (Home first).

**Spec and security impact.** S1. It changes brief §4's "one Next step card, never a checklist" rule (§12 decision 7). It supersedes M1-37b item 13 (the getting-started checklist); the cards PR marks that item as moved here.

## 10. Cards (proposed)

Class per `audit-rules.md` §2 (paths: `packages/node` S2; `apps/local-ui`, `packages/ui` S1; `docs/design` S0). Sizes: S up to a day, M two to three days, L a week or more.

| Card | What | Class | Depends on | Size | Brief first? |
|---|---|---|---|---|---|
| **UX2-a** | Approvals responsive grid and Grid/List control | S1 | — | S | Short note, b11 §26; the owner approves from PR screenshots |
| **UX2-b** | Control map: switches for settings, segmented controls for views (item 2) | S1 | — | S | Short note, b11 §22 |
| **UX2-c** | Files Sent: live re-read while rows are in flight; Sent as a final state where receipts are off | S1 | — (S2 split if decision 6 (b)) | S | No (existing components) |
| **UX2-d1** | Local API: create and accept invite routes | S2 | — | M | No |
| **UX2-d2** | Add contact sheet: create, copy, share sheet, QR, paste an invite | S1 | UX2-d1, b11 §21 | M | Yes, §21 |
| **UX2-e1** | Brand exception and the waiting mark component | S1 | b11 §23, decision 3 | S | Yes, §23 |
| **UX2-e2** | Add credits three-step tracker | S1 | UX2-e1 | M | Yes, §23 |
| **UX2-f1** | Local API: per-contact pulse (counts per two hours, last exchange) | S2 | — | M | No |
| **UX2-f2** | Pulse and activity word in Messages and Contacts; "Most active" sort | S1 | UX2-f1, b11 §24 | M | Yes, §24 |
| **UX2-g** | Start here card on Home; empty states point to it | S1 | UX2-d2, b11 §27, decision 7 | M | Yes, §27 |
| **UX2-h** | Compact view (`/compact`) and "Open compact window" | S1 | UX2-f1, b11 §25 | M | Yes, §25 |
| **UX2-i** | Menu-bar / tray popover: added to M2-11b, M2-11c, M2-11d | S2 | M2-11a, UX2-h | L | Yes, §25.2 |
| **UX2-brief** | b11 §21 to §27 (below), for the owner's approval | S0 | decisions in §12 | M | It is the brief |

**Brief sections to add to b11 (per D-116 and D-135; no final visuals invented here):**
- §21 Add contact sheet: both choices, the share options, the "send it only to {name}" line, pending row hand-off; 1280 and 360.
- §22 Control map: switch vs segmented control vs button, with states and focus.
- §23 Waiting for funds: the three steps, the diamond's motion (centre, speed, reduced-motion still), the 10-minute message, and the brand guideline exception text.
- §24 Activity pulse: sparkline size and scale, the three activity words and marker shapes, the heartbeat, at 50+ contacts.
- §25 Compact view and §25.2 menu-bar popover: content order, sizes, states (fine, waiting, paused, offline), many-agent overflow.
- §26 Approvals grid: breakpoints and the Grid/List control.
- §27 Start here: steps, ticking, dismiss, the Home dot.

## 11. Ordering

| Group | Cards | Why |
|---|---|---|
| **1 · 0.4.2 polish** | UX2-a, UX2-b, UX2-c | Small, S1, built from existing components, no new route; the owner checks them from screenshots |
| **2 · Next minor: first step and funding** | UX2-brief (§21, §23, §27 first), UX2-d1 → UX2-d2 → UX2-g, UX2-e1 → UX2-e2 | Closes the newcomer's biggest gap (item 1 plus item 8) and the funding moment |
| **3 · Activity and compact** | UX2-brief (§24, §25), UX2-f1 → UX2-f2 → UX2-h | One data route serves the pulse, the compact view and later the widget |
| **4 · Desktop (M2)** | UX2-i inside M2-11 | Needs the M2-11a framework decision |

S2 cards (d1, f1) run in parallel with their briefs. Each follows tests first, an independent review, and Tali's "merge".

## 12. Owner decisions

Recommended option first in each.

1. **Creating an invite from the app**
   1. Session gate only, like the MCP tool (recommended): one click, nothing new for an agent that already has the tool.
   2. Ask for Touch ID to create an invite.
2. **Invite delivery options in the sheet**
   1. Copy, Share… (system share sheet) and QR code (recommended).
   2. Copy only.
   3. Also an email button that opens the user's own mail app (`mailto:`), in addition to option 1.
3. **The spinning diamond (brand rule "don't rotate")**
   1. Allow one exception: only the diamond turns, only while waiting for funds; written into the brand guidelines (recommended).
   2. The diamond pulses (fades in and out) instead of turning; no guideline change.
   3. No branded animation; keep the indeterminate bar.
4. **Activity marker**
   1. 24-hour pulse plus Active now / Today / Quiet (recommended).
   2. Activity word and dot only, no sparkline.
5. **Compact mode and the widget**
   1. Compact view in the web app now; the widget in the desktop app, and pull the M2-11a framework decision forward to start now (recommended).
   2. Compact view now; the widget waits for M2 as planned.
   3. Start the desktop app shell (M2-11a and b) now, before the compact view.
6. **Files when the recipient sends no receipts**
   1. Show "Sent · no receipt yet" after a day, with no API change (recommended for 0.4.2).
   2. Add a "receipts expected" field to the Sent read (S2), so the row says at once that receipts are off.
7. **Start here on Home**
   1. A short checklist with progress and one highlighted next step, replacing brief §4's single Next step card (recommended).
   2. Keep the single Next step card and add Add contact to it.
8. **0.4.2 scope**
   1. UX2-a, b and c only (recommended).
   2. Also UX2-d (Add contact) once its S2 route has passed review.

## 13. Risks

- **Invite misuse:** a link posted publicly is answered by a stranger. Mitigated by the sheet line, single use, expiry and the safety code; never by sending the link through us.
- **Funding states that lie:** prevented by server-driven steps only; tests check that no step advances on a timer or before a read proves it.
- **Pulse at scale:** one aggregated read, not N conversation reads; the route caps contacts and the time window.
- **Widget scope creep into M2:** the popover is defined by §25.2 and reuses the compact view; no new data.
- **Brand drift:** the diamond exception is written down once and used in one place.
