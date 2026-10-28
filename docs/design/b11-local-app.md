# B-11 · A state-of-the-art local app: Home, live state, motion, under the hood (design brief)

> **Status: brief for the owner (DESIGN-B11, S0; amended by DESIGN-B11-v2 on 2026-10-27 with §13 to §18, and by MONEY-CONFIRM-DESIGN on 2026-10-27 with §19 and §20; UX2-brief-0 on 2026-10-28 adds §22 and §26 in Part 4, and UX2-brief on 2026-10-28 adds §21, §23, §24, §25 and §27 there, all approved by the owner in chat on 2026-10-28, recorded as D-137, which extends D-135 (3) (c) to UX wave 2 so §21 to §27 are built from this brief with PR screenshots; 'pending owner' no longer applies to §21 to §27). Nothing here is built.** **U3-brief (2026-10-29) amends §27 and adds §28 to §32 for usability wave 3, from the owner's decisions of 2026-10-29 (all as recommended); the owner approves those screens by screenshot review in the build PRs (D-137).** Per D-116 the design in `docs/design/` is the source of truth and new visuals are approved before they are built. The owner takes this brief to Claude Design; builders style only from the approved screens. Specs win on conflict: 04 §2.5 (presence), 08 §4 (CSP), 11 §5 (vocabulary), 11 §11.6 (motion rules), `docs/design/README.md`. The paste-ready block is §11. **v2 (2026-10-27)** adds depth and materials (§13), motion tokens (§14), progress and state components (§15), per-screen notes (§16), Messages and Files In/Out (§17) and the owner decisions this raised (§18), **all decided by the owner on 2026-10-27 as recommended (D-132)**. **Paying for proof and registration (2026-10-27)** adds §19 (one confirmation sheet for the two paid actions, confirmed with Touch ID, Windows Hello or a passkey; a calm credits line; a receipt row per paid action) and §20 (owner decisions it raises).

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

**Owner direction of 2026-10-27 (Tali):** the app must look and feel **breathtaking**: a modern, native-feeling Mac app. **Depth** (layering, soft shadows, translucency, elevation), **smooth transitions everywhere**, and **anything that takes time is animated**: progress bars, meters, live state indicators, skeletons, success moments. All of it with reduced-motion support and full accessibility (contrast, focus, screen-reader labels). Simple on the surface, with the optional "Under the hood" view. He also proposed a new feature: people can see what their AI sent and received (**Messages**, and **Files** in and out); §17 sketches it for his decision. "Calm and exact" (§2) still holds: breathtaking here means depth, polish and smoothness, not more things moving.

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

The motion tokens, their reconciliation with 11 §11 and the proposed additions are in §14; the progress components in §15. Tokens only, plus the additions §18 approved (D-132): durations `--al-duration-fast` 120 ms, `--al-duration-base` 200 ms, `--al-duration-slow` 320 ms; easings `--al-easing-standard`, `-enter` (arrivals), `-exit` (leaving). Nothing runs longer than 320 ms, except the one-time success moments marked below (up to 480 ms). Only `transform` and `opacity` animate. Technique: CSS transitions and keyframes; the Web Animations API for sequenced moments; the View Transitions API for the route fade, which does nothing where unsupported. **No motion library.**

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

**Outputs requested from Claude Design:** (0) the elevation and material sheet (§13) and the progress and state component sheet (§15); (1) the state-indicator sheet (§5); (2) Home, all states; (3) screens 1, 5 to 13, 16 to 18, 20 and 22; (4) motion: a short prototype or annotated frame strips for rows 1, 3, 7, 8, 9, 10 and 12 of §6, each with its reduced-motion still; (5) dark, light and increased contrast for every screen; (6) 1280 and 360.

## 11. Paste-ready block for Claude Design

> **B-11 · A state-of-the-art local app.** **Screens:** Home (new: five live tiles for agent, network, approvals waiting, credits and last activity, plus one "Next step" card while setup is incomplete); the top bar with a global "Under the hood" switch (off by default; shows a clearly marked, read-only technical panel per page); the state-indicator sheet (live dot: checking, connected, reconnecting, paused, not running, needs setup, always icon plus word); Files with Send and Received tabs and "Show in Finder"; Contacts with Add contact (create an invite with link and QR; paste an invite and confirm who it is), a guided "Call and compare" safety-code check and a duplicate-contact notice; the shared presence prompt (passkey first, "Use backup code instead" as a small link); Settings with Profile, Passkeys, Backup, Appearance, Advanced and About. **Motion:** calm and exact; 120, 200 and 320 ms with the existing easing tokens; only transform and opacity; status dot cross-fade with one pulse on arrival, skeleton loading, new rows slide in 8 px and highlight, counts tick, the approval check draws in, the proof stamp settles, two safety codes merge into one check, a received file drops into the Inbox card, a 120 ms route fade; nothing loops except progress; no motion library; design the reduced-motion version of each as a still frame plus a text line. **Why:** the owner wants the app to feel alive, to show what is happening, and to hide the technology unless asked. **Constraints:** brand per `brand/README.md` (dark first, graphite, one signal-orange accent, Geist); tokens only; 11 §5 vocabulary (no wallet, gas, seed phrase, transaction, network names or addresses in the default view; "backup code"; amounts in dollars); the OS passkey prompt is never drawn; the app never opens received files; no keys, codes, tokens or links in under-the-hood panels; WCAG 2.1 AA, never colour alone, focus rings, live regions; production uses classes, no inline styles (CSP). **States:** empty, loading, live, error, offline for every tile and screen; light, dark and increased contrast; 1280 and 360 wide.
>
> **v2 (owner direction, 27 Oct): make it breathtaking, a native-feeling Mac app.** **Depth:** five elevation levels (canvas, surface, raised, sheet, modal) using the existing shadow-0…4 and background tokens; in dark, a 1 px top highlight and surface tint carry depth where shadows don't show; the sidebar and top bar are translucent (background blur and slight saturation over the content) with a solid fallback for reduced transparency, increased contrast, forced colours, unsupported browsers, and Windows and Linux by default. **Progress:** one family for everything that takes time: determinate bar (file sending, with "2.1 of 8 MB"), indeterminate bar, ring meter (credits, invite and approval time left), live dot, skeleton, success moment, error; nothing shows for waits under 400 ms, and an indicator once shown stays at least 500 ms. **Smooth:** every state change transitions; only transform and opacity animate; no motion library. **Accessibility:** reduced motion and reduced transparency each get a designed still version; every indicator has a word and a screen-reader label. **Decided by the owner (27 Oct), design as its own set:** a Messages page (per contact, Inbox and Sent, read-only, inbound shown as untrusted plain text, no links or formatting) and Files with Received, Sent and Send folders tabs.
>
> **Paying for proof and registration (27 Oct; §19).** AgentLink is not a finance app; only a proof ($0.10) and verified registration ($5.00) cost anything, paid from credits that stay the user's. Design one polished confirmation sheet (level 4): what it is for, the amount large and still, "Paid from your credits", "Your credits stay yours; 4thTech never holds them.", and "Confirm with Touch ID" (or Windows Hello, or your passkey), with "Use backup code instead" as a small link; the system prompt is never drawn; then a breathing ring while waiting, a sweeping arc while recording, and a ring that closes with a check drawing in 480 ms; every state of §19.3 and a reduced-motion version. Keep credits a calm line with the ring meter, and add a plain receipt row per paid action. No charts, no balance hero, no wallet look, no platform or card logos.

## 12. What this brief does not decide

Fixed by the owner: the list in §1. Left to the designer: the nav layout at 360, the tile arrangement, the exact icons (Lucide, ISC, from `brand/icons/ui/`). v2 decisions are in §18 (decided 2026-10-27, D-132); the decisions raised by §19 are in §20. Left to the owner after seeing the design: whether the AI app keeps opening Approvals directly when something waits (the plan says yes), and the build cards (for example Home, motion, under the hood, Files Send, Add contact, Settings), which are written when the design is approved.

---

# Part 2 · v2 additions (owner direction, 2026-10-27)

Everything below adds to §1 to §12 and changes none of them, except as §18 decided. Tokens named `--al-*` exist today in `d1/tokens/tokens.css`; tokens marked **proposed** in §13 and §14 were **approved by the owner on 2026-10-27 (§18 decisions 2 and 3, D-132)** and are added to `tokens.css` by the first build card that uses them, with exactly the values given here.

## 13. Depth: elevation and materials

**Idea.** The app is a stack of calm layers: the window, the content, the cards on it, and what floats above. Each layer is a little lighter (dark theme) or a little more lifted (light theme). Depth tells people what they can act on and what sits on top; it is never decoration.

### 13.1 Elevation levels

Five levels, built from tokens that exist today (a background and a shadow per theme):

| Level | Used for | Background | Shadow | Dark theme adds |
|---|---|---|---|---|
| **0 · Canvas** | The window behind everything | `--al-color-bg-canvas` | `--al-shadow-0` | nothing |
| **1 · Surface** | Page content, list rows, Home tiles at rest | `--al-color-bg-surface` | `--al-shadow-1` | 1 px top highlight (proposed `--al-highlight-top`, white at 4 to 6 %) |
| **2 · Raised** | A tile or card on hover or focus, menus, popovers, the Under the hood panel header | `--al-color-bg-raised` | `--al-shadow-2` | highlight at 6 to 8 % |
| **3 · Sheet** | Side sheets (a contact, message or file detail), the duplicate-contact notice, toasts | `--al-color-bg-raised` | `--al-shadow-3` | highlight plus a hairline border `--al-color-border-subtle` |
| **4 · Modal** | The presence prompt and any confirm dialog; the page behind dims with `--al-color-bg-overlay` | `--al-color-bg-raised` | `--al-shadow-4` | as level 3 |

**Recessed** (below level 1): `--al-color-bg-sunken` for wells: the Under the hood panels (§7), code and fingerprint blocks, and the inbound message container (§17).

**Rules.** A thing rises one level on hover or focus (the higher level's shadow and background sit on a pseudo-element whose opacity cross-fades over `--al-duration-fast`, so only opacity animates; it may also lift 1 px with a transform); it never jumps two levels. At most one level-4 layer at a time. In **dark**, shadows barely show, so depth comes from the lighter background and the top highlight (11 §11: "dark may use surface tint instead"). In **increased contrast and forced colours**, the shadow tokens are already `none`: every level keeps a visible 1 px border instead, so the layering still reads. Orange never marks a level; it still means "this needs you".

### 13.2 Materials (translucency)

Two places get a translucent, frosted material, the way a Mac sidebar and toolbar do: content scrolling underneath shows through softly.

| Material | Where | Look (proposed tokens) |
|---|---|---|
| **Chrome** | Left sidebar, top bar, the 360 bottom bar, sticky day headers | `--al-material-chrome-bg` (the surface colour at 85 % opacity: raised from the proposed 72 % after the contrast measurement of UI-REFRESH-f, owner approved 85% on 2026-10-27 (Decision 16)) with a background blur of about 20 px and saturation 1.4 (`--al-material-blur`); hairline border on the content side |
| **Overlay** | Behind the presence prompt and dialogs | `--al-color-bg-overlay` plus a light blur (about 8 px) |

Cards, rows, messages and anything a person reads at length stay **solid**. The chrome itself carries short text (sidebar labels and badges, the page title, the top bar controls, sticky day headers), so: **chrome text must meet WCAG 2.1 AA contrast against the worst-case content that can scroll under it** (the brightest and the busiest); if it does not, raise the chrome opacity until it does. The solid fallbacks below always meet it.

**Solid fallbacks** (design each one; they are not afterthoughts):

| When | What happens |
|---|---|
| The person asked for **reduced transparency** (`prefers-reduced-transparency: reduce`, where the browser reports it) | Chrome becomes solid `--al-color-bg-surface`; the overlay is solid `--al-color-bg-overlay` |
| **Increased contrast** or **forced colours** | Solid, with a full-strength border |
| The browser can't blur (`@supports not (backdrop-filter: blur(1px))`) | Solid |
| **Windows and Linux** | Solid by default (blur is costly on some Linux setups, and Windows has its own material language); owner decision 3 in §18 |
| Scrolling drops frames in testing on a slow device | Solid |

Technique: CSS only (`backdrop-filter`, `@supports`, media queries), set by classes in the stylesheet, so the CSP (08 §4) is unaffected.

**Design deliverable:** one **elevation and material sheet**: the five levels plus recessed, each in dark, light and increased contrast, and the chrome material over busy and calm content with its solid fallback beside it, **with the contrast of the chrome text measured over the worst-case content** and the chrome opacity chosen from that.

## 14. Motion system: tokens and how they fit 11 §11

**Durations (exist today):** `--al-duration-instant` 0 ms; `--al-duration-fast` 120 ms (press, hover, copy, route fade); `--al-duration-base` 200 ms (state changes, rows in and out, panels); `--al-duration-slow` 320 ms (larger moves, meters filling, file arrival).

**Easings (exist today):** `--al-easing-standard` `cubic-bezier(0.2, 0, 0, 1)` for things that move within the page; `--al-easing-enter` `cubic-bezier(0, 0, 0, 1)` for arrivals (fast start, soft landing); `--al-easing-exit` `cubic-bezier(0.3, 0, 1, 1)` for leaving (quick, no lingering). No overshoot and no bounce anywhere (§2).

**Additions** (approved, owner decision 2, D-132):

| Token | Value | For | Why |
|---|---|---|---|
| `--al-duration-moment` | 480 ms | The once-only signature moments: approval check drawing, safety codes merging, the pulse on Connected (§6 rows 1, 7, 9) | A 320 ms check mark reads as a flicker, not as "done" |
| `--al-duration-ambient` | 1.4 s (shimmer), 2 s (breathing) | Progress loops only: skeleton shimmer, indeterminate bar, the "Waiting for Touch ID" ring, Reconnecting | Loops that cycle every 320 ms feel anxious |
| `--al-easing-emphasized` | `cubic-bezier(0.05, 0.7, 0.1, 1)` | Signature moments and the ring meter filling | A slower, more deliberate settle than `enter` |

**Decided (owner decision 2 (a), D-132; 11 §11 item 6 now says so).** 11 §11 item 6 says "Motion: 120–320 ms, purposeful; nothing loops except progress." §6 of this brief already allows up to 480 ms for one-time success moments, and the progress loops above take longer than 320 ms per cycle. Two readings are possible: (a) 120–320 ms covers transitions only, while progress loops and once-only moments sit outside it; (b) everything stays within 320 ms. The owner chose (a): 120–320 ms covers transitions; once-only signature moments (up to 480 ms), progress loops and the 1200 ms soft highlight are outside it.

**Rules for every motion:**

- Only `transform` and `opacity` animate (plus `stroke-dashoffset` for a drawn check). Never width, height or other layout properties, except a leaving row's height collapse (§6 row 4).
- Every state change transitions; nothing snaps unless reduced motion is on. Interrupted motion continues from where it is (no restart, no jump).
- At most two things move at once. Content a person must read (amounts, codes, fingerprints, message text) never animates letter by letter.
- CSS transitions and keyframes; the Web Animations API for sequences; the View Transitions API for route changes where supported. **No motion library** (§1, owner decision 3).
- **Reduced motion** (system setting, or Settings › Appearance › Reduce motion): no transforms; fades of 120 ms or none; loops become a still state with its word; signature moments become an instant change plus a text line (§6). **Reduced transparency** is separate (§13.2).

## 15. Progress and state components

One family for everything that takes time or has a live state. Every component has a **word** beside it, an accessible name for screen readers (VoiceOver, Narrator, Orca) and, where it changes, a polite live region. None uses colour alone.

### 15.1 Catalogue

| Component | Looks like | Use when | Don't use when | Reduced motion |
|---|---|---|---|---|
| **Determinate bar** | Thin track (4 px) whose fill eases forward; label above ("Sending report.pdf to Marko"), amount after ("2.1 of 8 MB · about 20 s") | The amount done is known: a file sending or arriving, a backup being written | The amount would be a guess (use the indeterminate bar, never a fake percentage) | The fill jumps to each new value; the text updates |
| **Stepped bar** (variant) | The same bar split into named steps that fill in turn: "Preparing · Sending · Delivered" or "Preparing · Recording · Recorded" | A job with a few known stages of unknown length (adding proof, accepting an invite) | More than four steps | Steps change state without movement |
| **Indeterminate bar** | The same track; a short soft segment glides across (`--al-duration-ambient`) | Something is happening and its length is unknown: "Recording proof…", "Checking the invite…" | Under 400 ms (show nothing); a page loading (use a skeleton) | A still, half-filled track with the word |
| **Ring meter** | A circular track with an arc fill; a number or icon in the middle | A quantity against a limit: credits ("$4.80, about 48 proofs"), time left on an invite or approval (counts down), routes up out of total (Under the hood) | Progress of a single job (use a bar) | The arc is set without a sweep; the text keeps the value |
| **Live dot** | §5: a shape plus a word, one pulse on arrival | Something with an ongoing state: the agent, the network, a contact being online | One-off jobs | A still shape and word |
| **Skeleton** | Grey blocks in the shape of the coming content, a very slow, low-contrast shimmer | The first load of a page, tile or list; content replaces it with a 120 ms fade and no layout jump | Refreshing data already on screen (keep the old values and show "Updating…" in small type) | Plain blocks, no shimmer |
| **Success moment** | §6 rows 6 to 10: the check draws, the stamp settles, the codes merge, the file drops into the Received card; then the normal state | The end of something the person did or waited for; once | Routine background events (they simply appear in Activity) | An instant state plus a text line ("Approved") |
| **Error** | A red edge, an icon and one sentence that says what to do ("Couldn't send. Your AI will try again in a minute." with "Try again"); one 4 px nudge | Something failed and the person can act, or should know | A routine retry: that is a warning (amber, "Retrying…"), not an error | No nudge; the same edge, icon and words |

### 15.2 Timing rules

- **Under 400 ms:** show nothing (no flash of a spinner).
- **400 ms to about 2 s:** the indeterminate bar, or a skeleton on first load.
- **Longer, with a known amount:** the determinate bar with the amount, and time left once the estimate is steady (after about 2 s).
- **Once shown, an indicator stays at least 500 ms**, then hands over to the success moment or the error.
- **Waiting on a person or another agent** (Touch ID, a contact accepting an invite, a delivery confirmation) is not a progress bar: use the breathing ring (§6 row 12) or a status word with time ("Waiting for Marko to accept · 2 days left").
- **Work continues when you leave the page.** The sidebar badge or the Home tile shows it, and nothing blocks navigation.

### 15.3 What takes time in this app, and which component it gets

| Job | Component |
|---|---|
| A file sending (preparing, uploading, delivered) | Stepped bar, with the determinate fill during the upload; then the Delivered chip |
| A file arriving | Determinate bar on its row in Received; then the file-received moment |
| Adding proof | Stepped bar "Preparing · Recording · Recorded"; then the proof stamp |
| Credits arriving after a top-up | Indeterminate bar "Waiting for your credits…"; then the meter fills over `--al-duration-slow` |
| An invite waiting for the contact | Ring meter counting down the days left, with "Waiting for {name} to accept" |
| An approval waiting | Ring meter for the time left, on the card and on the Home tile |
| Waiting for Touch ID (on other platforms: "Waiting for Windows Hello", or "Waiting for your passkey" when the platform has no name for it, as in 11 §6.2 first run) | Breathing ring (§6 row 12) |
| The agent connecting or reconnecting | Live dot |
| Writing the recovery kit or backup | Determinate bar |
| The first load of any page or tile | Skeleton |

**Design deliverable:** a **progress and state component sheet**: each component at start, middle, done and error; dark, light and increased contrast; reduced motion; 360.

## 16. Per-screen notes (depth, motion, progress)

How §13 to §15 apply to each page of §8. The states listed in §4 and §8 still apply.

| Page | Depth | Motion and progress | Under the hood |
|---|---|---|---|
| **Home** | Tiles on level 1, rising to level 2 on hover and focus; the Waiting for you tile has an orange edge when it is not zero; the Next step card sits one level above the grid | Skeleton tiles first; numbers tick when they change; Credits is a ring meter that fills; Last activity rows slide in; the Agent tile carries the live dot; nothing loops except a reconnecting dot | Per §7 |
| **Approvals** | Cards on level 1; the card being decided rises to level 2; the presence prompt is level 4 over the blurred overlay | Each card has a small ring meter for time left; on approval the check draws and the card collapses out; on deny it fades out; the badge ticks down | Approval ID, kind, exact expiry |
| **Activity** | Day headers stick to the top on the chrome material while scrolling | New rows slide in with the 1.2 s highlight; filter chips cross-fade the list without a layout jump; a live dot in the page header shows the list is live | Event IDs |
| **Contacts** | Rows on level 1; a contact's detail opens as a level-3 side sheet (at 360, a full page) | Online dots per contact; the invite page has the ring meter countdown and a breathing "Waiting for {name}"; the codes-match moment; the duplicate notice slides in as a level-3 banner | Fingerprint, identity level, pairing date |
| **Files** | Cards and rows on level 1; the Received card is slightly raised as the place files land | Stepped and determinate bars on rows that are sending or arriving; the file-received moment; badges tick | Real folder paths, storage, size used |
| **Proofs & credits** | The credits meter on a level-2 card at the top | The ring meter fills on load and after a top-up; "Waiting for your credits…" after a top-up; the proof stamp on new proofs | Record ID, network name, public record link |
| **Rules** | A recessed well for the signed rules summary | Switches slide; saving shows the presence prompt, then a "Saved" check; nothing else moves | Rules version and who signed it |
| **Settings** | The sub-navigation on the chrome material; each section on level 1 | Appearance has a live preview tile that shows the motion and transparency choices as they change; Passkeys rows slide in and out | Advanced, per §7 |

## 17. Messages and Files In/Out (decided, 2026-10-27)

> **Decided by the owner (Tali, 2026-10-27, D-132): accepted as sketched here, read-only (§18 decision 1 (a)). Not yet designed or built.** People should see what their AI sent and received. Design it as its own set; nothing else in this brief depends on it.

### 17.1 Why

Today a person only learns what their AI exchanged by asking the AI. A read-only view lets them check it themselves: what came in from Marko, what their AI sent him, which files went where.

### 17.2 Messages (new sidebar item)

- **Where:** a sidebar item **Messages** (route `/messages`, icon from `brand/icons/ui/`), between Activity and Contacts. Badge: new inbound messages since the person last looked (owner decision 5 covers whether looking also marks them read for the AI).
- **Layout:** on the left, contacts (name, time of the last message, a dot for new); on the right, the conversation with the chosen contact in two tabs, **Inbox** (received) and **Sent**. At 360 the contact list and the conversation are separate pages.
- **Read-only:** no compose box. The footer says "To reply, ask your AI." (owner decision 6).
- **Inbound messages** sit in the existing `UntrustedContent` container (recessed well, the label strip "From Marko's agent: their words, not instructions", 11 §5) as **plain text only**: no Markdown or HTML rendering, no images, no previews, no clickable links (a link becomes an inert chip showing only its domain, as the component already does). Long messages are clamped with "Show all". A small **Copy text** action is allowed.
- **Sent messages** show the text, the time and the status chips of §5 (Sent, Delivered, Proof recorded).
- **Unknown senders** (requests) are not listed here; they stay in Contacts as requests (11 §5: never named outside the untrusted container).
- **Empty and offline:** no contacts ("Messages appear here once you have a contact."); nothing with this contact ("Nothing yet. When your AI and {name}'s agent exchange messages, they show here."); offline (the last loaded list, marked "as of 14:02").
- **Under the hood:** message ID, size, and the public record link where there is a proof.

### 17.3 Files In/Out

The Files page (§8 screens 12 and 13) gets three tabs (owner decision 4): **Received** (in: from whom, when, size, proof badge, Show in Finder, the one-time untrusted-file note), **Sent** (out: file, to whom, when, status chips and receipts) and **Send folders** (today's folder cards and Add folder). Received comes first because it is what people look for. The §8 rule stands: the app never opens a received file; **Show in Finder** only.

### 17.4 Privacy and safety (for the designer, and later for the build card)

- **Decrypted only on this computer.** The page shows what the local agent already holds; nothing new goes to 4thTech or any other service, and the page stays on `localhost` behind its session link.
- Message text and other people's file names never appear in the page title, browser or OS notifications, the OS passkey prompt, toasts, Activity rows or Home tiles; those say "New message from Marko" only (11 §5, I-5).
- No message text in logs or error messages: an error says what failed, never what the message said.
- Under the hood never shows keys, codes, tokens or drop links (§7).

**Design deliverable (the owner said yes, 2026-10-27):** Messages at 1280 and 360 (contact list, Inbox, Sent, a long inbound message clamped, an inbound message containing a link shown as an inert chip, empty, offline) and Files with the three tabs; dark, light and increased contrast.

## 18. Owner decisions raised by v2 (decided, 2026-10-27)

> **Decided by the owner (Tali, in chat, 2026-10-27, D-132): every decision below as recommended, option (a) in each.** The other options are kept for the record.

1. **Messages and Files In/Out (§17):** (a) **yes, read-only, as sketched** (recommended); (b) Files In/Out only; (c) not now.
2. **Motion durations and 11 §11 item 6 (§14):** (a) **120–320 ms is the range for transitions; exempt are once-only signature moments (up to 480 ms), progress loops, and the 1200 ms soft highlight on a new row (§6 row 3, an opacity fade, not movement); add `--al-duration-moment`, `--al-duration-ambient` and `--al-easing-emphasized` to the tokens and clarify 11 §11 in a later spec PR** (recommended); (b) keep everything within 320 ms and shorten the 480 ms moments in §6.
3. **Translucency and depth tokens (§13):** (a) **add the proposed `--al-highlight-top`, `--al-material-chrome-bg` and `--al-material-blur` to the tokens; solid by default on Windows and Linux, translucent on Mac** (recommended); (b) the same tokens, translucent wherever the browser supports it; (c) no new tokens: solid chrome everywhere, depth from shadows and backgrounds only.
4. **Files tabs (§17.3):** (a) **Received · Sent · Send folders** (recommended); (b) keep the two tabs of §1 owner decision 5, Send (folders plus a Sent list) and Received.
5. **Does reading a message in the app mark it read for the AI?** (a) **No: the app keeps its own "seen" marker, so the AI still gets it as new** (recommended); (b) yes, one shared read state.
6. **Writing messages from the app:** (a) **not now; "To reply, ask your AI."** (recommended); (b) a compose box in a later version.

---

# Part 3 · Paying for proof and registration (owner direction, 2026-10-27)

## 19. Paying for proof and registration

**Owner direction (Tali, in chat, 2026-10-27; D-132).** AgentLink is not a financial app, not a wallet and not a bank. 4thTech never holds anyone's funds: prepaid credits stay the user's and can be taken back at any time (12 §1, §4.1). Only two actions cost anything: **Proof** ($0.10 per recorded proof, covering up to 3 receipts) and **Verified registration** ($5.00, once per agent; M2) (12 §2). There are no payments to contacts or other agents. When a paid action needs the owner, the owner confirms it with whatever the computer offers (Touch ID or another fingerprint reader, Windows Hello face or PIN, a passkey, or the PIN pad the system shows) through a real WebAuthn user-verification ceremony (04 §2.5.3). The feel is that of paying with a phone at a till: one calm, polished sheet with the amount and what it is for, the system's own prompt, then a crisp progress-to-check moment. Model the pattern, never its marks: no Apple, Google or card-network logos, colours or wording.

**Not in scope.** No balance hero, spending charts, spending breakdowns, dashboards or new money features. Adding credits and Withdraw credits keep their current flows (Proofs & credits page, `topup-ux.md`, M1-11c-a4c); they are already owner operations (04 §2.5), so their existing confirm step uses this sheet's look, nothing more.

### 19.1 When the sheet appears

The rule is in 04 §2.5.3 (decided by the owner, 2026-10-27, §20 decision 1 (a)). In short:

| Paid action | What the owner sees |
|---|---|
| A proof inside the owner's signed limits (per-proof limit and the 24-hour budget, 06 §3) | Nothing at the time; a receipt row afterwards (§19.4). The AI says the cost first (06 instructions) |
| A proof above the per-proof limit or the 24-hour budget, or for a contact whose rule says "Ask me" | The approval card (§8 screen 4); its main button opens this sheet |
| Verified registration ($5.00, M2) | This sheet |
| Changing the spending limits (24-hour budget, per-proof limit, "Ask me" for proofs, a contact's per-proof limit) | This sheet, showing old and new values |
| Adding credits from funds the agent received, and Withdraw credits (existing) | Their existing confirm step, in this sheet's look |

### 19.2 The confirmation sheet

A **level-4 modal** (§13.1) over the blurred overlay. At 1280 it is centred, about 400 px wide; at 360 it rises from the bottom edge as a full-width sheet with a grab handle. Anatomy, top to bottom:

1. **What it is for**, as the title: "Record proof", "Get the Registered badge", "Change your spending limits", "Withdraw credits".
2. **The amount**, large (`--al-text-display-*`, tabular figures of Geist): "$0.10". It never animates and never rolls (§6: amounts are never revealed piecemeal). For a limits change: "24-hour budget $5 → $10" with the `--al-color-diff-*` tokens.
3. **Detail rows** (label left, value right, `--al-text-body-sm-*`): "For" (a proof of the message to Marko, using the contact's owner alias per 11 §5.2, never counterparty text); "Paid from" "Your credits · $4.80"; "After" "$4.70". Registration adds "Once for this agent".
4. **The trust line** in muted text: "Your credits stay yours; 4thTech never holds them." and "Your AI can't confirm this for you."
5. **The main button**, named for the platform (as 08 §1 does for approvals): **"Confirm with Touch ID"** on a Mac with Touch ID, **"Confirm with Windows Hello"** on Windows, otherwise **"Confirm with your passkey"**. Icon from `brand/icons/ui/` (Lucide `fingerprint`, `scan-face` or `key-round`), never a platform logo. Not focused by default (§9); focus starts on the title.
6. **Cancel**, and the small link "Use backup code instead" where §20 decision 2 keeps it.

**The system prompt is never drawn.** After the click, the browser or OS shows its own Touch ID, Windows Hello, passkey or PIN dialog; the sheet only waits beside it.

### 19.3 States and motion

| State | What shows | Motion (tokens from §14) | Reduced motion |
|---|---|---|---|
| **Opening** | The sheet | Rises 16 px (360: from the bottom edge) and fades in, `--al-duration-slow`, `--al-easing-emphasized`; the overlay fades in `--al-duration-base` | 120 ms fade |
| **Ready** | As §19.2 | Still | Still |
| **Waiting** | The button becomes a ring around the platform icon, "Waiting for Touch ID" (or "Windows Hello", "your passkey"), Cancel | Breathing ring (§6 row 12), `--al-duration-ambient` 2 s | A still ring with the words |
| **Recording** | The ring turns into an arc that sweeps; "Recording proof…" ("Saving your limits…", "Registering…") | Indeterminate arc, `--al-duration-ambient` 1.4 s per turn; shown only after 400 ms (§15.2) | A still half arc with the words |
| **Done** | The arc closes into a full ring, a check draws inside it, the amount stays; "Done · $0.10 paid from your credits" | Ring closes and the check draws (`stroke-dashoffset`), together `--al-duration-moment` 480 ms, `--al-easing-emphasized`; then one soft pulse ring (§6 row 1); the sheet closes itself after about 1.2 s (§20 decision 3) and the receipt row slides in (§6 row 3) | An instant check and "Done"; the sheet waits for "Close" |
| **Cancelled** (the person dismissed the system prompt) | Back to Ready; "Not confirmed. Nothing was paid." | Cross-fade, `--al-duration-fast` | Same, no fade |
| **Couldn't confirm** (verification failed or timed out after 60 s) | "Couldn't confirm it was you. Try again." | Text change only; no nudge (presence failures only change text, §6 row 13) | Same |
| **Expired or decided elsewhere** | "This request expired" or "Already decided on another screen" with Close | Cross-fade | Same |
| **Not enough credits** | "You need $0.10 more in credits." with "Add credits" (the existing flow) | None | None |
| **Still working** (the network is slow after confirming) | "Still recording. Your AI will let you know when it's done. You can close this." | The arc keeps sweeping | Still arc |
| **Failed after confirming** | Red edge and icon: "Couldn't record the proof. Your credits are unchanged." with "Try again" | Error per §15.1 (no nudge on the sheet) | Same, no motion |

Rules: never claim "nothing was paid" while a held amount may still be charged (06 §3: a failed submission alone does not release it); show **Still working** instead until the outcome is known. At most two things move at once (the arc and the check count as one moment). All art is vector (SVG strokes at `--al-border-width-thick`), crisp at 1x to 3x, and animates only `transform`, `opacity` and `stroke-dashoffset`, so it stays at 60 fps on a five-year-old laptop.

### 19.4 Credits line and receipt rows

- **Credits** stay as they are today: the Home tile and the Proofs & credits card show "$4.80 · about 48 proofs" with the ring meter (§15.1), plus "Used in the last 24 hours: $0.30 of $5" (06 §3). The meter fills over `--al-duration-slow` when the value changes; nothing counts up and there is no chart. Under it, small: "Your credits stay yours; 4thTech never holds them."
- **A receipt row per paid action** in Activity and in the proof list: icon (proof stamp or Registered badge), "Proof · message to Marko" or "Verified registration", "$0.10", time, and a status word: **Held** (reserved while the proof is being recorded), **Paid**, or **Not charged** (the hold was released, 06 §3). Selecting it opens the existing proof detail; Under the hood (§7) adds the record ID and public record link. Inbound text and others' file names never appear in the row (§17.4).

### 19.5 Accessibility

- The sheet is a modal dialog (`role="dialog"`, `aria-modal`, labelled by its title, described by the amount and "For" row); focus is trapped; Escape cancels except while Recording; focus returns to the control that opened it.
- One polite live region announces Waiting, Recording, Done, Cancelled; errors are assertive. The amount is read as words ("ten cents").
- Never colour only: every state has an icon shape and a word. Contrast per `d1/design-system/contrast.md`, in dark, light and increased contrast; forced colours keep the ring and check visible as strokes.
- Touch targets at least 44 px at 360; the sheet scrolls if text is enlarged to 200 %.

### 19.6 Copy (11 §5)

Never "wallet", "bank", "transaction", "gas", "deposit", "payment method" or "balance top-up" in the default view; say "credits", "proof", "proof fee", "Add credits", "Withdraw credits", "Confirm with Touch ID". Sample strings: "Record proof · $0.10"; "Paid from your credits"; "Your credits stay yours; 4thTech never holds them."; "Your AI can't confirm this for you."; "Done · $0.10 paid from your credits"; "Not confirmed. Nothing was paid."

**Design deliverable:** the confirmation sheet in each §19.1 variant and each §19.3 state, at 1280 and 360, dark, light and increased contrast, with reduced motion; the motion as a short prototype or annotated frames (Opening, Waiting, Recording, Done); the credits line with its trust line; the receipt row in its three statuses.

## 20. Owner decisions raised by §19 (decided, 2026-10-27)

> **Decided by the owner (Tali, in chat, 2026-10-27, D-132): option (a) of each decision below.** The other options are kept for the record.

1. **Which paid actions use the confirmation sheet** (spec: 04 §2.5.3): (a) **verified registration, a proof above the signed limits (or for a contact set to "Ask me"), and any change to the spending limits; proofs inside the signed limits stay automatic** (recommended); (b) as (a), but limits changes keep today's ordinary approval prompt; (c) every proof, including those inside the limits.
2. **Backup code on the sheet:** (a) **keep "Use backup code instead" as the small secondary link, as on every approval** (recommended: no new friction, and a lost passkey never blocks proofs); (b) paid actions accept only the platform check.
3. **After Done:** (a) **the sheet closes itself after about 1.2 s** (recommended; with reduced motion it waits for Close); (b) it always waits for Close.

---

# Part 4 · UX wave 2 (owner feedback, 2026-10-28)

Source: `docs/process/proposals/UX-WAVE-2.md` (§4, §9.1) and the owner's decisions of 2026-10-28 (all as recommended; decision 8.1 puts §22 and §26 into 0.4.2). Card UX2-brief-0 adds §22 and §26 here; §21, §23, §24, §25 and §27 follow with card UX2-brief and slot in by number. **Both sections wait for the owner's approval; UX2-a and UX2-b start only after it.** Nothing new is drawn: every control below is an existing `packages/ui` component (`Switch`, `Segmented`, `Button`), restyled only with existing `--al-*` tokens. The screenshots in the UX2-a and UX2-b PRs are the owner's visual review, as for the refresh (D-116, D-135).

## 21. Add contact: create an invite, or use one

**Idea.** Today a newcomer has to know to ask their AI for an invite, and Home's Next step leads to a page without a button (UX-WAVE-2 item 1). One **Add contact** button now does it in the app: create a ready-to-send invite and hand it on through Copy, the system share sheet or a QR code, or paste an invite someone sent you. Pattern: Slack and Linear "Invite people", Signal and WhatsApp contact QR codes, Apple's share sheet. Built from `Button`, `Segmented` (§22), `TextField`, the `QrCode` of Add credits (`pages/proofs/qr.tsx`), the copied moment (§6 row 6) and the level-3 side sheet (§13.1). Owner decisions 1.1 and 2.1 apply. **This section replaces §8 screens 8 and 9** where they differ: creating an invite needs no Touch ID (decision 1.1), the QR code shows on request, and the safety line is the one in §21.3.

### 21.1 Where it opens

- **Contacts:** an **Add contact** button (secondary; primary only when the list is empty) at the end of the page title row.
- **Home:** step 2 of Start here (§27) and the empty states of Contacts, Messages and Files (§27.4) open the same sheet.
- **The sheet:** level 3 (§13.1), from the right, 480 px wide, full height; the page behind stays visible and is not dimmed (it is not a modal). At 600 px and under it is a full page with a Back arrow. Esc and Close close it. Opening it changes nothing in the address bar except, at most, a fixed marker with no data (never an invite, a name or an ID); the page title stays "Contacts".

### 21.2 The two choices

A `Segmented` control at the top of the sheet (§22: tab semantics, since it swaps the panel below): **Invite someone** (default) and **I have an invite**.

```text
1280, sheet open (level 3, 480 px)                         360 (full page)
┌────────────────────────────────┬─────────────────────┐   ┌──────────────────────────────┐
│ Contacts      [ Add contact ]  │ Add contact       ✕ │   │ ←  Add contact               │
│ ┌────────────────────────────┐ │ [✓ Invite someone │ │   │ [✓ Invite someone │ I have…] │
│ │ row                        │ │   I have an invite ]│   │                              │
│ └────────────────────────────┘ │                     │   │ Who is it for? (optional)    │
│ ┌────────────────────────────┐ │ Who is it for?      │   │ [ Marko                    ] │
│ │ row                        │ │ (optional)          │   │                              │
│ └────────────────────────────┘ │ [ Marko           ] │   │ [      Create invite       ] │
│                                │ [ Create invite ]   │   │                              │
└────────────────────────────────┴─────────────────────┘   └──────────────────────────────┘
```

### 21.3 Invite someone

| State | What shows |
|---|---|
| **Form** | `TextField` **"Who is it for?"** (optional), hint "Helps you recognise them when they answer." The name is stored as the invite label and stays a suggested name until you approve the new contact (06 §2.1, 11 §5.2). One primary button **Create invite** |
| **Creating** | The button shows "Creating…" and is disabled; nothing else moves (§15.2: under 400 ms nothing shows) |
| **Ready** | Heading "Invite ready" (with a name: "Invite ready for Marko"). The ready-to-send text (`shareText`: our fixed template with the link and expiry, 11 §6.1 J7) in a recessed well (`--al-color-bg-sunken`, `al-text-body-sm`, wraps, never scrolls sideways). Under it: "Works once, until 19 Oct." Then the **safety line** (below). Then three ways out, in this order: **Copy invite** (primary), **Share…** (secondary), **Show QR code** (secondary; becomes **Hide QR code**). Last, **Done** (ghost) closes the sheet |
| **Copied** | §6 row 6: the Copy icon becomes a check and the label "Copied" for 1.6 s; a polite announcement "Invite copied". No toast (a toast would be a second place showing it) |
| **QR shown** | The code (`QrCode`, dark modules on a light square in both themes, as Add credits) at least 240 px square, centred in the sheet, full width at 360; the caption "Scan it with their phone's camera." The QR encodes the invite link only, not the whole message |
| **Can't create** | Red edge and one sentence: "Couldn't create the invite. Try again in a minute." with **Try again**; the name typed stays |
| **Agent not running / not set up** | The whole-app states of §8 screen 23; the button is not shown |

**The safety line** (`al-text-body-sm`, `--al-color-fg-muted`, an `info` icon, directly above the three buttons; never colour alone):

> **Send it only to Marko. Anyone with this link can connect once.** A private chat, email or text message is fine. Don't post it publicly.

Without a name: "Send it only to the person you mean. Anyone with this link can connect once." It claims nothing more: the sheet never says "secure", "safe" or "encrypted" about the link. Why the wording holds (UX-WAVE-2 §3): the link is single use, expires, carries no key or code of the owner, and a copied or swapped invite is caught by the safety code (04 §3.6.1); a link posted publicly is answered by whoever is first.

**Share…** opens the operating system's share sheet (`navigator.share`, text only, title "AgentLink invite"). It is **hidden, not disabled,** where the browser has no `navigator.share` or `navigator.canShare({ text })` says no, so nobody meets a button that does nothing. If the person closes the share sheet, nothing happens; if sharing fails: "Sharing didn't work. Use Copy invite instead." **No email button and no `mailto:`** (decision 2.1).

**Closing.** Done or Close closes the sheet. The new **pending row** is already in the list (it arrived with §6 row 3 when the invite was created) and gets the 1.2 s highlight as the sheet leaves: "Waiting for Marko to accept", with the ring meter counting the days left (§15.3). From there the existing steps take over: the safety-code step when they answer (§8 screen 10). If the person closes before Copy, Share or Show QR code, the sheet first says, in place: "You haven't sent the invite yet. Close anyway?" with **Close anyway** and **Keep it open**. The invite is not shown again after the sheet closes (§21.5).

### 21.4 I have an invite

| State | What shows |
|---|---|
| **Paste** | `TextField` (multi-line) **"Paste the invite link"**, hint "It starts with https://{inviteHost}/i#". **Check invite** (primary), disabled while the field is empty |
| **Checking** | Indeterminate bar "Checking the invite…" (§15.1) |
| **Who it is** | The inviter as 11 §6.5 and §5.2 show them: name under the name rule with its label (for example "Self-declared"), the short owner fingerprint, and the expiry; the question **"Is this who you expected?"**; **Connect** (primary) and **Cancel**. Connect asks for Touch ID (the presence prompt, §8 screen 5, level 4), because it leads to a new contact (decision 1.1) |
| **Connecting** | "Connecting to Marko…" with the indeterminate bar; then the step the route returns: either the new-contact approval under your rules ("One more step: approve Marko as a contact." with **Review**, which opens it in Approvals), or the pending row and, when their agent answers, the safety-code step |
| **Can't use it** | One sentence each, then **Ask for a new invite** guidance (11 §9, "Invite expired, used or damaged"): "This invite has expired.", "This invite was already used.", "This link isn't a complete AgentLink invite. Ask for it again.", "This is your own invite." |
| **Offline** | "Can't reach AgentLink on this computer. Try again in a minute."; the pasted text stays in the field |

The pasted text is cleared from the field once the invite is used or the sheet closes.

### 21.5 Where the invite may appear (for the build card)

The invite (link and share text) appears **only in the sheet**: the well, the QR code and the clipboard or share sheet the person chose. Never in the address bar, the page or window title, a toast, a notification, Activity, Under the hood, a log or an error message, and never sent through a 4thTech service (no link shortener, no "email it for me"). No element attribute holds the link (no `data-value`, `title`, `aria-label` or `data-*` carrying it): it is only text content of the well and the QR code's drawing. The pending row shows the name and days left, never the link. Copy copies `shareText`; Share sends `shareText`; the QR code holds `inviteUrl`.

### 21.6 Accessibility and motion

- The sheet is a labelled region ("Add contact"); focus moves to its first field on open and returns to the Add contact button on close. Live region (polite): "Invite ready", "Invite copied", the error sentence.
- QR code accessible name: "QR code of the invite for Marko" (never the link itself).
- Reduced motion: the sheet appears without sliding; Copied changes the word at once; the new row appears without the highlight's movement (the highlight colour still fades).
- 44 px targets at 360 (`--al-size-control-lg`); the three buttons stack full width at 360.

### 21.7 Copy (11 §5)

New strings: "Add contact", "Invite someone", "I have an invite", "Who is it for?", "Helps you recognise them when they answer.", "Create invite", "Creating…", "Invite ready", "Invite ready for {name}", "Works once, until {date}.", the safety line (§21.3), "Copy invite", "Invite copied", "Share…", "AgentLink invite", "Show QR code", "Hide QR code", "Scan it with their phone's camera.", "Done", "You haven't sent the invite yet. Close anyway?", "Close anyway", "Keep it open", "Couldn't create the invite. Try again in a minute.", "Sharing didn't work. Use Copy invite instead.", "Paste the invite link", "Check invite", "Checking the invite…", "Is this who you expected?", "Connect", "Connecting to {name}…", "One more step: approve {name} as a contact.", and the four "Can't use it" sentences. `{name}` is always the name-rule output, rendered as text. No "wallet", "address", "key", "transaction" or "relay".

## 22. Control map: switch, segmented control, button

**Idea.** The owner likes the Under the hood switch (§7) and wants that feel wherever it fits. It fits where something is *on or off*. Choosing between views gets the same track and sliding marker, as a segmented control. Doing something stays a button: a switch on an action ("Approve") would mislead people and screen readers alike (Apple HIG, Material).

### 22.1 Which control goes where

| Control | Use when | Never for | Semantics (today's components) |
|---|---|---|---|
| **Switch** (`Switch`) | A binary setting that takes effect at once, or a draft setting that a Save confirms (Rules, §22.5) | An action; more than two values; a two-way choice where one side is "follow the system" | `role="switch"`, `aria-checked`, label and optional description; the On/Off word stays beside the knob |
| **Segmented control** (`Segmented`) | Picking one of two to four views, filters or setting values | An action; five or more options (use a list or a menu) | Setting values, filters and layouts: `role="radiogroup"` (today). Views that swap the panel below: tab semantics (`tablist`, `tab`, `tabpanel`, `aria-selected`, `aria-controls`), as Files does today, in the same look |
| **Button** (`Button`) | Doing something: Approve, Deny, Add contact, Add credits, Copy, Show, Discard, Review and save | A setting or a view | `<button>`; primary only for the one action of the screen (orange rule, §1 Brand) |

### 22.2 Page by page (UX2-b)

| Page | Control | Becomes | Note |
|---|---|---|---|
| Top bar | Under the hood | Switch (unchanged) | The reference look |
| Rules | Everyday choices (Allowed / Ask me / Never; Ask me / Never) | Segmented, radiogroup (role unchanged) | Restyled per §22.3 |
| Rules | Buy and sell limits | Switch (unchanged) | Draft until saved, §22.5 |
| Settings › Appearance | Theme (System / Light / Dark), Motion (System / On / Off) | Segmented (unchanged) | Three values |
| Settings › Appearance | Transparency (System / Reduce) | **Stays segmented** | On a switch, "Off" would read as "never reduce", which is not what System means |
| Settings › Appearance | Under the hood | Switch (unchanged) | |
| Rules, "Before you save" confirm step | Keep delivery receipts | Switch (unchanged) | The only receipt setting in the app today; notification settings get a switch when they exist |
| Messages | Inbox / Sent | Segmented look, **tab** semantics | Today a radiogroup; it swaps the conversation panel |
| Files | Received / Sent / Send folders | Segmented look, tab semantics (role unchanged) | Replaces today's `fl-tabs` look; the count badges (`CountBadge`) stay inside each option |
| Activity | All / Approvals / Proofs / Other | Segmented, radiogroup | Today four `aria-pressed` chips; exactly one is always chosen, so a radiogroup is the honest role |
| Approvals | Grid / List | Segmented, radiogroup | New, §26 |
| Approvals, Review together | Approve / Deny / Later per card | **Unchanged** (`al-choices`) | A pick that the Review button confirms, not a view |
| Proofs & credits | — | **No control added** | The proof list and the credits card show together (stacked at 360), so there is no view to choose |
| Everywhere | Approve, Deny, Add contact, Add credits, Copy, Show, Save | Buttons (unchanged) | |

### 22.3 The look (existing tokens only)

The segmented control takes the switch's language: the same recessed track and a sliding marker. Only `.al-seg` in `components.css` changes; the switch does not.

```text
Switch (today, unchanged)              Segmented (proposed restyle)

 Under the hood  ┌──────────┐           ┌─────────────────────────────┐
                 │ ON    ▣  │           │┌───────────┐                │
                 └──────────┘           ││ ✓ Inbox   │    Sent        │
                                        │└━━━━━━━━━━━┘                │
                                        └─────────────────────────────┘
 track: bg-sunken, border-strong,       track: bg-sunken, border-strong, radius-sm,
        radius-sm; On: accent-subtle           padding space-1, no dividers
 knob:  radius-xs; slides 40 px         thumb: accent-subtle, radius-xs, 2 px accent
        (duration-fast,                        bottom edge (━); slides under the chosen
        easing-standard)                       option like the knob and the nav slider
                                        label: chosen fg-default with the check icon;
                                               the others fg-muted
```

| Part | Tokens |
|---|---|
| Track | `--al-color-bg-sunken`; `--al-border-width-thin` in `--al-color-border-strong`; `--al-radius-sm`; padding `--al-space-1`. Today it has `--al-radius-md` and dividers between options |
| Option | Height `--al-size-control-md` (32 px), `--al-size-control-lg` at 360 (44 px touch targets, as §19.5); padding `0 --al-space-3`; `al-text-body-sm`; `--al-color-fg-muted` |
| Thumb (chosen) | `--al-color-accent-subtle`; `--al-radius-xs`; a 2 px `--al-color-accent-default` bottom edge (today's `inset 0 -2px 0` marker); text `--al-color-fg-default`; the existing `check` icon. The same tint marks the switch's On track and the selected nav item, so "chosen" reads the same everywhere |
| Motion | The thumb moves with `transform` only, `--al-duration-fast`, `--al-easing-standard` (the knob's and the nav slider's values). The label colour changes instantly while the thumb slides, because motion is limited to transform and opacity |

### 22.4 States and focus

| State | Switch | Segmented |
|---|---|---|
| Rest | Off: sunken track, muted knob, "Off". On: tinted track, orange knob, "On" | Thumb under the chosen option |
| Changed | Knob slides, track tints, the word flips | Thumb slides to the new option; nothing else moves (§14: at most two things) |
| Keyboard focus | Today's global `:focus-visible` ring (`--al-focus-ring-width`, `--al-color-focus-ring`, `--al-focus-ring-offset`) around the switch | The same ring around the **focused option**, not the whole track |
| Keyboard | Tab reaches it; Space or Enter toggles | One tab stop; arrow keys move and select, wrapping (today's `Segmented` and Files tabs); with tab semantics, Tab then moves into the panel |
| Disabled | `--al-opacity-disabled`; the description says why (as Rules does today) | `--al-opacity-disabled` on the group; still readable |
| Busy (a save in flight) | Disabled until the answer, then shows the real state | Not used |
| Hover | Nothing added (D-116: no new state) | Nothing added |
| Reduced motion | No slide: knob and word change at once (the global `transition: none` rule) | The thumb jumps; the check icon and the label carry the choice |
| Forced colours, increased contrast | 1 px `CanvasText` border (today's rule); the On/Off word carries the state | The same border; the chosen option keeps its check icon, so it never relies on the tint |

Never colour alone: the switch has its On/Off word, the segmented control its check icon. New strings: **"Unsaved"** (§22.5), **"Layout"**, **"Grid"** and **"List"** (§26.2). They are plain words that follow 11 §5, with none of its banned terms. Every other label already exists in its page's `strings.ts`.

### 22.5 Switches that need owner presence (Rules)

A switch in Rules edits the **draft**, never the rules in force. While a switch differs from the saved value, its row shows the word **"Unsaved"** (`al-text-caption`, muted, beside the switch) and today's unsaved-changes bar appears ("1 change", Discard, Review and save). Saving goes through the owner-presence prompt as today; the word goes only once the save has succeeded. Discard puts the switch back. So a Rules switch never shows a state that is not in force without "Unsaved" beside it.

## 23. Waiting for funds, with the AgentLink mark

**Idea.** After sending funds, people stare at a still page and wonder whether it worked (UX-WAVE-2 item 3). Add credits gets a three-step tracker in the style of Wise's transfer tracker and Stripe's payout timeline: named steps, the current one alive, an honest time hint, and an amount only once a read has proved it. While waiting, the AgentLink mark's diamond turns slowly: the one brand exception of owner decision 3.1 (§23.4). It replaces §15.3's "Waiting for your credits…" indeterminate bar inside Add credits only. Built from `Mark`, the `ReceiptTimeline` step look (done steps solid, pending steps hollow and dashed), the drawn check (§6 row 7), the ring meter (§15.1) and the presence prompt.

### 23.1 The three steps

Shown inside the Add credits panel (`pages/proofs/top-up.tsx`), under today's QR code and account (the details), as a vertical list of three rows. Each row: a 20 px marker, the step word, and the time it was reached ("14:02"), once reached.

| Step | Shown when (server reads only) | Marker and motion | Words |
|---|---|---|---|
| **1 · Waiting for your funds** | The panel is open and the top-up read shows nothing new yet | The waiting mark (§23.3), 40 px, beside the step | "Waiting for your funds" · "Usually takes about a minute." |
| **2 · Arrived** | A top-up read returns `received` **above the value it had when the panel opened**. If funds were already there when the panel opened (`addable` above zero), the panel opens on this step | The diamond finishes its current quarter turn and rests; step 1's marker draws its check (`--al-duration-moment`, `--al-easing-emphasized`); step 2 becomes current | "Arrived · $5.00" (the `received` value). One primary button with today's string **"Add $4.98 to your credits"** (`addable`), which asks for Touch ID (`credits.deposit`, 04 §2.5.1). When `addable` is below `received`, today's line "A little stays with your agent to cover network costs." |
| *(between 2 and 3)* | The owner operation has been sent, and the credits read does not show the new value yet | Indeterminate bar (§15.1) on step 3, **not** the waiting mark | "Adding to your credits…" |
| **3 · Added to credits** | The owner operation **succeeded and** `/api/ui/proofs/credits` returns the new value | Step 3's check draws; the credits ring meter fills over `--al-duration-slow` | "Added to credits · $9.78 now" (the credits read) |

**Never early.** No timer advances a step and no amount appears before the read that proves it: step 2's amount is the `received` value of that read; step 3's is the credits read after success. A submitted owner operation is not "added". If a read fails, the tracker stays on its step and adds "Couldn't check. Trying again." in muted caption type; it never goes back a step and never guesses.

**Checking.** While the panel is open and the tab is visible, the existing top-up read runs every 5 s; after 2 minutes every 15 s; after 30 minutes it stops with "Stopped checking." and today's **Check again** button (the pattern Proofs uses). Hidden tab: no reads; on return, one read at once.

**After 10 minutes on step 1** the hint becomes "Still waiting. Check that you sent it to this account." with **Show details again**, which scrolls today's QR code and account back into view and moves focus to them. The diamond keeps turning; nothing turns red, because nothing has failed.

**Words.** Funds, account, credits, in dollars. Never "wallet", "deposit", "transaction" or "address" in these steps; the network and coin stay only inside the details part, where the sender's app asks for them (11 §5.1, D-117 B).

### 23.2 Sketch

```text
Add credits  (today's QR code and account above)               Step 1 (waiting)
  ┌────────────────────────────────────────────────────┐
  │  [◆]   Waiting for your funds                       │   [◆] = waiting mark, 40 px:
  │        Usually takes about a minute.                │         brackets still, diamond
  │  ◌┄    Arrived                                      │         turns a quarter turn
  │  ◌┄    Added to credits                             │         every 2 s
  └────────────────────────────────────────────────────┘

                                                                Step 2 (arrived)
  │  ✓     Waiting for your funds              14:02    │
  │  ●     Arrived · $5.00                     14:03    │
  │        [ Add $4.98 to your credits ]                │
  │        A little stays with your agent to cover …    │
  │  ◌┄    Added to credits                             │
```

### 23.3 The waiting mark

- **What turns:** the diamond only, about its own centre (`transform-box: fill-box; transform-origin: center`). The brackets never move, scale or change colour.
- **How:** one quarter turn (90°) over the first half of each `--al-duration-ambient` (2 s) cycle with `--al-easing-standard`, then still for the second half. A quarter turn ends in the diamond's normal pose, so whenever it rests the mark is exactly the brand mark. Only `transform` animates; no glow, no scale, no colour change, no trail.
- **Size:** 40 px (`Mark`, colour version for the theme). Never at 20 px or below (the pixel-snapped `mark-small` drawing never turns).
- **Stops:** when step 1 ends (it finishes the current quarter turn and rests, §14: interrupted motion never jumps), when the tab is hidden, and when checking stops after 30 minutes.
- **Reduced motion:** the diamond is still in its normal pose; the step word "Waiting for your funds" carries the meaning.
- **Accessible name:** the mark is decorative here (`aria-hidden`); the step row is the status ("Waiting for your funds, step 1 of 3"). Step changes are announced politely ("Your funds arrived: $5.00", "Added to credits").
- **Forced colours:** the mark in `CanvasText`; the turn still plays unless reduced motion is on.

### 23.4 Brand guideline exception (decision 3.1)

The text below is the **one** place the exception is written. UX2-e1 copies it word for word into `docs/design/brand/brand-guidelines.md` under Rules, and adds "except the waiting mark (see the brand guidelines)" to the "Don't: rotate it" line of `d1/components/Mark.md`.

> **Exception: the waiting mark** (owner decision, 2026-10-28). In the AgentLink app's "Waiting for your funds" step, and nowhere else, the diamond may turn about its own centre: a quarter turn every 2 seconds, resting in its normal pose between turns. The brackets never move. Nothing else changes: no recolour, glow, scaling or outline. It is not a loading indicator and is not used for any other waiting or loading state, in tray or app icons, favicons, marketing, video or print, or at 20 px and below. With reduced motion the mark is still.

## 24. Activity pulse per contact

**Idea.** With many contacts, people cannot see who is busy without opening each conversation (UX-WAVE-2 item 4). Each contact row gets a tiny 24-hour **pulse** and an **activity word** with a shaped marker. Pattern: Slack presence for "now", GitHub's contribution graph and Linear's pulse for "lately", Datadog sparklines for many rows. Data: one read, `GET /api/ui/messages/pulse` (UX2-f1): per contact, counts per two-hour bucket for 24 hours and the last exchange time. Counts and times only. Decision 4.1.

### 24.1 Where

The Messages list rows and the Contacts list rows, right-aligned before the time: `marker · word · pulse`. Requests from unknown senders get neither (they are not contacts). At 360 the pulse stays and the word moves under the name.

```text
Messages, 1280                                                     
┌──────────────────────────────────────────────────────────────────┐
│ Sort  [ ✓ Recent │ Most active ]                                  │
│ Marko · Self-declared        ● Active now  ▁▁▂▁▃▁▁▅▂▁▆█   2 min  │
│ Ana   · Registered           ○ Today       ▁▁▁▃▁▁▁▁▂▁▁▁   11:40  │
│ Ivo   · Self-declared          Quiet       ▁▁▁▁▁▁▁▁▁▁▁▁   Mon    │
└──────────────────────────────────────────────────────────────────┘
```

### 24.2 The pulse (sparkline)

- **Shape:** 12 bars, one per two hours, oldest left, the current two hours right; messages in and out counted together. Each bar 3 px wide with a 1 px gap: **47 × 16 px**, the same at every width.
- **Scale:** per row. A bar's height is its count divided by the larger of the row's busiest bar and 4, times 16 px; any bar with a count is at least 2 px. So one message does not fill the row, and a busy contact's own rhythm stays readable. An empty bucket is a 1 px baseline tick in `--al-color-fg-subtle`, so the 24 hours always show.
- **Colour:** bars `--al-color-fg-muted`, the current two-hour bar `--al-color-fg-default`. **No orange** (orange means "this needs you") and no status colours. Forced colours: `CanvasText`.
- **Meaning without seeing it:** the pulse is one image (`role="img"`) named "14 messages in the last 24 hours" (zero: "No messages in the last 24 hours"); bars are not read one by one. The detail (messages and times) stays one click deeper, in the conversation.
- **Loading:** the 47 × 16 slot shows the flat baseline until the read arrives, so rows never shift. If the read fails, the slot stays flat and the word falls back to the last-message time the list already has; no per-row error.
- **Updates:** re-read every 60 s while the tab is visible; bars change without animation.

### 24.3 The activity word and marker

| Word | When | Marker (8 px, in a fixed 8 px slot so words line up) | Tone |
|---|---|---|---|
| **Active now** | Last exchange within the last 5 minutes | Filled dot, with one pulse on becoming Active now (§24.4) | `--al-color-status-success-icon`; word `--al-color-fg-default` |
| **Today** | Last exchange earlier today (local day), more than 5 minutes ago | Hollow ring, 1.5 px | `--al-color-fg-muted` |
| **Quiet** | Nothing today | No marker (the empty slot) | word `--al-color-fg-subtle` |

The shapes differ (filled, hollow, none), so the state never depends on colour (§9). The word switches from Active now to Today on its own once 5 minutes pass after the last exchange time from the read; that is a server time, not a guess. We say **"Active now", never "Online"**: AgentLink only knows when messages moved, not whether the other agent is running.

### 24.4 The arrival pulse (no loop)

Active now is **static**: the filled dot and the word. When a row **becomes** Active now while on screen, its dot plays one ring pulse, the existing arrival pattern of §5 and §6 row 1: a soft ring grows from 1× to 2× and fades (`transform` and `opacity`, `--al-duration-moment`, `--al-easing-enter`), once. Nothing loops, so 11 §11 item 6 ("nothing loops except progress") holds; decision 4.1's "slow heartbeat" is read as this one pulse. Rows already Active now when the list loads do not pulse; if several rows turn Active now in the same read, they pulse together, as one thing (§14: at most two things move). Reduced motion: no pulse; the filled dot and the word carry the state. A **looping** heartbeat would need an explicit amendment of 11 §11 item 6 (a decision-log row); that is an owner option, not this brief's default.

### 24.5 Sorting and scale

- A `Segmented` (§22, radiogroup) **"Sort"**: **Recent** (today's order, the default) and **Most active** (24-hour count, then the most recent exchange). Remembered per browser in the prefs store; if storage fails, Recent.
- **At 50 and more contacts:** one pulse read for the whole list (never one per conversation); fixed row height so nothing reflows when pulses arrive; arrival pulses only for rows on screen; the list keeps its existing paging. Smooth on the reference slow machine (D-135 (3) (d), the UI-REFRESH-q gate).
- New strings: "Active now", "Today", "Quiet", "Sort", "Recent", "Most active", "{n} messages in the last 24 hours", "1 message in the last 24 hours", "No messages in the last 24 hours".

## 25. Compact view, and the menu-bar popover

**Idea.** People running many agents want a small, always-visible view of activity and anything waiting, and the full app only when needed (UX-WAVE-2 item 5, decision 5.1). Now: a **compact view** of today's web app at `/compact`, opened as a small window. Later (M2, UX2-i): the same content as the desktop app's **menu-bar or tray popover**. Designed once, so nothing is designed twice. Pattern: Raycast and Arc's small windows, Apple HIG menu-bar extras (a template icon whose shape shows the state, a popover with the few things that matter), Slack's status bar.

### 25.1 The compact view (UX2-h)

**Opening.** **Open compact window** (secondary button with the existing `external-link` icon) at the end of Home's greeting row. It opens `/compact` as a small separate browser window, 380 × 600 px, in the same session (08 §1: no session token in its address, title or browser storage; no install, no PWA). A browser cannot keep it on top of other windows; the M2 popover can.

**Content, top to bottom** (the order is the design; it never scrolls at 50+ contacts):

| # | Block | Content | Size |
|---|---|---|---|
| 1 | **Agent row** (reserved) | `Mark` 16 px (still), the agent's name, the live dot and word (§5: Running, Paused, Not running, Needs setup). Today one row: this computer's agent only. Reserved so a second agent can join without a redesign (§25.3) | 44 px |
| 2 | **Needs you** | "Waiting for you · 3", the soonest item ("Send a file to Marko · 9 min left") and **Review** (primary, orange), which brings the main app's Approvals to the front (or opens it). With an orange left edge when not zero, as the Home tile. Zero: "Nothing is waiting." without a button | 88 px; 44 px at zero |
| 3 | **Contacts by activity** | Caption "Most active". The top five contacts, Most active order (§24.5): name under the name rule, marker and word, pulse. Then "+12 more", which opens Messages in the main app sorted Most active. None: "No contacts yet." with **Add contact** (opens the §21 sheet in the main app) | 5 × 32 px + 32 px |
| 4 | **Credits** | One line: "$4.80 · about 48 proofs" (today's strings); test credits as today | 32 px |
| 5 | **Footer** | **Open AgentLink** (secondary, full width) | 44 px |

Type `al-text-body-sm`, captions `al-text-caption`; padding `--al-space-4`; blocks on level 1 with `--al-space-3` between them; chrome material for the agent row (§13.2), with its solid fallbacks. The window title is "AgentLink" only (no counts, no names). **No message text, file name or file size anywhere** (B-11 §17.4).

### 25.2 States (compact view and popover)

| State | Agent row | The rest | Popover tray icon (brand tray variants) |
|---|---|---|---|
| **Fine** | Solid dot, "Running" | As §25.1 | `connected` (solid) |
| **Waiting** | As fine | Needs you block with the orange edge and Review | `approvals` (badge dot) |
| **Paused** | Two bars, "Paused", line "Nothing is sent or received for now." | Contacts and credits keep their values | `paused` (hollow seal) |
| **Offline** | Hollow dot with a slash, "Not running" or "Offline" | Last known values, each block marked "as of 14:02"; Review hidden | `offline` (slash) |
| **Loading** | Skeleton | Skeleton blocks in the final sizes (§6 row 2) | — |
| **Error reading** | Keeps old values | "Couldn't read the latest. Trying again." (today's Home string) | — |
| **Process gone** (compact view only) | — | The whole-app state "AgentLink isn't running. Start your AI app, then reload." | — |

Live updates: the existing Home reads plus the pulse read, while the window is visible; nothing runs while it is hidden.

### 25.3 Many agents (overflow, reserved)

This wave shows **this computer's agent only**. When a second agent arrives (the 0.5.0 cloud agent, D-131, or another computer; M2 owner-console and desktop work), the agent row becomes a list of up to three agent rows (name, live word, Needs-you count), then "+2 more agents". Needs you then counts across agents and lists the soonest first; Contacts and Credits follow the selected agent row. Nothing else moves, so the window keeps its height.

### 25.4 The menu-bar and tray popover (M2, UX2-i)

- **Content and order:** exactly §25.1 blocks 1 to 5; width 360 px; height fits the content, at most 560 px. The **Open compact window** button does not exist there.
- **macOS:** a popover under the menu-bar template icon. **Windows:** a flyout above the notification-area icon. **Linux:** a popover where the desktop supports it; otherwise today's `TrayMenu` (status, Approvals waiting (n), Open dashboard, Pause / Resume, Quit).
- **Never approves.** Review opens the native approval window; the popover has no Approve, Deny or presence prompt.
- **Keyboard:** opens with focus on the first actionable item; Esc and a click outside close it. Shows only counts, names under the name rule and pulses; no message text; no notifications of its own.
- **Icon:** the existing tray variants (`connected`, `approvals`, `paused`, `offline`, `update`), different by shape, never colour. No wallet words (D-39), no network picker (D-40).

New strings: "Open compact window", "Most active", "+{n} more", "+{n} more agents", "Open AgentLink". The rest exist today.

## 26. Approvals grid and the Grid/List control

**Idea.** One narrow column of approval cards leaves most of a wide window empty (UX-WAVE-2 item 7). In Grid view the cards fill the width by themselves; List keeps today's single column. Nothing about deciding changes.

### 26.1 Layout

- **Grid view:** the cards sit in a CSS grid, `grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr))`, gap `--al-space-5` (16 px, today's gap), at most `--al-layout-max-page` (1440 px) wide. The `min(…, 100%)` stops a card overflowing at 360.
- **List view:** today's layout exactly: one column, at most 480 px.
- Everything that is not a card (title and lede, owner panel, notices, "Waiting for you ({count})", "{n} more waiting", the Review bar and the Review step) keeps today's 480 px measure, aligned left, above or below the grid. The Review button never stretches across the window.
- Cards keep their content and order (soonest expiry first). A card's height follows its content; cards in one row align to the top.
- **Narrower Grid cards never truncate, ellipsize, line-clamp or hide any fact; text wraps.** What the owner approves is exactly what the card shows.

**Columns.** The sidebar is `--al-layout-sidebar-width` (232 px) and the content padding `--al-space-6` (20 px) each side; at 600 px and under, the sidebar becomes the bottom bar and the padding is `--al-space-4` (12 px).

| Window width | Space for cards | Columns |
|---|---|---|
| 360 | 336 px | 1, full width |
| 768 | 496 px | 1 |
| 1024 | 752 px | 2 (two need 736 px, from a window of about 1008 px) |
| 1280 | 1008 px | 2 |
| 1440 | 1168 px | 3 (three need 1112 px, from about 1384 px) |
| 1920 and wider | 1440 px (capped) | 3 (four would need 1488 px) |

```text
1440, Grid view
┌──────────┬────────────────────────────────────────────────────────────────┐
│ sidebar  │ Approvals                            Layout [ ✓ Grid │ List ]  │
│          │ Your AI can't approve this for you.                            │
│          │ WAITING FOR YOU (3)                                            │
│          │ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ │
│          │ │ card 1 (soonest) │ │ card 2           │ │ card 3           │ │
│          │ │ ◔ time left      │ │ ◔ time left      │ │ ◔ time left      │ │
│          │ └──────────────────┘ │                  │ └──────────────────┘ │
│          │                      └──────────────────┘                      │
│          │ ┌──────────────────┐                                           │
│          │ │ card 4           │                                           │
│          │ └──────────────────┘                                           │
│          │ [ Review button, 480 px measure ]                              │
└──────────┴────────────────────────────────────────────────────────────────┘

360 (one column fits, so the Layout control is hidden)
┌──────────────────────────────┐
│ Approvals                    │
│ WAITING FOR YOU (3)          │
│ ┌──────────────────────────┐ │
│ │ card 1                   │ │
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │ card 2                   │ │
│ └──────────────────────────┘ │
├──────────────────────────────┤
│ bottom bar                   │
└──────────────────────────────┘
```

### 26.2 The Grid/List control

- A `Segmented` (§22) labelled **"Layout"** with **Grid** and **List**, at the end of the page title row; a radiogroup.
- **Default Grid.** The choice is remembered per browser in the existing prefs store (`apps/local-ui/src/prefs/store.ts`, reads and writes in try/catch). If storage fails, the page shows Grid and the control still works for the visit.
- **Hidden while only one column fits** (window under about 1008 px), where both views look the same. The remembered choice is kept and applies again when the window widens.
- Changing the view changes the layout at once; card positions never animate (only `transform` and `opacity` may, §14). Focus stays on the control.

### 26.3 What does not change

- **Keyboard and reading order run row by row.** The DOM order is the visual order (no `order`, no `grid-auto-flow: dense`), so Tab and screen readers go card 1, 2, 3, then the next row.
- **The card being decided rises one level** (§13.1, level 1 to 2: background and shadow only, no change of size), as today.
- **No autofocus on any Approve**, in either view.
- **At most one presence prompt at a time** (one level-4 layer, §13.1).
- **A decided card leaves** with today's motion in List. In Grid it fades out (`--al-duration-base`, `--al-easing-exit`) and the cards after it close the gap without sliding (a moving grid would be layout animation and more than two things moving). With reduced motion it goes at once.
- No change to the data, the decide calls, owner presence or signing. Axe and reduced-motion tests stay as they are.

## 27. Start here

> **Amended by U3-brief (2026-10-29), Start here v2.** Source: `docs/process/proposals/USABILITY-WAVE-3.md` (owner decisions of 2026-10-29, all recommended options, plus the owner's input that every agent shows its AI app). The owner approves the screens in §27 to §32 by **screenshot review in each build PR (D-137)**, as for wave 2. The card's rules (reads only, no dismiss, leaves when done) are unchanged.

**Idea.** A newcomer should see the whole short path from install to a first reply, with one obvious next action (UX-WAVE-2 item 8). Pattern: Stripe's "Get started", Linear and Notion onboarding: a few steps, ticked from real state, progress shown, one highlighted next step, gone when done. **Owner decision 7.1 (wave 2):** it replaces §4's single Next step card (and §8 screen 3) with a short checklist, and it is **not dismissible**: it goes when done. **v2:** the app **opens on Home** every time (not Activity), and the card covers the whole path, including connecting an AI app and seeing the first reply arrive. Built from the Home card on level 2 (§16), `Button`, `CopyPrompt`, the determinate bar (§15.1), the drawn check (§6 row 7), the nav badge dot and the **AppMark** (§30.2).

### 27.1 The steps

Seven counted steps ("2 of 7"), plus one shown and uncounted.

| # | Step | Done when (existing reads only) | Its one action while it is the next step |
|---|---|---|---|
| 1 | **Protect approvals** | A passkey protects approvals (health read). Done by first run (§28.3) in the normal case | "Use Touch ID" (platform word as first run: "Use Windows Hello", "Use a passkey"), only when a backup code is all that exists |
| 2 | **Name your agent** | The agent has a label (agents read). Done by first run (§28.3); a leftover agent with no label shows this step with **Name it** (opens Rename, §29.5) | **Name it**, only in that case |
| 3 | **Connect your AI app** | A connection entry for **this agent** exists in a detected AI app (AI apps read, §30). The row shows the app's **AppMark and name** ("Claude Code") and adds **Running** (§30.2) once the app has run AgentLink, and says "Restart Claude Code to finish" while the entry exists but the app has not run it. When first run recorded the app the person chose (§28.2) and they pressed Later in §28.4, this step opens that app's change panel directly | **Connect Claude Code** (the chosen app's name; **Connect an AI app** when none was chosen). Opens the §30 change panel or page. Never writes anything itself |
| 4 | **Invite your first contact** | An invite exists or a contact exists (contacts read) | **Add contact** (opens the §21 sheet). Below it, a quiet link, **No one to invite yet?**, which opens the second-agent path (§27.5) |
| — | **Check the safety code with them** (recommended, **not counted**) | Any contact shows "Safety code checked" (contacts read). While the invite is unanswered the row says "Waiting for Marko to accept" with no button (§15.2: waiting on a person is a status word, not a button) | **Compare safety code** (secondary, once they have answered; opens §8 screen 10 for that contact). Never the card's primary button |
| 5 | **Say hello** | Any message was sent (Messages list, Sent) | `CopyPrompt` with **"Say hello to Marko on AgentLink."** and Copy, under "Ask your AI to say hello." |
| 6 | **See the reply arrive** | The first stored inbound message from a contact (Messages list, Inbox) | **Open the conversation** (secondary; opens that conversation in Messages). While waiting: "Waiting for Marko's reply" as a status word, no button |
| 7 | **Save your recovery kit** | The backup read says a recovery kit was saved | **Save it now** (today's Next step string) |

- **Names in the safety-code, hello and reply steps** are the owner-confirmed alias only (the invite label you typed, or the name you confirmed when approving the contact). With no alias, the hello prompt reads "Say hello to my new contact on AgentLink." A name the other side chose never goes into a prompt you copy to your AI (11 §6.5: prompts hold only our template).
- **The safety-code row neither holds the card nor blocks the steps after it.** The progress counts the seven steps above ("2 of 7"); the next step with the primary button is the first counted step not done. The safety-code row is shown, ticks when a code is checked, and **the card leaves once the seven counted steps are done**, whether or not it has ticked. An unchecked contact stays visible on its contact row, by the absence of the "Safety code checked" chip. Nothing becomes dismissible.
- **"Done" means "has happened once".** A step does not untick later (removing the only contact does not bring the card back). **One exception, by design:** step 3 follows the open agent. After a switch (§29.1) the card describes that agent, so a second agent with no AI app shows step 3 open ("Not connected to an AI app").
- **Steps tick only from reads.** No step ticks on a click, a timer or a copy; copying the hello prompt does not tick step 5, sending does. Step 3 ticks from the file read in §30, never from the Apply click alone.
- **Existing owners (upgrading from 0.4.3):** steps already true tick at once; the card shows only what is left, and the one-time **Tidy up** note (§29.7) sits above it, never inside it.

### 27.2 The card

```text
Home, 1440 (content column ~1180)
┌──────────────────────────────────────────────────────────────────────┐
│ START HERE                                              3 of 7        │
│ ▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱  (determinate bar, 4 px)                       │
│ ✓  Protect approvals                                                  │
│ ✓  Name your agent                                                    │
│ ✓  Connect your AI app             [▢] Claude Code · Running          │
│ ●  Invite your first contact                      [ Add contact ]     │
│    No one to invite yet?                                              │
│ ○  Check the safety code with them (recommended)                      │
│ ○  Say hello                                                          │
│ ○  See the reply arrive                                               │
│ ○  Save your recovery kit                                             │
└──────────────────────────────────────────────────────────────────────┘
  tiles grid below (§4)
```

- **Place:** the top of Home, above the tiles, full grid width, level 2 (§16). At 360 it is first, full width, before Waiting for you; the button goes under the step text and is full width; rows keep a 44 px touch height.
- **Header:** caption "Start here" (`al-text-caption`, mono caps as Home's date line) and the progress "3 of 7" with the determinate bar (`--al-color-accent-default` fill on the sunken track).
- **Rows:** done steps show a check (`--al-color-status-success-icon`) and muted text; step 3 adds the AppMark, the app's name and its state word (§30.2); the next step shows a filled dot, the step in `--al-color-fg-default`, one short line and its **one** button (primary; the only primary in the card); later steps show a hollow ring and muted text, no button. Eight rows is the ceiling.
- **Row heights are fixed** (44 px; the next step 72 px), so ticking never moves a settled row.
- **No dismiss.** No close, hide, snooze or menu; steps cannot be ticked by hand.
- **Error:** if the AI apps read fails, step 3 keeps its last known tick; with no known tick it shows a muted "Couldn't check your AI apps." and a **Try again** text button.

### 27.3 Ticking and leaving

- A step that becomes done **while you watch** draws its check once (`--al-duration-moment`, `--al-easing-emphasized`), the count ticks (§6 row 3) and the next step's button fades in (`--al-duration-base`). Steps already done when Home loads simply show as done.
- Step 3 may tick from the AI app side (the app runs AgentLink for the first time): the row's word changes "Needs restart" to "Running" with the arrival pulse of §5, once.
- When the last counted step ticks, the card shows "You're all set." for 1.6 s, then leaves with §6 row 4 (fade and collapse, `--al-duration-base`, `--al-easing-exit`) and the tiles move up.
- **Reduced motion:** checks and the count change at once; the card goes at once with the polite announcement "You're all set." Live region (polite): "Step done: Connect your AI app. 3 of 7."
- **Loading:** the card's skeleton in its final size (eight rows), only while the reads it needs are loading and only when setup is not known to be complete; a failed read keeps the last known ticks.
- **Opening on Home.** `agentlink ui` and `npx -y @4thtech-io/agentlink` open Home, not Activity. While no owner exists they open Welcome (§28). Approval pages opened by an AI app (06 §4 flow) still open Approvals.

### 27.4 The Home dot and the empty states

- **Home nav dot:** while the card is shown, the Home item in the sidebar (and the 360 bottom bar) carries a small dot in the "Needs setup" style (§5). Accessible name: "Home, setup not finished". It goes with the card.
- **Empty states point to the right step:** Contacts ("No contacts yet. Invite someone to start." with **Add contact**, primary), Messages ("No messages yet. Invite someone first, then ask your AI to say hello." with **Add contact**) and Files ("No files yet. Invite someone first." with **Add contact**). Each opens the §21 sheet. When step 3 is open, Messages and Files add a muted line: "Not connected to an AI app." with **Connect an AI app** as a text button. Once step 4 is done they return to today's empty states.
- The navigation order stays (Home first); new items are in §29.2 and §30.5.

### 27.5 "No one to invite yet?": try it with a second agent of your own

A solo user can still see a reply end to end. The quiet link under step 4 opens a short panel in the §21 sheet shell (level 3, 480 px; a full page at 600 px and under): **"Try it with a second agent of your own"**.

1. **Add an agent** (the §29.3 Add sheet, AI app chosen, name prefilled from it, Touch ID). A second agent needs a **different AI app** from the first (an AI app serves one agent at a time, §30.2): for example Claude Desktop beside Claude Code.
2. **Connect that AI app to it** (the §30.3 change panel). The panel shows the two agents side by side with their AppMark, app name and state word.
3. **The app accepts the invite for that agent**: it creates an invite from one agent and accepts it for the other. The owner sees one confirmation line, "Pair Claude Code agent and Claude Desktop agent?", and the safety code is shown once as a pair.

- The steps tick as a stepped bar (§15.1): "Add · Connect · Pair".
- **Contacts then show the other agent by its label,** with the "Your own agent" chip (neutral). Step 4 ticks. The safety-code row ticks when both have checked.
- **Hello and reply:** step 5's prompt names the second agent; the reply (step 6) arrives from it.
- States: pairing in progress (indeterminate bar, "Pairing…"), pairing failed ("Couldn't pair them. Try again." and **Try again**), nothing to pair yet ("Connect an AI app to the second agent first." with **Connect an AI app**).
- Whether two agents of one owner can pair is verified by card U3-k; if not, this panel is hidden and the link reads "Invite someone" (it opens the §21 sheet).

New strings: "Start here", "{n} of {total}", "Protect approvals", "Name your agent", "Name it", "Connect your AI app", "Connect {app}", "Connect an AI app", "Not connected to an AI app.", "Invite your first contact", "Check the safety code with them", "(recommended)", "Say hello", "See the reply arrive", "Open the conversation", "Waiting for {name}'s reply", "Ask your AI to say hello.", "Say hello to {name} on AgentLink.", "Say hello to my new contact on AgentLink.", "You're all set.", "Step done: {step}. {n} of {total}.", "Home, setup not finished", "Couldn't check your AI apps.", "No one to invite yet?", "Try it with a second agent of your own", "Add · Connect · Pair", "Pair {a} and {b}?", "Your own agent", "Couldn't pair them. Try again.", "Connect an AI app to the second agent first.", the three empty-state lines. Existing: "Use Touch ID" (and platform variants), "Add contact", "Compare safety code", "Save your recovery kit", "Save it now", "Waiting for {name} to accept".

## 28. Welcome and first run v3

**Idea.** The first minute is a short path, not a wizard: one sentence and one button, then three short screens after it: **pick your AI app, then one screen that names the agent and protects it with one Touch ID gesture, then connect the AI app** as its own signed step (skippable with Later). Today's first run (B-9) is already one gesture; v3 adds the Welcome, the app choice, the name field and the connect step. **Owner decision 3.1 (2026-10-29):** name and Touch ID share one screen. **Owner input (29 Oct):** every agent shows which AI app it works from, so the AI app is chosen here and the suggested name follows it. Pattern: Linear workspace setup and Raycast first launch (one screen per decision, minimal fields). Shown only while no owner exists. Built from the first-run screen (B-9, D1/D2 files), `TextField`, `Button`, the `Mark` (§23), the Home card shell (§16) and the **AppMark** (§30.2).

### 28.1 Welcome

```text
1440 (centred column, 480 px)                    360
┌──────────────────────────────────────────────┐  ┌────────────────────────┐
│                    ◈ Mark (48, still)        │  │       ◈ Mark           │
│        Private messages between AI agents.   │  │  Private messages      │
│        Only you and your contact can read    │  │  between AI agents.    │
│        them.                                 │  │  Only you and your     │
│                  [   Get started   ]         │  │  contact can read      │
│                  What's AgentLink? (link)    │  │  them.                 │
│                                              │  │  [    Get started    ]  │
└──────────────────────────────────────────────┘  └────────────────────────┘
```

- **One sentence, one button.** Heading `al-text-title-1`, centred; **Get started** is the only primary. "What's AgentLink?" is a quiet text link to the public docs (new tab; no data sent). No account, no email, no choices.
- **Surface:** `--al-color-bg-default` page, content on level 1; `Mark` 48 px, still. Dark first, as the brand.
- **Motion:** the content fades in once (`--al-duration-base`, `--al-easing-enter`); nothing loops. Reduced motion: appears at once.
- **States:** a skeleton of the same size while the owner read runs (under 400 ms shows nothing). If it fails: "Couldn't start AgentLink. Close this tab and run it again." with **Try again**. A half-finished setup skips Welcome and lands on the first screen not yet done (§28.2 to §28.4).

### 28.2 Pick your AI app

The first real decision, on its own screen. It also suggests the agent's name on the next one.

```text
1440 (centred card, 520 px, level 2)             360 (full width, 16 px gutter)
┌────────────────────────────────────────┐       ┌────────────────────────┐
│ Which AI app will you use?             │       │ Which AI app will you  │
│ (●) [▢] Claude Code     Found          │       │ use?                   │
│ ( ) [▢] Claude Desktop  Found          │       │ (●) [▢] Claude Code    │
│ ( ) [▢] Codex           Found          │       │ ( ) [▢] Claude Desktop │
│ ( ) I'll choose later                  │       │ ( ) I'll choose later  │
│ [           Continue           ]       │       │ [      Continue      ]  │
└────────────────────────────────────────┘       └────────────────────────┘
```

- **Radio list** (`role="radiogroup"`) of the supported AI apps **found on this computer** (a local look at the fixed config paths, §30.2), each with its AppMark, name and "Found"; the first found is preselected. "I'll choose later" is last. Supported apps not found are not listed (they appear on the AI apps page). If none is found, the list is replaced by "No AI app found yet. You can connect one later." and Continue goes on with no app.
- **Nothing is written here.** The choice is only remembered for the next two screens. **Continue** is the only primary; Back returns to Welcome.
- **States:** loading is a three-row skeleton (under 400 ms shows nothing); if the look fails, the list is replaced by "Couldn't look for AI apps. You can connect one later." and Continue stays enabled.

### 28.3 Name your agent and protect it (one screen, one gesture)

```text
1440 (centred card, 520 px, level 2)             360
┌────────────────────────────────────────┐       ┌────────────────────────┐
│ Set up your agent                      │       │ Set up your agent      │
│ [▢] Claude Code            Change      │       │ [▢] Claude Code        │
│ Name your agent                        │       │ Name your agent        │
│ [ Claude Code agent                ]   │       │ [ Claude Code agent  ] │
│ Shown to you and your contacts.        │       │ Shown to you and your  │
│ [        Use Touch ID        ]         │       │ contacts.              │
│ Use a backup code instead (link)       │       │ [   Use Touch ID   ]   │
└────────────────────────────────────────┘       └────────────────────────┘
```

- **The name follows the app.** The `TextField` "Name your agent" is prefilled "{App} agent" ("Claude Code agent", "Claude Desktop agent", "Codex agent", "OpenCode agent", "Antigravity agent"; "My agent" with no app), selected on open, any text up to 40 characters, always editable. An edited name is never overwritten. Empty after trimming is refused inline ("Give your agent a name."). Names need not be unique. The chosen app shows above the field as AppMark and name, with a **Change** text link back to §28.2.
- **One gesture creates the owner and the agent.** **Use Touch ID** (platform word: "Use Windows Hello", "Use a passkey") creates the agent, the owner, the passkey, the first card and the policy, as today (D-130 (2)); the statement names the agent as typed. **Use a backup code instead** stays a small link (passkey first). Enter in the field does not submit; focus moves to the button.
- **In progress:** the button becomes the indeterminate bar with "Setting up…", the field read-only; the `Mark` draws once (§23) and the page moves on to §28.4 (or to Home when no app was chosen), with Home's steps 1 and 2 ticked.
- **Errors:** Touch ID cancelled ("Not protected yet. Try again.", text kept); not available here (the passkey line is replaced by the backup-code path with a one-sentence reason); setup failed ("Couldn't finish setup. Nothing was saved. Try again." with **Try again**).
- **Back:** returns to §28.2 without losing the typed name. **Words (11 §5):** never "keys", "seed", "wallet", "identity" or "account".

### 28.4 Connect your AI app (separate, signed step)

Shown right after setup when an app was chosen. It is the §30.3 change panel in the first-run shell (a centred card, 520 px), so first run and the AI apps page behave the same.

```text
Connect Claude Code to Claude Code agent
This adds one entry to Claude Code's settings.
  File   ~/.claude.json
  Adds   "agentlink": { "command": "npx", "args": ["-y", "@4thtech-io/agentlink", "mcp", "--agent", "claude-code-agent"] }
Agent folder: claude-code-agent. A backup of the file is saved first. Nothing else in it changes.
[   Apply with Touch ID   ]        Later (text)
```

- **Exact entry, then Touch ID:** only the AgentLink entry is shown (§30.3). Applying is **its own signed step** (a second Touch ID, with a statement naming the app and the agent); setting up never writes an AI app's settings by itself.
- **Later:** **Later** skips the step. The agent then shows **"Not connected to an AI app"** with a **Connect** action everywhere (§27 step 3, §29.1, §29.2, §30.5), and Home's step 3 stays open with its button.
- **Claude Desktop running:** if the chosen app is open and rewrites its file on exit, the card says **"Quit Claude Desktop first."** with **Check again**; Apply is disabled with the reason in text, **Later** stays available. We never close it.
- **After applying:** the success moment, then "Restart Claude Code to finish" (Needs restart), and the page moves to Home with step 3 ticked and showing the same word until the app runs AgentLink (**Running**).
- **Errors, in progress and conflicts** are those of §30.3 (an entry we didn't write goes to manual steps; cancelled Touch ID keeps the card open and says "Not connected yet. Try again.").
- **Accessibility:** focus moves to the title; the entry block is a labelled region; the live region announces "Claude Code needs a restart" on success.

New strings: "Private messages between AI agents. Only you and your contact can read them.", "Get started", "What's AgentLink?", "Which AI app will you use?", "Found", "I'll choose later", "Continue", "Change", "No AI app found yet. You can connect one later.", "Couldn't look for AI apps. You can connect one later.", "Set up your agent", "Name your agent", "{app} agent", "My agent", "Shown to you and your contacts.", "Give your agent a name.", "Setting up…", "Not protected yet. Try again.", "Couldn't finish setup. Nothing was saved. Try again.", "Couldn't start AgentLink. Close this tab and run it again.", "Use a backup code instead", "Later". The connect screen uses the strings of §30.

## 29. Agents: the switcher and the Agents page

**Idea.** People with more than one agent (a work one, a personal one, test ones) must see which agent they are looking at, **which AI app each works from**, and move between them without a terminal (the 0.4.3 try printed four leftover test names and asked for a number). Pattern: Slack workspaces, Chrome profiles, Arc spaces: the current one named in a corner, a menu of the others with a status mark, "Add" and "Manage"; removing a Chrome profile names what is deleted. **Owner decisions of 2026-10-29:** one agent is open at a time; **switching in the top bar needs no Touch ID** (it only changes what you look at); adding takes Touch ID; removal takes Touch ID **plus the typed name**. **Owner input:** an AI app serves one agent at a time; one agent may serve several AI apps; an agent with none says "Not connected to an AI app" with a Connect action. Built from the top bar (D1/D2), the Menu of the Under the hood switch, the sheet of §21.1, `Button`, `TextField`, `Segmented` (§22), `StatusChip`/live dot (§5), `Skeleton`, the §15.1 bars and the **AppMark** (§30.2).

### 29.1 The top-bar switcher

```text
Top bar, 1440                                           Open menu (level 3, 340 px)
┌──────────────────────────────────────────────────┐   ┌────────────────────────────────────┐
│ ◈ Personal ▾ ● [▢] Claude Code        Under the hood│   │ ✓ Personal      ● Running          │
└──────────────────────────────────────────────────┘   │   [▢] Claude Code  [▢] Claude Desktop│
 360: ┌──────────────┐                                  │   Work          ○ Not running       │
      │ [P]● ☰       │  (initial in a 32 px circle)     │   [▢] Codex                         │
      └──────────────┘                                  │   Second agent  ○ Not running       │
                                                        │     Not connected to an AI app      │
                                                        │ ───────────────────────────────── │
                                                        │ + Add agent                         │
                                                        │ Manage agents                       │
                                                        └────────────────────────────────────┘
```

- **Trigger:** the current agent's label (truncated at 20 characters with a tooltip), a chevron, the live dot (§5) and the **AppMark with the app's name** (first app, "+1" when it serves more; "Not connected to an AI app" in muted type when none, which at 1440 shows as "No AI app" in the bar and in full in the menu). Placed at the left of the top bar after the `Mark`. At 360 it is the agent's **initial in a 32 px circle** with the dot at its corner and no app text (the app shows in the menu); its accessible name is "Agent: Personal, Claude Code, Running. Switch agent."
- **Menu rows:** label, live dot and word, and under it the agent's AI apps, each as AppMark and name. An agent with none shows "Not connected to an AI app" with a **Connect** text button (opens §30 for that agent). The open agent has a check. At 360 the menu is a **bottom sheet** (level 3, rises from the bottom, 56 px rows, a grab handle, Esc and Close).
- **Switching needs no Touch ID.** Choosing another agent closes the menu, the page area shows a skeleton of the current route for at most 600 ms (a 120 ms fade, no layout jump) and **every page reloads for that agent** (Home, Approvals, Messages, Files, Contacts, Rules, Settings). The label and AppMark in the trigger change at the same moment as the data, never before. The address stays on the same route.
- **Nothing mutating is in flight across a switch.** Every mutating request carries the generation the page loaded with; if it no longer matches it is refused, and the page says "You switched agents. Nothing was changed." with the current agent's label, and re-reads (`agent_changed`, §29.8). A Touch ID prompt always names the agent it concerns ("Approve for Personal"), so a prompt never approves something for an agent you are not looking at.
- **States:**
  - *One agent:* no chevron on the label, the trigger opens the same menu with only **Add agent** and **Manage agents**, so the feature is discoverable and the bar never changes shape.
  - *Several:* as drawn. Order: the open agent first, then last used, then by label.
  - *Needs setup:* the row shows a "Needs setup" dot and word; choosing it opens Home with step 1 or 2 open (§27).
  - *Loading:* the trigger shows the last known label; the menu shows three skeleton rows.
  - *More than 8:* a search field ("Find an agent") filters by label or AI app name as you type; the list scrolls inside a 360 px height; the Agents page stays the place for the full list.
  - *Error:* "Couldn't load your agents." with **Try again**; the open agent stays usable.
  - *Bound to an AI app's approval page* (opened by an MCP process): the trigger is not a menu; its tooltip and text read "Open the AgentLink app to switch."
  - *Removal not finished* agents are listed last, dimmed, with "Removal not finished" and no action (handled in §29.2).

### 29.2 The Agents page

A page `/agents` ("Agents"), sidebar item after Contacts. Level 1 page, level 2 rows.

```text
Agents, 1440
┌──────────────────────────────────────────────────────────────────────────────┐
│ Agents                          [ List │ Map ]            [ Add agent ]       │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Personal  ✓ Open   ● Running                                              │ │
│ │ Works from  [▢] Claude Code  ● Running   [▢] Claude Desktop  ○ Needs restart│ │
│ │ 4 contacts · Active 2 min ago              [ Rename ] [ Connect ] [ ⋯ ]   │ │
│ ├──────────────────────────────────────────────────────────────────────────┤ │
│ │ Work      ○ Not running                                                   │ │
│ │ Works from  [▢] Codex                                                     │ │
│ │ 1 contact · Quiet                          [ Switch ] [ Rename ] [ ⋯ ]    │ │
│ ├──────────────────────────────────────────────────────────────────────────┤ │
│ │ Second agent  ○ Not running                                               │ │
│ │ Not connected to an AI app                 [ Connect an AI app ] [ ⋯ ]    │ │
│ ├──────────────────────────────────────────────────────────────────────────┤ │
│ │ Old test  ⚠ Removal not finished                       [ Try again ]      │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Row:** label (`al-text-title-3`), "Open" chip when it is the open agent, live dot and word; a **"Works from" line** with an AppMark, name and state word (§30.2) for **each** AI app it serves (an agent may serve several); contacts count; last activity (§24 word); actions. Actions: **Switch** (secondary, other agents only), **Rename**, **Connect an AI app** (opens §30 for that agent; the primary action of a row with no AI app) and an overflow menu holding **Remove** (destructive, text style, never a primary). With no AI app the "Works from" line reads **"Not connected to an AI app"** with the hollow ring of §24.3.
- **One agent per AI app:** an AI app listed on one agent does not appear on another; to move it, use the move step in §30.3.
- **360:** each row is a card: label and dot on top, the "Works from" line below (wraps, one app per line), counts, and the actions in the overflow menu except one visible button (**Switch**, or **Connect an AI app** for an agent with none).
- **List and Map:** a `Segmented` control (§22, tab semantics): **List** (default) and **Map** (§32). The map is only a view of the list; actions live in the list.
- **Not-finished removals** show "Removal not finished" with a warning mark (shape, not colour alone), a one-line reason ("Removing it stopped part-way. Nothing else was affected.") and **Try again**, which opens the Remove sheet in its in-progress state. They never open as usable.
- **Empty:** after removing the last agent: "No agents left. Add one to keep using AgentLink." with **Add agent** (primary).
- **Loading:** three skeleton rows in the final size. **Error:** "Couldn't load your agents." with **Try again**; rows keep the last known values.
- **Motion:** a new row slides in and settles (§6 row 1); a removed row collapses (§6 row 4); live dots as §5. Reduced motion: changes at once.

### 29.3 Add an agent (sheet)

The §21.1 sheet shell (level 3, right, 480 px; a full page at 600 px and under; not a modal). Title "Add an agent".

1. **Which AI app will use it?** The same radio list as first run (§28.2), but apps already serving another agent show "Used by Personal" and are not selectable here (an AI app serves one agent at a time; to move one, use §30.3). "I'll choose later" is allowed.
2. **Name:** `TextField` "Name your agent", prefilled "{App} agent" (or "Second agent" with no app), up to 40 characters, not overwritten once edited.
3. **Touch ID:** **Add with Touch ID**. The owner signs the new agent's card; the statement names the label. The owner is the same, so no new passkey is created.
4. **After it:** the success moment (§6 row 7), then, when an app was chosen, **"Connect {App} to it?"** with **Connect {App}** (primary; opens the §30.3 change panel) and **Not now** (text); with none chosen, **"Connect an AI app to it?"**. The new agent does not become the open one unless **Switch to it** (a checkbox, off by default) was ticked.
- **In progress:** indeterminate bar, "Adding…". **Errors:** Touch ID cancelled ("Not added yet. Try again."); failed ("Couldn't add it. Nothing was saved. Try again.").

### 29.4 Remove an agent (sheet)

**Owner decision 4.1:** Touch ID and the typed name; offer to export history first; the agent is always marked retired; its contacts are told if it has any; its AI app entries, keys and history are deleted; it cannot be restored. The sheet (§21.1 shell, level 3, 480 px; a full page at 600 px and under) is the one place the word **"keys"** appears in the default UI, because it is what is deleted.

```text
Remove "Work"?                                                       ✕
This will delete, from this computer:
  • Work's keys and settings
  • Its message and file history (4 contacts, 212 messages)
  • Its entry in [▢] Codex
Your 4 contacts will be told Work is retired. This can't be undone.

[ Export history first ]            (secondary; opens the Backup/Export flow)

Type the agent's name to confirm
[ Work                                        ]
[        Remove with Touch ID        ]   (destructive; disabled until the name matches)
```

- **Names exactly what goes:** keys and settings, history (counts), AI app entries (a list with AppMarks, entry only, as §30.3), in plain words. With contacts: "Your {n} contacts will be told {label} is retired." Without: nothing about contacts.
- **Export history first (I-10)** is offered, never forced; afterwards the person returns to this sheet with the typed name kept.
- **Typed name:** case-sensitive exact match to the label enables the button; paste is allowed. Removing the open agent is allowed; the app then opens another agent, or shows "Add an agent" when none is left. The owner stays.
- **"Quit the AI app first":** "in use" means **any AI app or process has this agent open**. The sheet then shows, in place of the button, **"Quit the AI app that uses Work first."** and lists the apps it can detect (AppMark and name each); when it cannot tell which, it says "Quit any AI app that uses Work first." **Check again** re-checks (answer `in_use`). Nothing is closed by us.
- **In progress** (stepped bar, §15.1: "Telling contacts · Removing the app entry · Erasing · Done"): the sheet stays open, cannot be dismissed, and the title becomes "Removing Work…". Closing the tab is safe.
- **"Remove anyway?":** the agent is always retired first. If that cannot be delivered to its contacts (offline or timeout), the sheet pauses at the first step: **"Remove anyway? Contacts can't be told now."** Buttons: **Remove anyway** (destructive) and **Not now** (secondary, default focus); never "Keep agent". **Not now** leaves the agent **retired**: it no longer opens, and it shows as "Removal not finished" with **Try again** (below). **Remove anyway** continues, the contacts are not told, and the sheet says once that they will see no reply. It never continues silently.
- **Removal not finished:** if the process stops part-way (power loss, closed lid), or **Not now** was chosen above, the agent is marked retired and appears in the list and switcher as "Removal not finished" with **Try again** (§29.2). **Try again** opens the Remove sheet in its in-progress state and asks for **Touch ID and the typed name again**, exactly as a first removal (the request carries the name, the typed label and the generation); it then resumes where it stopped.
- **Errors:** Touch ID cancelled ("Not removed. Try again."); a failure after the mark ("Couldn't finish removing Work. Nothing else was changed." with **Try again**).
- **Success:** the row collapses, the success moment plays, a toast says "Work was removed." and the page shows the next agent. The sheet says "retired" for what contacts are told; never "revoked", "deleted identity" or "wallet".

### 29.5 Rename

An inline edit on the Agents page row and from Home step 2 (**Name it**): the label becomes a `TextField` (up to 40 characters, Enter saves, Esc cancels) with **Save**. It **needs Touch ID**: the owner signs `agent.label`, and the statement names the agent and the new name ("Rename Personal to Home"), so the button reads **Save with Touch ID**. The label shows to contacts the next time they hear from the agent, and the top bar and menu update at once. The agent's folder name (its slug, §30.3) does not change. Errors: Touch ID cancelled ("Not renamed yet. Try again."); "Couldn't rename it. Try again."

### 29.6 Several agents: what each page does

Every page shows the **open agent's** data. The page title area carries no agent name (the top bar does); a toast or sheet that names an agent uses its label. Sidebar counts are for the open agent; the Agents page shows "2 waiting" (shape and word) on any **other** agent's row so nothing waits unseen.

### 29.7 The one-time "Tidy up" note

Owners with leftover agents (the four test agents of the 0.4.3 try) see **one calm note** on Home, above the Start here card, never inside it:

> **4 of your agents aren't connected to an AI app and have no contacts.** If they were only for testing, you can remove them.  [ Tidy up ]  [ Not now ]

- **Tidy up** opens the Agents page; **Not now** hides the note for good (stored with the agents, not in the browser). Nothing is removed or hidden automatically.
- Level 2, neutral tone (no orange: nothing needs you); at 360 full width with the buttons stacked. Shown once per computer, **only when at least one agent serves no AI app and has no contacts** (counted from the agents read; the open agent counts too, and agents with removal not finished do not), and the Agents page has not been opened. **Tidy up** opens the Agents page with those agents marked "No AI app, no contacts" so they are easy to pick. Reduced motion: appears at once.

### 29.8 Refusals and errors in one place

| Case | What the person sees | Where |
|---|---|---|
| `agent_changed` (page loaded for another agent) | "You switched agents. Nothing was changed." + the current label; the page re-reads | Toast and live region |
| `in_use` (an AI app runs this agent) | "Quit the AI app that uses {label} first." + **Check again** | Remove sheet |
| Contacts cannot be told | "Remove anyway? Contacts can't be told now." + **Remove anyway** / **Not now** (Not now leaves the agent retired, "Removal not finished") | Remove sheet |
| Removal part-way | "Removal not finished" + **Try again** | Agents page, switcher |
| Touch ID cancelled | "Not {added/removed/changed} yet. Try again." | The sheet in use |
| Agent list cannot be read | "Couldn't load your agents." + **Try again** | Switcher, Agents page |

### 29.9 Layout, motion and accessibility

- **Layout:** 1440, the Agents page is one column (max 960 px) of level 2 rows; 360, cards at full width with 16 px gutters. Sheets as §21.1.
- **Motion:** the menu opens with `--al-duration-fast` and `--al-easing-enter` (scale and fade from the trigger); the page swap on a switch is a 120 ms fade; nothing else moves. At most two things move at once (§14). Reduced motion: menu and swap appear at once, dots are still. Reduced transparency: solid sheet and menu surfaces (§13.2).
- **Accessibility:** the trigger is a button with `aria-haspopup="menu"` and `aria-expanded`; the menu is a `role="menu"` list with arrow keys, Home, End, type-ahead, Esc returning focus to the trigger; a switch announces "Now showing Work" (polite). Remove sheet: focus moves to the title, the field is labelled "Type {label} to confirm", the button's disabled reason is in text ("Type the name to enable this"), and progress announces each step. Live dots always have a word; "Removal not finished" has a warning shape; the AppMark is decorative (`aria-hidden`) because the app's name is always next to it as text. AA contrast in light, dark and increased contrast; targets 44 px at 360.

New strings: "Agent: {label}, {apps}, {state}. Switch agent.", "Add agent", "Manage agents", "No AI app", "Not connected to an AI app", "Find an agent", "Couldn't load your agents.", "Open the AgentLink app to switch.", "You switched agents. Nothing was changed.", "Now showing {label}", "Agents", "Open", "Works from", "Switch", "Rename", "Connect", "Connect an AI app", "Remove", "Removal not finished", "Removing it stopped part-way. Nothing else was affected.", "Try again", "No agents left. Add one to keep using AgentLink.", "Add an agent", "Used by {agent}", "Add with Touch ID", "Connect {app} to it?", "Connect an AI app to it?", "Not now", "Switch to it", "Adding…", "Not added yet. Try again.", "Couldn't add it. Nothing was saved. Try again.", "Remove {label}?", "This will delete, from this computer:", "{label}'s keys and settings", "Its message and file history ({contacts} contacts, {messages} messages)", "Its entry in {app}", "Your {n} contacts will be told {label} is retired.", "This can't be undone.", "Export history first", "Type the agent's name to confirm", "Remove with Touch ID", "Quit the AI app that uses {label} first.", "Check again", "Telling contacts", "Removing the app entry", "Erasing", "Done", "Removing {label}…", "Remove anyway? Contacts can't be told now.", "Remove anyway", "Not now", "Not removed. Try again.", "Couldn't finish removing {label}. Nothing else was changed.", "{label} was removed.", "Couldn't rename it. Try again.", "{n} waiting", "{n} of your agents aren't connected to an AI app and have no contacts.", "If they were only for testing, you can remove them.", "No AI app, no contacts", "Tidy up".

## 30. AI apps: connect from the app

**Idea.** Connecting an AI app used to be a terminal job (`init`). The app now shows which AI apps it found, which agent each works with, and connects one in two steps: **see the exact change, then Touch ID**. Pattern: Linear integrations and Raycast extensions (cards with a state), VS Code and Cursor "Install MCP server" (the entry is shown before it is added). **Owner decision 5.1:** the app shows the exact `agentlink` entry, then Touch ID, with a backup of the file; Claude Desktop must be closed; moving an AI app between agents is allowed with the same step. **Owner input:** an AI app serves **one agent at a time**; an agent may serve **several** AI apps. Built from the §15.1 bars, `StatusChip`, `Button`, the code/preview block of `CopyPrompt` (monospace, level 2), the §21.1 sheet and the live dot (§5).

### 30.1 The page

A page `/apps` ("AI apps"). **Navigation default (§30.5):** a sidebar item after Contacts while no AI app is connected to the open agent; once one is connected it moves under Settings. The header shows the open agent's label ("for Personal"), so it is clear which agent is being connected.

```text
AI apps, 1440                              for Personal ▾
┌───────────────────────────────┐ ┌───────────────────────────────┐
│ [▢] Claude Code                │ │ [▢] Claude Desktop             │
│ ● Running                      │ │ ○ Not connected                │
│ Connected to Personal          │ │ Quit Claude Desktop first      │
│ [ Disconnect ]                 │ │ [ Review change ]  (disabled)  │
└───────────────────────────────┘ └───────────────────────────────┘
┌───────────────────────────────┐ ┌───────────────────────────────┐
│ [▢] Codex                      │ │ [▢] Cursor                     │
│ ○ Connected to another agent   │ │ ⚠ Needs restart                │
│ Uses Work                      │ │ Restart Cursor to finish       │
│ [ Use Personal instead ]       │ │                                │
└───────────────────────────────┘ └───────────────────────────────┘
 Not listed? Connect it by hand (manual steps, §30.4)
```

At 1440 the cards form a grid of up to three columns (min 300 px); at 360 one column, cards at full width, the button full width.

### 30.2 The cards, the AppMark and their states

- **AppMark (new small component, used in §27 to §32).** A 20 px (28 px on cards) rounded square in `--al-color-bg-sunken` with a hairline border and the **app's first letter** in `al-text-caption`; **generic, no third-party logos** unless `docs/design` already holds one (none is assumed). The app's name always sits next to it as text; the mark never carries meaning alone and is `aria-hidden`. Supported apps named in copy: Claude Code, Claude Desktop, Codex, OpenCode, Antigravity, Cursor and the others `init` knows.
- Each card: AppMark, the app's name, a state word with a shaped mark, one line of detail and **one** button. The state is **read from the app's own config file** and from the lease row (never from a click).

| State | Mark and tone | Detail line | Button |
|---|---|---|---|
| **Not connected** | Hollow ring, `--al-color-fg-muted` | "Not connected" | **Review change** (primary on the first card only; secondary on the rest) |
| **Connected to {agent}** | Filled dot, success | "Connected to Personal" | **Disconnect** (secondary; same step, §30.3) |
| **Connected to another agent** | Hollow ring (as §24.3, 1.5 px, `--al-color-fg-muted`) and the word "Uses {agent}" | "Uses Work" | **Use {open agent} instead** (secondary; shows both entries, §30.3). The app leaves the other agent |
| **Needs restart** | Warning triangle, `--al-color-status-warning-icon` | "Restart {app} to finish" | none (status word; **Check again** text button) |
| **Running** | Filled dot with one arrival pulse, success | "Running" (after the app has run AgentLink) | none |
| **Entry we didn't write** | Warning triangle | "This app already has an AgentLink entry we didn't write." | **Show manual steps** (§30.4). We never overwrite it |
| **Couldn't read** | Warning triangle | "Couldn't read its settings." | **Try again** |
| **Not found** | Not a card; listed under "Not listed?" | — | — |

- **The rule:** one AI app serves one agent at a time (the card shows "Connected to {agent}" for exactly one), and one agent may have several apps (several cards say "Connected to Personal").
- **Needs restart → Running** changes by itself when the app has run AgentLink (the lease row, polled with the health poller; polling stops when the page is hidden).
- **One primary:** at most one primary button on the page.
- **Detection is silent and local:** only the fixed config paths of supported apps are looked at; nothing is sent anywhere.

### 30.3 The change panel: exact entry, then Touch ID

**Review change** opens the §21.1 sheet (level 3, 480 px; a full page at 600 px and under) titled "Connect Claude Code to Personal". When first run or Add agent chose the app, it opens here directly.

```text
Connect Claude Code to Personal                                   ✕
This adds one entry to Claude Code's settings.

  File     ~/.claude.json                       (path shown without the home folder)
  Adds     ┌──────────────────────────────────────────────┐
           │ "agentlink": {                                │
           │   "command": "npx",                           │
           │   "args": ["-y", "@4thtech-io/agentlink",     │
           │            "mcp", "--agent", "personal"]      │
           │ }                                             │
           └──────────────────────────────────────────────┘
Agent folder: personal. A backup of the file is saved first. Nothing else in it changes.

[        Apply with Touch ID        ]
```

- **Shows only the AgentLink entry.** Never other entries, context lines or the whole file (those files hold other tools' secrets). The preview is the only part of the file the page ever receives.
- **The change shown is the change written, with the agent's folder name.** `--agent` takes the agent's folder name (its slug: lower case, letters, digits and hyphens, made from the label when the agent is created, "claude-code-agent" for "Claude Code agent"), never the display label, which can hold spaces and capitals. The title and the Touch ID statement use the label; the entry uses the slug, and a line under the entry says "Agent folder: personal". Renaming (§29.5) changes the label only. The Touch ID statement names the app and the agent ("Connect Claude Code to Personal"). If the file changed since it was shown: "The file changed. Review it again." and the entry is shown again.
- **Moving an app between agents:** the panel shows **both entries**, removed and added, side by side (stacked at 360), under "Claude Code will use Personal instead of Work." Same button, same Touch ID.
- **Disconnect:** the same panel with the entry shown as removed, "Claude Code will stop using Personal." The agent then reads "Not connected to an AI app" if it was the last one.
- **After applying:** the success moment, then the card turns to **Needs restart** ("Restart Claude Code to finish"); Home step 3 shows the same word until the app runs AgentLink, then **Running**. We never close or restart the app ourselves.
- **"Quit the AI app first":** for Claude Desktop (and other apps that rewrite their file on exit) while it is open, the card and the sheet say **"Quit Claude Desktop first."** with **Check again**; Apply is disabled with the reason in text. When closed, the next check enables it. Never closed by us.
- **An entry we didn't write** stays a conflict: no overwrite; link to **Show manual steps** (§30.4).
- **In progress:** indeterminate bar, "Connecting…". **Errors:** Touch ID cancelled ("Not connected yet. Try again."); file could not be written ("Couldn't change Claude Code's settings. Nothing was changed." with **Try again** and **Show manual steps**); `agent_changed` (§29.8).

### 30.4 Manual steps

For a conflict, an app we can't edit, or someone who prefers it: a calm panel in the same sheet with the same entry as copyable text (`CopyPrompt` style: block and **Copy**), the file path, and three short numbered lines ("Open this file", "Add the entry above", "Restart {app}"). Nothing in the panel is run by us. The page ends with "Not listed? Connect it by hand", which opens the same panel with a generic entry.

### 30.5 Navigation

"AI apps" is a sidebar item after Contacts (icon from `brand/icons/ui/`), with a "Needs setup" dot while no AI app is connected to the open agent. Once one is connected it moves under Settings (after Profile) and the dot goes; Home's step 3 and the Agents rows' **Connect an AI app** always link to it. The agent switcher is in the top bar (§29.1). At 360 it is in the bottom bar's More list.

### 30.6 States, motion and accessibility

- **Loading:** three skeleton cards in the final size. **Error:** "Couldn't check your AI apps." with **Try again**; cards keep the last known state. **Empty:** "We didn't find a supported AI app on this computer." with **Show manual steps**.
- **Motion:** state words and marks change with the §6 row 3 tick; a card turning Running plays the arrival pulse once. Reduced motion: still shapes and words.
- **Accessibility:** each card is a group named "Claude Code, Not connected" with its button inside; the preview block is `role="region"` labelled "The entry that will be added", selectable text; Apply's disabled reason is in text; state changes announce politely ("Claude Code needs a restart", "Claude Code is running"). Colour is never the only signal.

New strings: "AI apps", "for {agent}", "Not connected", "Connected to {agent}", "Connected to another agent", "Uses {agent}", "Needs restart", "Restart {app} to finish", "Running", "Review change", "Disconnect", "Use {agent} instead", "This app already has an AgentLink entry we didn't write.", "Show manual steps", "Couldn't read its settings.", "Not listed? Connect it by hand", "Connect {app} to {agent}", "This adds one entry to {app}'s settings.", "File", "Adds", "A backup of the file is saved first. Nothing else in it changes.", "Apply with Touch ID", "The file changed. Review it again.", "{app} will use {agent} instead of {other}.", "{app} will stop using {agent}.", "Connecting…", "Quit {app} first.", "Check again", "Not connected yet. Try again.", "Couldn't change {app}'s settings. Nothing was changed.", "Open this file", "Add the entry above", "Restart {app}", "We didn't find a supported AI app on this computer.", "The entry that will be added".

## 31. Copy for the new screens (11 §5)

All new strings are listed at the end of §27 to §30 and §32. Rules this brief applies:

- **"AI app", never "harness", "client", "MCP server" or "tool"** in the default UI. "Agent" is the person's agent; "contact" is the other side. Every agent shows its AI app's name as text, or "Not connected to an AI app".
- **No "wallet", "gas", "seed phrase", "transaction" or "chain"** in any default string. Also avoid "identity", "account", "private key", "revoke" and "publisher".
- **"Keys" appears only in the Remove sheet** (§29.4), because it is what is deleted; **"retired"** describes what contacts are told. Paths and the `agentlink` entry appear only in the change panel (§30.3) and Advanced.
- **Touch ID wording is platform-aware** ("Use Touch ID", "Use Windows Hello", "Use a passkey").
- **Every refusal says what happened and what to do** in one sentence (§29.8); no codes (`agent_changed`, `in_use`) reach the screen.
- **Names:** only the owner-confirmed alias or the agent's label; others read "Unnamed contact"; a name the other side chose appears only in the untrusted container (I-5). No content on the map (§32).
- **Marks:** the AppMark is a generic letter mark, never a third-party logo, and never the only carrier of the app's name.
- **Checks:** sentence case, no exclamation marks, no emoji; buttons are verbs; destructive buttons name the effect ("Remove with Touch ID"). A copy test against the 11 §5 banned-word list runs on the new strings (card U3-copy).

## 32. Live connections

**Idea.** Someone running many agent sessions should see **who is talking, right now, at a glance**. Owner input (28 Oct): each agent as a box, with live lines to its contacts while messages or files flow. **Owner decision 8.1 (2026-10-29):** the Agents page gets the map first, plus a **moving-row mark in Messages and Files**; **no preview on hover and no message content on the map; clicking opens Messages**. Home's Last activity mini map (top 5), a Contacts Map view and a one-line strip in the compact view (§25.1) follow later (0.4.5) and reuse this section. Pattern: Tailscale's machines map, Figma presence, Vercel and Linear live status, Grafana service maps: the list stays primary, motion only on change, clustering at scale. Built from the pulse (§24), the determinate bar (§15.1), the live dot (§5), `Segmented` (§22), the AppMark (§30.2) and the level 2 card (§16).

### 32.1 Where it is, and what it shows

- **Agents → Map** (the `Segmented` of §29.2). The List is the default and the **text alternative** of the map; the Map is an extra view, lazily loaded.
- **Messages and Files:** a small **moving-row mark** on a row (and a Contacts row) that has a stream now (§32.3), in the slot right of the §24.3 marker, 12 px, with the word "Sending" or "Receiving".
- **Map content:** your agents as boxes on the left (label, live dot, **AppMark and app name for each AI app, or "Not connected to an AI app"**), contacts as smaller boxes on the right, and a line when they exchanged anything in the last 24 hours. Line weight follows the pulse counts (§24). A **stream** (a short travelling dash in the flow's direction) runs only while a message or file is moving or arrived in the last minute, then settles. A file in progress shows the determinate fill of Files (§15.1).
- **No content, ever, on the map.** Names (owner-confirmed; others "Unnamed contact"), activity words and direction only. No text, subject, file name, link or envelope on a box or line, and no preview on hover. Calm and safe while screen sharing. Zero access is unchanged: nothing leaves the device for this view; it works offline.
- **Click opens Messages:** a contact box or a line opens that conversation (switching the open agent first with the §29.1 rules if the line belongs to another agent). An agent box opens Messages for that agent. "+N more" opens Contacts sorted Most active. Nothing else opens.

### 32.2 Layout

```text
Agents → Map, 1440 (level 1 page, map on a level 2 canvas, 960 × ~480)
┌───────────────────────────────────────────────────────────────────────┐
│ [ List │ Map ]                          Show quiet  (◯━ off)          │
│ ┌────────────────┐                        ┌──────────────────┐        │
│ │ Personal ●     │━━━━━━ ▸▸ ━━━━━━━━━━━━━━│ Marko  Active now│        │
│ │ [▢] Claude Code│────────────────────────│ Ana    Today     │        │
│ └────────────────┘                        │ Ivo    Quiet     │        │
│ ┌────────────────┐                        │ + 7 more         │        │
│ │ Work ○         │────────────────────────│ Dana   Today     │        │
│ │ [▢] Codex      │                        └──────────────────┘        │
│ └────────────────┘                                                     │
│ Second agent ○  Not connected to an AI app                             │
│ A line shows people who exchanged something in the last 24 hours.      │
└───────────────────────────────────────────────────────────────────────┘

360: one column. Each agent is a card (label, dot, AppMark and app name);
under it its contacts as rows with the activity word and the moving-row
mark. No lines are drawn.
```

- **1440:** a fixed **two-column layout**, no physics, no dragging: agents left, contacts right, sorted by activity (most recent first). Agent boxes 72 px, contact boxes 44 px; lines straight or one soft elbow. The canvas scrolls inside the card past 480 px.
- **360:** the map does not draw lines. Each agent is a card and its contacts are rows underneath; the "stream" is a 2 px moving segment at the row's left edge. 44 px rows, 16 px gutters. The List and Map `Segmented` stays.
- **Lines:** weight 1 to 3 px by the pulse count (§24.2 scale, per agent); `--al-color-fg-muted` for a line, `--al-color-status-success-icon` for a **running** stream segment only; **no orange**. Arrowhead for direction; solid when both ways, dashed when one way (shape, not colour).
- **Light, dark and increased contrast** follow the tokens; in increased contrast line weights go up by 1 px and box edges use `--al-color-border-strong`; forced colours use `CanvasText` for lines and `Highlight` for a running stream.

### 32.3 Streams and states

- **Message stream:** a 12 px dash travels the line in the flow's direction for 1.2 s once per arrival, then the line settles; a burst is combined into one. **File stream:** the dash travels while the file moves, and the contact box shows the determinate fill ("Sending to Marko", "2.1 of 8 MB · about 20 s"); if bytes are unknown the indeterminate bar is used (§15.1), never a guessed percentage. After one minute the stream stops and the line keeps its weight.
- **Active now** and **Today** use the §24.3 shapes. The moving-row mark in Messages and Files is the same dash at 12 px for the same period.
- **Loading:** two skeleton agent boxes and a skeleton column in the final size. **Empty:** "No one to talk to yet." with **Add contact** (primary). **No recent activity:** lines hidden and the note "Nothing has moved in the last 24 hours."; **Show quiet** lists the quiet contacts. **Error:** "Couldn't load what's moving." with **Try again**; the last view stays dimmed and streams stop. **Offline:** stored activity still shows; streams only run from what arrives.
- **Data:** the pulse read shared with §24 (one shared pulse module) and one flow read polled every 3 s while the tab is visible and stopped when hidden: metadata only, never text, subject, file name, link or envelope (07 §3). The endpoint is specified by card U3-flow, not here.

### 32.4 Scale and calm

- **Top 12 contacts per agent,** the rest in a "+N more" group (click opens Contacts sorted Most active); **up to 8 agents drawn,** the rest in "+N more agents" (opens the List).
- **Quiet contacts hidden** by default; **Show quiet** (a `Switch`, §22, remembered per browser; off if storage fails).
- **At most 6 streams at once;** more show as lines with the moving-row mark and no dash. At most two things move at once on screen (§14).
- **Calm default:** the map opens with no stream unless something is moving right now; nothing loops (11 §11 item 6). Animation uses `transform` and `stroke-dashoffset` only and pauses when the tab is hidden.
- **Budget:** one SVG layer, no new dependency, lazy-loaded, under 8 KB gzipped; the flow answer under 20 KB; `perf-guards.test.ts` extended. Smooth on the reference slow machine (D-135 (3) (d)).

### 32.5 Reduced motion, transparency, accessibility

- **Reduced motion:** no travelling dash; a static arrowhead and the word "now" on the line and the row; the determinate fill changes without easing. **Reduced transparency:** solid canvas and box surfaces (§13.2).
- **Text alternative:** the map is decoration over the List, which carries every fact (names, words, counts, AI apps). The SVG is `aria-hidden="true"`; the Map view's heading "Live connections" is followed by a visible summary line: "2 agents, 5 contacts. Marko is talking with Personal now."
- **Live region:** polite, at most one line per 10 s ("Marko is sending a file to Personal", "Reply from Marko"); never contents.
- **Keyboard:** order follows the list (agent, then its contacts); boxes are buttons labelled such as "Personal and Marko, Active now. Open conversation"; Enter opens Messages. **Colour is never the only signal:** words, dash and solid lines, and marks accompany every colour.
- **Hover preview:** none ships. If the owner later chooses it (decision 8, option 3), it must come from the Messages read as plain text in the untrusted container.

New strings: "Live connections", "List", "Map", "Show quiet", "+{n} more", "+{n} more agents", "{agents} agents, {contacts} contacts. {name} is talking with {agent} now.", "Sending", "Receiving", "Sending to {name}", "No one to talk to yet.", "Nothing has moved in the last 24 hours.", "Couldn't load what's moving.", "{name} is sending a file to {agent}", "Reply from {name}", "Open conversation", "now". Existing: "Active now", "Today", "Quiet", "Add contact", "Try again", "Not connected to an AI app".
