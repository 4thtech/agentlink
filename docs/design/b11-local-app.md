# B-11 · A state-of-the-art local app: Home, live state, motion, under the hood (design brief)

> **Status: brief for the owner (DESIGN-B11, S0; amended by DESIGN-B11-v2 on 2026-10-27 with §13 to §18, and by MONEY-CONFIRM-DESIGN on 2026-10-27 with §19 and §20). Nothing here is built.** Per D-116 the design in `docs/design/` is the source of truth and new visuals are approved before they are built. The owner takes this brief to Claude Design; builders style only from the approved screens. Specs win on conflict: 04 §2.5 (presence), 08 §4 (CSP), 11 §5 (vocabulary), 11 §11.6 (motion rules), `docs/design/README.md`. The paste-ready block is §11. **v2 (2026-10-27)** adds depth and materials (§13), motion tokens (§14), progress and state components (§15), per-screen notes (§16), Messages and Files In/Out (§17) and the owner decisions this raised (§18), **all decided by the owner on 2026-10-27 as recommended (D-132)**. **Paying for proof and registration (2026-10-27)** adds §19 (one confirmation sheet for the two paid actions, confirmed with Touch ID, Windows Hello or a passkey; a calm credits line; a receipt row per paid action) and §20 (owner decisions it raises).

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
| **Chrome** | Left sidebar, top bar, the 360 bottom bar, sticky day headers | `--al-material-chrome-bg` (the surface colour at about 72 % opacity) with a background blur of about 20 px and saturation 1.4 (`--al-material-blur`); hairline border on the content side |
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
