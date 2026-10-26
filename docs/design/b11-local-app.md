# B-11 · A state-of-the-art local app: Home, live state, motion, under the hood (design brief)

> **Status: brief for the owner (DESIGN-B11, S0). Nothing here is built.** Per D-116 the design in `docs/design/` is the source of truth and new visuals are approved before they are built. The owner takes this brief to Claude Design; builders style only from the approved screens. Specs win on conflict: 04 §2.5 (presence), 08 §4 (CSP), 11 §5 (vocabulary), 11 §11.6 (motion rules), `docs/design/README.md`. The paste-ready block is §11.

## 1. Why, and what the owner asked for

Owner feedback on the 0.3.0 local app (Tali, 2026-10-26): the app is "a little bit clunky" and must be **state of the art**: animations, graphic indicators of states, moving parts, "a pleasure to use". **Abstract the technology**, but let people look "under the hood" if they want. Today the pages show settings (rules, folders, names) but not **what is happening**: who is online, what arrived, what is waiting.

Owner decisions of 2026-10-26 that this brief follows:

1. `/` becomes **Home**, with live tiles: agent, network, approvals waiting, credits, last activity.
2. **One global "Under the hood" switch** (top bar, off by default, remembered per browser).
3. **No new motion library.** CSS and the dependencies we already have. Everything respects `prefers-reduced-motion`.
4. **Passkey first** for every "this needs you" moment; the backup code is a small link, not the main button.
5. **Files** = **Send** and **Received**, with "Show in Finder".
6. **Contacts**: add by invite or QR, a guided safety-code check, a hint for duplicates.
7. **Settings** = Profile, Passkeys, Backup, Appearance, Advanced, About.

**Brand.** `brand/README.md`: dark first, graphite, one signal-orange accent (`#FF6A1A`), Geist and Geist Mono. Orange means "this needs you, or this is the one action"; it is never decoration. Avoid the clichés in 11 §2.9 (glowing nodes and networks, neon gradients, robot faces, sparkles, emoji).

## 2. The feel, in one paragraph

Calm and exact (11 §2.8). The app should feel **alive but quiet**: a small dot pulses once when something changes, a new line slides in and settles, a number ticks, a check draws itself. Nothing loops except progress, nothing bounces, nothing moves unless it tells you something. A person glancing at Home should know in two seconds: is my agent running, is anyone waiting on me, did anything arrive.

## 3. Information architecture

Left navigation (AppShell, D1 style), in this order, with an icon each and a count badge only where something waits:

| Item | Route | Badge |
|---|---|---|
| Home | `/` | none |
| Approvals | `/approvals` | number waiting |
| Activity | `/activity` | dot for unseen "needs you" events |
| Contacts | `/contacts` | number of requests |
| Files | `/files` | number of new received files |
| Proofs & credits | `/proofs` | none |
| Rules | `/rules` | none |
| Settings | `/settings/...` | dot if setup is incomplete |

Top bar (new, one row): the page title on the left; on the right the **Under the hood** switch, the agent's live status chip and the theme control. The status bar at the bottom keeps the short D1 line ("Connected · 48 proofs left"). No page lacks a way back: Approvals is a normal page inside the shell, and a deep link to one approval opens it in the shell with the nav visible.

## 4. Home (new, `/`)

A greeting line ("Good afternoon, Tali", date above in small mono caps) and a grid of **five live tiles**, each a link. Reuse the layout, cards and badges of the D2 console Home (`d2/screens/console/home--approvals-waiting`) and the Windows dashboard (`d2/screens/desktop-windows/dashboard--home`); the tiles themselves are new.

| Tile | Shows | Under the hood adds |
|---|---|---|
| **Agent** | Name, the live dot and word: Running, Paused, Not running, Needs setup. One sentence: "Ready to send and receive." | Agent ID (short form, copy), version, how long it has been running |
| **Network** | "Connected", "Reconnecting…" or "Offline" | Routes up out of total (one small dot per route), time of the last message received |
| **Waiting for you** | Count in large type, the soonest item ("Send a file to Marko · 9 min left"), a **Review** button (orange). Zero: "Nothing is waiting." | nothing |
| **Credits** | "$4.80, about 48 proofs" with the meter. Zero: "Free test credits arrive with your first proof." | nothing |
| **Last activity** | The last three events with time and a small icon | nothing |

Above the grid, **only while setup is incomplete**, one **Next step** card (one at a time, never a checklist wall): "Switch to Touch ID", "Save your recovery kit" or "Connect your first contact", each with one button. When setup is done the card is gone and the grid moves up.

**Home states to design:** first visit with nothing yet (tiles calm, Next step card present) · everything fine · approvals waiting (tile highlighted with an orange edge) · agent paused · agent not running (tiles grey, one instruction: "Start your AI app to bring your agent online") · offline (Network tile warns, the others keep last known values marked "as of 14:02") · loading (skeleton tiles) · error reading ("Couldn't read the latest. Trying again."; tiles keep their old values) · light, dark, increased contrast · 1280 and 360 (tiles stack, Waiting for you first).

## 5. State-indicator vocabulary

One small family, reused everywhere (status bar, tiles, contact rows, file rows). Each state has an **icon shape, a word and a tone**; never colour alone (WCAG 2.1, 1.4.1). It extends `StatusChip`, which keeps its seven tones; no new tones.

**Live dot** (agent and network):

| State | Shape | Word | Tone | Motion |
|---|---|---|---|---|
| Checking | thin hollow ring | "Checking…" | neutral | the ring fills once; after 4 s with no answer it becomes Not running |
| Connected / Running | solid dot | "Connected" | success | one soft pulse ring on arrival, then still |
| Reconnecting | half ring | "Reconnecting…" | warning | the half ring turns slowly (progress, so it may loop; stops on change) |
| Paused | two bars | "Paused" | neutral | none |
| Not running | hollow dot with a slash | "Not running" | warning | none |
| Needs setup | dot with a small mark | "Needs setup" | accent | none |

**Item states** (messages, files, approvals, proofs) use the existing `StatusChip` list: Needs approval (accent), Sent (info), Delivered (success), Received (neutral), Proof recorded (proof), Failed (danger; only for integrity problems or irreversible things). **Progress:** a thin bar when the amount is known (a file sending), a short shimmer segment when it is not. **Counts:** a badge with the number; above 99 it shows "99+". **Time:** relative ("9 min left", "just now"), the exact time on hover and focus.

Design this once as a sheet, extending `d1/screens/local/shared-states--all`, in dark, light and increased contrast.

## 6. Motion specification

Tokens only, no new values: durations `--al-duration-fast` 120 ms, `--al-duration-base` 200 ms, `--al-duration-slow` 320 ms; easings `--al-easing-standard`, `-enter` (arrivals), `-exit` (leaving). Nothing runs longer than 320 ms, except the one-time success moments marked below (up to 480 ms). Only `transform` and `opacity` animate. Technique: CSS transitions and keyframes; the Web Animations API for sequenced moments; the View Transitions API for the route fade, which does nothing where unsupported. **No motion library.**

| # | Moment | What moves | Time and easing | Why |
|---|---|---|---|---|
| 1 | **Status change** (dot and word) | Old state fades out, new fades in; arriving at Connected, one pulse ring grows from 1x to 2.2x and fades | 200 ms standard; pulse 480 ms enter, once | The change is noticed, then the app is still |
| 2 | **Loading** | Skeleton blocks with a slow, low-contrast shimmer replace every "Loading…" (progress, may loop until data arrives) | shimmer 1.4 s linear; content fades in over 120 ms | Shows the final shape; no layout jump |
| 3 | **New row arrives** (Activity, Received, approvals) | Slides down 8 px and fades in; a 1.2 s soft orange highlight fades out; the count badge ticks (old number slides up, new one in) | 200 ms enter; highlight 1200 ms | You see what is new without being startled |
| 4 | **Row leaves** (decided approval, removed contact) | Fades and collapses its height | 200 ms exit | Confirms the action |
| 5 | **Press and toggle** | Buttons scale to 0.98 on press; the Switch knob slides | 120 ms standard | Direct feedback |
| 6 | **Copied** | Icon swaps to a check and the label to "Copied" for 1.6 s, then back; announced politely | swap 120 ms | A tiny proof that it worked |
| 7 | **Approval confirmed** (signature) | The check draws itself (stroke), the card settles 4 px and its edge turns green | 400 ms standard, once | The weighty action gets a calm "done" |
| 8 | **Proof recorded** (signature) | The proof badge "stamps": starts 6% larger and settles, its ring fading in | 320 ms enter, once | 11 §2.8 |
| 9 | **Safety codes match** (signature) | The two code blocks slide together into one check mark | 480 ms standard, once | Shows what the check means: both sides agree |
| 10 | **File received** | The row slides into the Received list, the Files badge ticks, a small file icon drops 6 px into the folder card | 320 ms enter | Shows where the file went |
| 11 | **Route change** | Content fades in with a 4 px rise; the nav highlight slides to the new item | 120 ms standard | Continuity, never a wait |
| 12 | **Waiting for Touch ID** | A calm ring with a slowly breathing opacity (progress; loops until answered, or 60 s); the text "Waiting for Touch ID" and "Cancel" | 2 s ease in-out | The OS prompt is its own and **is never drawn** |
| 13 | **Error** | The field or card edge turns red; one 4 px horizontal nudge (not for presence failures, which only change text) | 120 ms | Draws the eye without drama |

**Never animate:** data a person must read (amounts, safety codes and fingerprints are never revealed letter by letter), more than two things at once, anything on page load that delays the content. No parallax, confetti or sound.

**Reduced motion** (`prefers-reduced-motion: reduce`, and the app's own Settings › Appearance "Reduce motion", which follows the system by default): transforms are removed; fades shorten to 120 ms or none; the pulse and shimmer become a static state with its text label; the signature moments become an instant state change plus a text line ("Approved", "Proof recorded", "Codes match"). Design the **reduced** version of rows 1, 2, 3, 7, 8 and 9 as still frames so nobody has to guess. Honour forced colours (high contrast) too.

**Performance:** smooth on a five-year-old laptop; live polling and the shimmer pause while the tab is hidden.

## 7. "Under the hood" (global switch)

A switch in the top bar, label "Under the hood", default **Off**, remembered per browser. Tooltip: "Show the technical details. Nothing here changes how the app works." When on, each page gains a clearly marked, collapsible panel (a small `terminal` icon, mono type, slightly recessed background, so it is obviously the technical layer); panels animate in over 200 ms.

| Page | Panel content (read-only) |
|---|---|
| Home | Agent ID (short, copy), version, uptime, routes up of total |
| Contacts | Per contact: fingerprint (grouped), identity level, pairing date |
| Files | Real folder paths, drop or own storage, size used |
| Proofs | Record ID, network name, link to the public record |
| Rules | Signed rules version and who signed it |
| Settings › Advanced | Network, own storage, diagnostics |

**Never shown, in any state:** keys, seeds, backup or recovery codes, tokens, presigned or drop links, the session link. The panels cannot change anything. Design: off, on, and an empty panel ("Nothing technical to show here yet.").

## 8. Screens and states to design

"Reuse": **R** reuse the D1 or D2 screen as it is (with the (a) fixes already in `adjustments.md`); **A** adjust an existing screen; **N** new design. Every screen: dark first, then light and increased contrast; 1280 and 360; and the states empty, loading, live, error and offline where they apply.

| # | Screen | Reuse | What to design |
|---|---|---|---|
| 1 | **App shell and top bar** | A (`d1/components/AppShell.md`) | Nav with badges; top bar with the Under the hood switch, agent chip and theme control; the status bar; the Checking to Connected sequence; focus rings; the 360 layout (bottom bar or drawer, designer's choice) |
| 2 | **Home** | N (layout from D2 console home) | §4 in full, all states, skeleton tiles |
| 3 | **Next step card** | N | Three variants (Touch ID, recovery kit, first contact); no dismiss, it goes when done |
| 4 | **Approvals in the shell** | A (`d1/screens/local/approvals--pending`; batch is B-2) | Inside the shell with nav and a way back; nothing waiting ("Nothing is waiting."), one, several |
| 5 | **Presence prompt** (shared) | N (B-3 and B-9 use it) | One component: the "Waiting for Touch ID" ring (motion 12), text, Cancel, and the small link "Use backup code instead" that reveals a field. States: waiting, confirmed, cancelled, failed (generic, tries left), passkeys not supported (backup code only). The OS prompt is never drawn |
| 6 | **Activity, live** | A (`d1/screens/local/activity`) | Day groups; new event types (message sent or received, file sent or received, contact added, credits added); filter chips All, Needs you, Files, Proofs; live insert and highlight (motion 3); empty ("Nothing yet. When your AI sends or receives something, it shows here."); offline |
| 7 | **Contacts list** | A (`d1/screens/local/contacts--with-request`) | Rows with a status dot (online when known), the one-line safety explainer, a "Safety code checked" chip, the duplicate notice; empty state with the two Add contact buttons |
| 8 | **Add contact: create an invite** | N | Presence first (screen 5); then link and QR large, Copy, an expiry countdown, "Only you can see this. Never paste it to your AI." The link is shown on this page only. States: creating, ready, copied, expired (make a new one), accepted (success), offline |
| 9 | **Add contact: I have an invite** | N | Paste; then a card with the inviter's name and owner fingerprint ("Is this who you expected?") with Accept and Cancel. States: pasting, checking, damaged link, expired, already used, added (success), offline |
| 10 | **Call and compare** (guided safety check) | N | 1 "Call or meet {name}", with the one-line why: "A 12-digit code only you and {name} see. If it matches on both screens, nobody is in between."; 2 the code in large groups (`SafetyCode`); 3 "They match" and "They don't"; success (motion 9, chip "Safety code checked"); mismatch: "Don't trust this contact until this is sorted out. Remove them, or ask them for a new invite." with Remove and Keep |
| 11 | **Duplicate-contact notice** | N (a `Banner` variant) | "Looks like a second connection with oc-test (paired 25 Oct). Keep both, or remove the older one?" with Keep both and Remove older (asks for the passkey). Two variants: same owner fingerprint, and same name only (the name then shows the pairing date) |
| 12 | **Files: Send** | A (`d1/screens/local/files--default`) | Top line: "You don't upload here. Put files in your Send folder or ask your AI to send them. Files you receive appear under Received."; folder cards (name, path, Show in Finder, Stop sending); Add folder (the OS picker, typed path as fallback); a **Sent** list (file, to whom, when, status chips, receipt icons); empty ("No folder yet. Add one so your AI can send files from it."); offline |
| 13 | **Files: Received** | N | "Files from your contacts land in ~/AgentLink/Inbox." List with from, when, size, proof badge and **Show in Finder** (no "Open": the app never opens a file for you; a one-time note "Files from others are untrusted. Open them only if you expect them."); the failed-integrity row (existing red row); the arrival moment (motion 10); empty ("Nothing received yet.") |
| 14 | **Proofs & credits** | A (`d1/screens/local/proofs-credits`) | The zero state ("Free test credits arrive with your first proof.") and the credits meter filling over 320 ms |
| 15 | **Rules** | R | Only the corrected nav icon and the presence prompt; B-5 covers the rest |
| 16 | **Settings sub-navigation** | N | Left list (at 360 a list page): Profile, Passkeys, Backup, Appearance, Advanced, About |
| 17 | **Settings › Profile** | N | Agent name with inline edit |
| 18 | **Settings › Passkeys** | N | List (name, this device or another, date added); Add a passkey and Remove (both need presence); the last passkey cannot be removed; "Lost your passkey?" explainer (backup code, then a new passkey). States: none yet, one, several, not supported by this browser |
| 19 | **Settings › Backup** | R (B-3) | Reached from the list; B-3 designs the page |
| 20 | **Settings › Appearance** | N | Theme (System, Dark, Light, High contrast) as `Segmented`; "Reduce motion" (System, On, Off) with a live preview tile; "Show Under the hood by default" |
| 21 | **Settings › Advanced** | A (`d1/screens/local/advanced`; B-4) | Network (picked automatically; named here only), own storage status (B-4), diagnostics |
| 22 | **Settings › About** | N | Mark, version, "by 4thTech" (endorsed lockup), licences, links to docs and support |
| 23 | **Whole-app states** | A (`d1/screens/local/shared-states--all`) | "AgentLink isn't running. Start your AI app, then reload."; session expired; something went wrong with Retry |

## 9. Accessibility and constraints (every screen)

- **WCAG 2.1 AA at least**; contrast per `d1/design-system/contrast.md`; increased-contrast and forced-colours themes.
- **Never colour only**: every state has an icon shape and a word.
- **Keyboard**: every action reachable, visible focus ring, logical order; from Home the Review buttons and the Under the hood switch are within a few tabs. No default button and no autofocus on any Approve (B-2).
- **Live regions** (polite) for counts and new rows ("2 approvals waiting"); assertive only for errors. Moving content never steals focus.
- **Touch targets** at least 44 px at 360.
- **Vocabulary** per 11 §5: no wallet, gas, seed phrase, transaction or network names in the default view; "backup code", never "owner code"; amounts in dollars. Codes and fingerprints appear only where §7 and §8 say so.
- **Tokens only**: colours, spacing, type, radius and motion from `tokens.css` (`--al-*`). Production uses classes, no inline styles (08 §4 CSP).
- **Zero access**: no screen shows keys, seeds, codes, tokens, presigned or drop links.

## 10. Reuse and gaps

**Reuse as is:** Rules (screen 15), Backup (B-3), own storage (B-4), batch approvals (B-2), first run (B-9), the receipt request card (B-1), the tokens, and the components in `d1/components/` (`AppShell`, `Banner`, `Button`, `ContactCard`, `CreditsMeter`, `EmptyState`, `FileCard`, `ProofBadge`, `ReceiptTimeline`, `SafetyCode`, `SecretDisplay`, `Segmented`, `StatusChip`, `Switch`, `TextField`, `Toast`, `UntrustedContent`).

**Adjust:** AppShell and top bar, Approvals in the shell, Activity, Contacts, Files Send, Proofs & credits, Advanced, shared states.

**New design needed:** Home and its tiles, the Next step card, the presence prompt, create-invite and accept-invite, Call and compare, the duplicate notice, Files Received, Settings sub-navigation, Profile, Passkeys, Appearance and About, the state-indicator sheet, and the motion frames with their reduced-motion stills.

**Outputs requested from Claude Design:** (1) the state-indicator sheet (§5); (2) Home, all states; (3) screens 1, 5 to 13, 16 to 18, 20 and 22; (4) motion: a short prototype or annotated frame strips for rows 1, 3, 7, 8, 9, 10 and 12 of §6, each with its reduced-motion still; (5) dark, light and increased contrast for every screen; (6) 1280 and 360.

## 11. Paste-ready block for Claude Design

> **B-11 · A state-of-the-art local app.** **Screens:** Home (new: five live tiles for agent, network, approvals waiting, credits and last activity, plus one "Next step" card while setup is incomplete); the top bar with a global "Under the hood" switch (off by default; shows a clearly marked, read-only technical panel per page); the state-indicator sheet (live dot: checking, connected, reconnecting, paused, not running, needs setup, always icon plus word); Files with Send and Received tabs and "Show in Finder"; Contacts with Add contact (create an invite with link and QR; paste an invite and confirm who it is), a guided "Call and compare" safety-code check and a duplicate-contact notice; the shared presence prompt (passkey first, "Use backup code instead" as a small link); Settings with Profile, Passkeys, Backup, Appearance, Advanced and About. **Motion:** calm and exact; 120, 200 and 320 ms with the existing easing tokens; only transform and opacity; status dot cross-fade with one pulse on arrival, skeleton loading, new rows slide in 8 px and highlight, counts tick, the approval check draws in, the proof stamp settles, two safety codes merge into one check, a received file drops into the Inbox card, a 120 ms route fade; nothing loops except progress; no motion library; design the reduced-motion version of each as a still frame plus a text line. **Why:** the owner wants the app to feel alive, to show what is happening, and to hide the technology unless asked. **Constraints:** brand per `brand/README.md` (dark first, graphite, one signal-orange accent, Geist); tokens only; 11 §5 vocabulary (no wallet, gas, seed phrase, transaction, network names or addresses in the default view; "backup code"; amounts in dollars); the OS passkey prompt is never drawn; the app never opens received files; no keys, codes, tokens or links in under-the-hood panels; WCAG 2.1 AA, never colour alone, focus rings, live regions; production uses classes, no inline styles (CSP). **States:** empty, loading, live, error, offline for every tile and screen; light, dark and increased contrast; 1280 and 360 wide.

## 12. What this brief does not decide

Fixed by the owner: the list in §1. Left to the designer: the nav layout at 360, the tile arrangement, the exact icons (Lucide, ISC, from `brand/icons/ui/`). Left to the owner after seeing the design: whether the AI app keeps opening Approvals directly when something waits (the plan says yes), and the build cards (for example Home, motion, under the hood, Files Send, Add contact, Settings), which are written when the design is approved.
