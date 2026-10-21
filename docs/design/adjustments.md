# Design adjustments (DESIGN-ADJ-1, D-116)

**Owner, in chat, 2026-10-21:** "The design must be adjusted. It was built before we fine-tuned everything."

> **UX north star (D-117).** Owner, in chat, 2026-10-21: "Please remember that we are aiming for best possible UI and UX, We are also aiming to abstract as many complexity as possible". When you redesign a screen in Claude Design, take the simplest path for the user, show one clear next step, hide what the agent can do for them, and keep Advanced for the rest. Open questions below are answered in D-117 (marked "→ D-117").

This file compares the 14 Oct 2026 design (D1 and the D2 first pass in `d1/`, `d2/`, `brand/`) with the current specs and decisions, as of `main` on 21 Oct 2026 plus the open PRs it names. It is the input for the UI build cards (M1-35a–c, M1-11b, M1-11c, M1-19-c, then M2) and for the owner's redesigns in Claude Design. The screens themselves are not changed here.

**Sources compared.** All 46 `d2/source/screens/*.dc.html` (visible text, attributes and sample data), the 46 PNGs, `d1/copy/strings.en.json` (109 keys), `in-chat.md`, `terminal.md`, the 31 component specs in `d1/components/`, and the two manifests. Against: 06 §2.0–§2.5, §3, §7, §8; 07 §5 and its copy table; 08 §1, §2.3, §4; 11 §5, §5.1, §5.2, §5.5, §5.6, §6, §8; 12; D-56…D-116 (notably D-67, D-68, D-72, D-78, D-79, D-95, D-99, D-100, D-105, D-107…D-115, D-39, D-40). Merged work covered: receipts off by default (M1-33a), the disclosure strings (M1-33b), receipt requests and the user's own DELIVERED (M1-33d), the contact proof-mismatch flag (M1-7g-c), delete on receipt (M1-1g-h), the per-file `deleteAfter` snapshot (M1-1g-i), the receipt payer (M1-34, D-114). Open PRs read for their copy: #344 (top-up link, off while `PAY_PAGE.live` is false), #348 (static invite page), #354 (`status --brief` session hook).

## How to read this file

- **(a) agents fix in code.** Copy and small flow changes, inside the existing layout and components. The building card named in the row does it; no new design is needed.
- **(b) owner redesigns in Claude Design.** A layout change or a new screen or component. Each (b) item has a paste-ready brief in "Briefs for Claude Design" below. The building card waits for the redesign only for that part of its surface.
- **Kind:** *Outdated* (contradicts a later spec or decision), *Missing* (required now, not drawn), *Remove* (must not ship).
- **Constraints for every fix and brief:** 11 §5.1 vocabulary (no wallet, gas, chain, transaction, seed phrase, owner key in default UI); no network name in the default UI (D-40), the funded network is chosen automatically; the 08 §4 and §2.3 CSP: no inline styles or scripts in production, classes from `packages/ui`, self-hosted fonts and icons; untrusted text only inside `UntrustedContent`, and names under the 11 §5.2 name rule.
- **Tokens: not affected.** No finding needs a new colour, type or spacing token; the disclosure lines use the existing `info` and `neutral` tones. M1-35a proceeds as planned.

### The three known issues

| Issue | Finding | Fix |
|---|---|---|
| Pay: "If your exchange asks for a network, choose Base (cheapest)." | Names a network as a choice the user makes, hard-coded, in the default view (D-40, 11 §5.1) | PA-1 (a) and B-6 (b) |
| Raw `0x…` record IDs in verify and proof detail | In both sources and PNGs the record ID and "proof network Base" sit **inside a collapsed** "Details (Advanced)" / "Advanced" disclosure, so the default view is compliant as drawn. What remains: the network is hard-coded, and nothing guarantees the disclosure stays collapsed | X-3, X-12 (a) |
| Lucide ISC notice missing | `bundle.js` and the manifests credit Lucide but carry no ISC notice | X-2 (a), with M1-35a (#361) |

## Cross-cutting items (every surface)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| X-1 | Outdated | Every screen uses inline `style=` (37 in Verify alone) and the preview runtime `support.js`. Production uses classes from `packages/ui`, no `style=` attribute, no inline script | 08 §2.3, §4; D-116 (4) | (a) | M1-35b and each building card |
| X-2 | Missing | Lucide ISC copyright and permission notice; list which icons are Lucide-derived | `d1/MANIFEST.md`; D-116 (4) | (a) | M1-35a |
| X-3 | Outdated | "Proof network Base" hard-coded in Local-advanced, Verify, Proof-detail, Print-record. Use `{network}` from `advanced.chain`, Advanced and print appendix only | D-108 (1), D-40, 11 §5.1 | (a) | M1-35c, M1-11c, M2-5a |
| X-4 | Outdated | Fixed windows: "this week", "Resets 19 Oct", "today", "$0.30 of $5 today". The drop quota is 1 GB in any 7 days and the proof budget is any 24 hours; say "in the last 7 days" / "in the last 24 hours" and when space or budget frees up | 07 §5.4 (limits), 06 §3 (daily budget window, G-7, D-90) | (a) | M1-35c, M1-11c |
| X-5 | Missing | The 11 §5.6 disclosure lines on every proof approval, receipt, receipt request, export, top-up method and registration. None of the screens carries them | D-109 (1), 11 §5.6, 06 §2.4 | (a) | M1-35c (strings), each building card |
| X-6 | Outdated | "Add credits" buttons lead to the pay page, which is off while `PAY_PAGE.live` is false. Hide them; show "Adding credits is not available yet in this version of AgentLink." and, on testnets, free test credits | D-113, M1-26-e (#344), D-116 | (a) | M1-11c, M1-35b, M2 console |
| X-7 | Outdated | Unknown senders shown as "Contact 2B9E·04D1" or "Request from Contact …". They are "Request from an unknown sender · 2B9E·04D1"; "Contact" is only for a paired contact whose name is unusable | D-72, 11 §5.2, 06 §2.1 | (a) | M1-35c, M1-35b, M1-11b, M1-11c |
| X-8 | Outdated | Local UI status bar and Advanced show `127.0.0.1:4317`. The page is `http://localhost:<port>` | D-79, 08 §1 | (a) | M1-11b, M1-11c |
| X-9 | Outdated | Config diffs (Terminal-copy, Desktop-firstrun-setup) lack the `mcp` argument: `["-y", "@4thtech-io/agentlink", "mcp"]`; a named agent ends in `--agent <name>` | 06 §7, D-78 | (a) | M1-35c, M2-11 |
| X-10 | Outdated | Owner presence named as "passkey or owner passphrase" only. The local page also takes the owner code, and on the command line the generated owner code is the default | D-54, D-67, 11 §5.5, §6.2.1 | (a) | M1-35c, M1-11b |
| X-11 | Outdated | Sample contacts are shown "online" / "last seen 2h ago". AgentLink has no presence for contacts; show last activity (`lastActivity`). Online and offline stay for the owner's own agents | 06 §2.1 (`agentlink_list_contacts`) | (a) | M1-35b, M1-11c |
| X-12 | Outdated | Record IDs, terms fingerprints and the network: keep them only in the collapsed Advanced disclosure (verify, proof detail) and the print appendix; the disclosure is collapsed on load and never rendered open by default | 11 §5.2, §6.4, §6.12 | (a) | M2-5a |

## Local UI (M1)

### Local-firstrun → `first-run--protect-approvals` (M1-11b)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| LF-1 | Outdated | Body "Your AI can't approve anything without you: each approval needs your passkey or owner passphrase…" claims more than D-67 allows. Use the 11 §6.2.1 text: "Approvals need you: each approval, or each list of approvals you review together, asks for your passkey, owner code or owner passphrase, and only after you click Approve. Never give them to your AI." | 11 §6.2.1, D-67, D-68 | (a) | M1-11b, M1-35c |
| LF-2 | Missing | A path for an owner who already has an owner code (from `agentlink owner init`): the passkey is registered with one entry of the owner code. Today the screen offers only "Create a passkey" and "Use an owner passphrase instead" | 08 §1, M1-8e, 11 §6.2.1 | (b) B-9 | M1-11b |
| LF-3 | Outdated | "Until this is done … new contacts, proofs, files over your limit, accepting terms": there is no "files over your limit" approval. List what waits: new contacts, proofs your rules ask about, folder access, document keys, accepting terms | 06 §3 | (a) | M1-11b |

### Local-recovery → `first-run--recovery-kit` (M1-11b)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| LR-1 | Outdated | The step shows a long-lived recovery code to write down. A recovery kit is now a file plus a fresh recovery code shown once per export, which "only opens this kit"; full history by default, identity only as an option; keep kit and code apart | D-115 (A, B), 07 copy table (`backup export`) | (b) B-3 | M1-11b |
| LR-2 | Outdated | "The kit holds … How to restore on a new device": restore never overwrites and is run in a terminal (`agentlink backup restore`); say so | D-115 (C, E), 06 §8 | (a) | M1-11b |

### Local-approvals → `approvals--pending`; Approval-light, Approval-contrast, Approval-states, Commitment-mobile → `d1/screens/mobile/` (M1-11b)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| LA-1 | Missing | Review together: "Waiting for you (4)", one agent's approvals as full cards (soonest to expire first, at most 20), Approve / Deny / Later each, then one button naming exactly what is included ("Approve 3 and deny 1") and one presence entry. Accepting terms is never part of the list | D-68, 04 §2.5.2, 11 §6.2.1 | (b) B-2 | M1-11b |
| LA-2 | Remove | "Request from Contact 2B9E·04D1" in the approvals list. Requests are not approvals; they live under Contacts → Requests and need no presence | D-72, 11 §6.2.1 | (a) | M1-11b |
| LA-3 | Outdated | Proof consequence "A public record shows this exact file was sent at this time…" → the two 11 §5.6 lines ("A proof is public…", "If {contactName} confirms delivery…") | D-109, 11 §5.6 | (a) | M1-11b, M1-35c |
| LA-4 | Outdated | "Remember for this contact: allow files up to 200 MB from Marko" (Approval-states). Offered only on proof approvals raised by "Ask me" or the per-proof limit, never by the daily budget, a new contact, a file or a commitment | 06 §3, 11 §8, D-90 | (a) | M1-11b, M1-35b |
| LA-5 | Remove | The "file over limit" approval ("Send a 140 MB file … It goes through the encrypted drop"). The drop takes at most 100 MB per file; above it the tool returns `needs_setup` (own storage), and no approval exists for it | 06 §2.3, 07 §5.4 | (a) | M1-11b, M1-35b |
| LA-6 | Outdated | Decided elsewhere: "Already approved on your phone." In M1 there is no phone surface: "Already decided in your terminal or another window." | 06 §2.5 (M1a channel) | (a) | M1-35c |
| LA-7 | Missing | When the budget triggered the approval: "used in the last 24 hours" and when the oldest entry leaves the window | 06 §3 (Display) | (a) | M1-11b |
| LA-8 | Missing | Commitment card: the receipt line "This is public: anyone can see that your agent accepted it, and when." | 11 §5.6, D-109 | (a) | M1-11b, M1-35b |
| LA-9 | Missing | A proof approval with a receipt request carries "Ask {contactName} to confirm delivery? If they do, anyone can see that this went to their agent." | 11 §5.6, M1-33d | (a) | M1-11b |

### Local-states → `shared-states--all` (M1-11b)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| LS-1 | Missing | Rules fail closed: "Your rules couldn't be checked, so everything that costs money or commits you asks first. Run `agentlink policy recover` in your own terminal." | 06 §3, D-100 | (a) | M1-11b |
| LS-2 | Outdated | "Passkey unsupported" strings differ by surface: the local page falls back to the owner passphrase or owner code, the console to the recovery code (`common.state.passkeyUnsupported` says recovery code everywhere) | 11 §6.2.1, §6.3 | (a) | M1-35c |

### Local-activity → `activity--default` (M1-11c)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| AC-1 | Missing | A received receipt request: "{contactName} asked you to confirm delivery…" with **Confirm delivery** · **Not now** and "Confirm deliveries from {contactName} automatically" next to it | D-109, 06 §3, 11 §5.6, M1-33d | (b) B-1 | M1-11c |
| AC-2 | Missing | Contact flagged: "A proof from {contactName} didn't match the public record, so it was refused." (warning chip, no inbound text) | M1-7g-c, 04 §3.4 | (a) | M1-11c |
| AC-3 | Missing | "Removed from the drop after delivery" and "Expired and removed" events for sent files | M1-1g-h, M1-1g-i, D-98 | (a) | M1-11c |
| AC-4 | Outdated | Unknown-sender row: Accept / Ignore / Block stay (no presence), but add that accepting shows the message to the AI and does not add a contact | D-72 | (a) | M1-11c |

### Local-contacts → `contacts--with-request` (M1-11c)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| CO-1 | Outdated | Banner "An unknown sender wants to connect. Review it in Requests." → "1 request from an unknown sender. Only an invite adds a contact." | D-72, 07 §3.2 | (a) | M1-11c |
| CO-2 | Missing | Contact detail switch "Confirm deliveries from {contactName} automatically" with the 11 §5.6 line; saving signs a `policy.set` with presence. Same pattern as "Keep Marko's agent in sync" | D-109, 06 §3 | (a) | M1-11c |
| CO-3 | Missing | Proof-mismatch flag on the contact (list chip and a warning banner on the detail) | M1-7g-c | (a) | M1-11c, M1-35b |
| CO-4 | Missing | Pairing states: waiting for the other agent (no safety code yet), mismatch; the SafetyCode compare block on an unchecked contact | 04 §3.6.1, 11 §8 | (a) | M1-11c |
| CO-5 | Missing | Requests list with "Ignore all", a Blocked list with Unblock, and Remove contact (owner action) | D-72, 06 §8 (`contacts remove`) | (a) | M1-11c |

### Local-files → `files--default` (M1-11c)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| FI-1 | Outdated | "Delete after receipt: Remove a file from the drop once the recipient has it." → "…once the recipient confirms delivery. Without a confirmation, it's removed when its link expires. Applies to files you send from now on." | 06 §3, M1-33d, M1-1g-i | (a) | M1-11c |
| FI-2 | Missing | Per sent file: how it will be removed ("After delivery" or "At expiry, {date}"), fixed when it was sent | M1-1g-i | (a) | M1-11c, M1-35b |
| FI-3 | Missing | Refusal when an allowed folder contains a protected folder | D-99 | (a) | M1-11c |

### Local-storage → `storage--default` (M1-11c)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| ST-1 | Outdated | "This week 212 MB of 1 GB · Resets 19 Oct" and "It resets on 19 Oct." → rolling 7 days, no reset date (X-4) | 07 §5.4 | (a) | M1-11c, M1-35c |
| ST-2 | Missing | Own storage (Advanced): guided connect (provider → steps → bucket details → keys, never shown again → test upload, download, delete → lifecycle rule offer → passkey), the connected state with Disconnect, and "configured, but this computer has no keys" after a restore, which never falls back to the drop | 07 §5.2, §5.6, D-115 (D), 06 §8 | (b) B-4 | M1-11c |
| ST-3 | Missing | The `files.storage` rule: Automatic (recommended) / Always the encrypted drop / Only my own storage | 06 §3 | (a) | M1-11c |

### Local-proofs → `proofs-credits--default` (M1-11c)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| PR-1 | Outdated | QR, "Copy Agent ID" and "Credits for this agent are added to this ID" frame a top-up that is off (X-6). While not live: free test credits (testnets) and the not-available line; Agent ID stays in Advanced | M1-26-e, D-113 | (a) | M1-11c |
| PR-2 | Outdated | Receipts column assumes Delivered. Add "Not confirmed" (receipts off by default), "Asked to confirm" and "Waiting to post" (deferred receipt) | D-109, D-114 (D) | (a) | M1-11c, M1-35b |
| PR-3 | Missing | Proofs received from contacts, with Export (both sides export) | D-107 | (a) | M1-11c |
| PR-4 | Missing | Export with options and the 11 §5.6 export line | D-109, 07 §8, 06 §2.4 | (b) B-8 | M1-11c, M2-5a |
| PR-5 | Missing | Top-up privacy line once per method, when the pay page is live | 11 §5.6 | (a) | M1-11c |

### Local-rules → `rules--default` (M1-11c)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| RU-1 | Missing | Contact rules list with Remove; "Confirm deliveries publicly: Off (recommended)"; the per-contact delivery confirmations; the review step "Keep delivery receipts on?" when an older default is still on | 06 §3, D-90, D-109, 11 §5.6, §8 | (b) B-5 | M1-11c |
| RU-2 | Outdated | "Requests from unknown senders: Allowed / Ask me / Never · Shown as Contact plus fingerprint until you accept" → "Hold for my review (recommended) / Drop", copy per D-72 | 06 §3 (`unknownSenders`), D-72 | (a) | M1-11c |
| RU-3 | Outdated | "Messages from contacts: Allowed / Ask me / Never": no such rule. The rule is who may talk: "Paired contacts (recommended) / Only contacts I list" | 06 §3 (`contacts.allowed`) | (a) | M1-11c |
| RU-4 | Outdated | "Files: Ask me for files over 100 MB": no such approval. Show "Only from allowed folders · send up to 100 MB · receive up to 200 MB" | 06 §3 (`files`) | (a) | M1-11c |
| RU-5 | Outdated | "Daily budget" → "Proof budget in any 24 hours" | 06 §3, 11 §8 | (a) | M1-11c |
| RU-6 | Missing | "Ask me before connecting with a new contact" (`contacts.acceptInvites`) | 06 §3, 11 §8 | (a) | M1-11c |

### Local-backup → `backup--restoring` (M1-11c)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| BA-1 | Remove | "Show recovery code" and "It was shown once, when you set up". Every export makes a new code that is shown once and stored nowhere | D-115 (B) | (b) B-3 | M1-11c |
| BA-2 | Outdated | "Restore on this computer: Replaces this agent with the one in your recovery kit." Restore never overwrites; it refuses an existing agent or a different owner, and runs in a terminal | D-115 (C, E), 06 §8 | (b) B-3 | M1-11c |
| BA-3 | Missing | Export choices (full history / identity only), "keep the kit and the code apart", and after a restore: "stop the agent on your old computer", reconnect own storage | D-115 (A, D), 07 copy table | (b) B-3 | M1-11c |

### Local-advanced → `advanced--default` (M1-11c)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| AD-1 | Remove | "Export raw keys … Export keys to a file". No such operation exists; raw keys are never shown, and moving an agent is the recovery kit | 11 §5.2, I-4, D-115 | (a) | M1-11c |
| AD-2 | Missing | Message network relays, RPC overrides and the proof network choice (the only place a network can be chosen), as editable rows with existing fields | 08 §1, D-40, M1-11c scope | (a) | M1-11c |
| AD-3 | Missing | The agent's name in the header: several local agents can share one owner | D-78 | (a) | M1-11c |

## Public pages

### Invite-landing → `invite/invite-landing--default--light--360` (M1-19-c)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| IN-1 | Missing | The page's states from #348: no invite (how to install only), checking, expired, damaged, too large. Each replaces the inviter block and shows no prompt | 08 §4, 11 §6.5, M1-19 | (a) | M1-19-c |
| IN-2 | Remove | "No AI agent? View and accept in browser" until M2-13 ships | 11 §6.5, D-35 | (a) | M1-19-c |
| IN-3 | Outdated | Inviter block: label "Owner fingerprint" (not "Fingerprint"), the Self-declared label always visible, "Valid until {date} UTC" as the page computes it | 11 §5.2, 06 §2.1, #348 | (a) | M1-19-c |

### Accept-browser → `accept/review-and-accept--pending--light--1280` (M2-13)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| AB-1 | Missing | The accepted-receipt public line (X-5) and, when the inviter asked, the receipt request (B-1) | 11 §5.6, D-109 | (a) | M2-13 |
| AB-2 | Missing | States: expired, used, damaged, no passkey support, terms expired, offline | 11 §6.5 | (a) | M2-13 |

### Verify → `verify/verify-result--valid-agreement`; Proof-detail → `desktop-macos/proof-of-agreement--recorded`; Print-record → `print/` (M2-5a)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| VE-1 | Missing | Results other than valid: record only (sender not confirmed), does not check out (with its reason), not checked, document matches / doesn't, and the non-fatal warnings (receipt link not confirmed, contract signer no longer confirms) | D-95, D-96, D-105, 06 §8 exit codes, 11 §6.4 | (b) B-7 | M2-5a |
| VE-2 | Outdated | "Delivered to …" assumes the recipient is known. A record is unlinkable unless the pack includes the recipient; otherwise "Recipient not included in this file" | 07 §8, 06 §2.4 (`includeRecipient`) | (a) | M2-5a |
| VE-3 | Missing | Details: receipts with a transaction link only when the check confirmed it, otherwise the time alone | D-105, 11 §6.4 | (a) | M2-5a |
| PD-1 | Outdated | Receipt timeline "Delivered to Ana's agent 14:05" as the normal case; add not confirmed, asked, waiting to post | D-109, D-114 | (a) | M2-5a, M1-35b |
| PD-2 | Missing | Export proof → the export dialog | D-109, D-107, 07 §8 | (b) B-8 | M2-5a |
| PT-1 | Missing | US Letter variant of the printed record (same layout, `@page` size) and the appendix with `{network}` | 11 §6.12 | (a) | M2-5a |

### Onboarding → `onboarding/connect-your-ai--waiting` (M2-8)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| ON-1 | Missing | OpenCode in "Connect your AI" | 06 §7, D-78 | (a) | M2-8 |
| ON-2 | Outdated | "Protect your approvals" must say the owner code is shown once and never pasted into a chat | D-67, 07 copy table | (a) | M2-8 |

### Pay → `pay/add-credits--exchange--light--360` (M2-2f, M2-18b–d)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| PA-1 | Outdated | "If your exchange asks for a network, choose Base (cheapest)." → the exchange method's own "Network: {network}" line, filled from the shipped config (the network chosen automatically), plus what happens on a wrong network | D-40, D-111, 11 §5.1, §6.7, §14 Q5 | (a) | M2-18c |
| PA-2 | Outdated | Methods: crypto first. "Use crypto you already have" (connect the user's own account, "From your account · $42.10 available", one confirmation, no network choice), then "Send from an exchange", card last and not in the beta; free test credits first on testnets | D-111, 08 §2.3, `topup-ux.md` | (b) B-6 | M2-18b–d |
| PA-3 | Remove | "Advanced · connect a browser wallet", replaced by the first method in PA-2 | D-111, 11 §5.1 | (b) B-6 | M2-18b |
| PA-4 | Missing | Privacy line once per method | 11 §5.6, §6.7, D-109 (6) | (a) | M2-18b–d |
| PA-5 | Missing | States: added, Agent ID mismatch, offline, damaged link ("This link is damaged. Ask your agent for a new one."), below the minimum (copy for "[WHAT HAPPENS TO IT]"), "Save a payment record" | 11 §6.7 | (b) B-6 | M2-18b–d |
| PA-6 | Missing | The page reads the D-113 link (`#v=1&a=…&usd=…`): the amount preset from `usd`, the Agent ID from `a`; nothing leaves the fragment | D-113, 08 §1 | (a) | M2-2f |
| PA-7 | Outdated | The page and every link to it ship only when `PAY_PAGE.live` is true | M1-26-e (#344) | (a) | M2-2f |

### Pricing → `pricing/pricing--default` (M2-8)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| PC-1 | Outdated | "Files up to 100 MB each, 1 GB a week" → "1 GB in any 7 days" | 07 §5.4 | (a) | M2-8 |
| PC-2 | Outdated | "Beta: no card payments; add credits from an exchange or payment app." While the pay page is off: "During the beta, proofs use free test credits." Later the D-111 methods | D-111, M1-26-e | (a) | M2-8 |
| PC-3 | Missing | "Up to 3 receipts, paid by the sender's proof; recipients never pay for receipts" and the Registered badge line of 11 §5.6 | D-114, D-109 (7) | (a) | M2-8 |

## Owner console (M2-2a–e, M2-12)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| CN-1 | Outdated | Console-agents: "bound to your owner key" → "approved by you with your passkey"; the Registered line "Registering puts your agent's link to you on the public record. Your agent's name is not published." | 11 §5.1, §5.6, D-109 (7) | (a) | M2-12 |
| CN-2 | Outdated | Console-credits: "Today" → "Last 24 hours"; Add credits gated (X-6); privacy line per method | G-7, M1-26-e, 11 §5.6 | (a) | M2-2d |
| CN-3 | Missing | Console-home and mobile home: receipt requests in the attention list (component from B-1) | D-109 | (a) | M2-2a |
| CN-4 | Missing | Console approvals: review together (same as LA-1) | D-68 | (b) B-2 | M2-2b |
| CN-5 | Missing | Contacts: proof-mismatch flag, "Confirm deliveries automatically" switch | M1-7g-c, D-109 | (a) | M2-2c |
| CN-6 | Outdated | Console-signin "Restore with your recovery code" restores a console kit; a computer's recovery kit restores with `agentlink backup restore`. One clarifying line | D-115, 08 §2.1 | (a) | M2-2a |
| CN-7 | Missing | Console-settings Advanced: relays and RPC overrides | 08 §2.2 | (a) | M2-2e |

## Cloud agent (M2-3)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| CL-1 | Missing | States from 11 §6.9: wrong or used setup code, setup locked, code expired, message network unreachable | 11 §6.9 | (a) | M2-3 |
| CL-2 | Missing | Disclosure lines on proof and receipt approvals raised by the cloud agent (X-5) | 11 §5.6 | (a) | M2-3 |

## Desktop (M2-11b–g)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| DE-1 | Outdated | Desktop-firstrun-setup: config diff without `mcp`, and one agent per AI app | 06 §7, D-78 | (a) | M2-11 |
| DE-2 | Outdated | Desktop-welcome "Save your recovery kit · Shown once": each kit gets its own code | D-115 (B) | (a) | M2-11 |
| DE-3 | Missing | Dashboard nav lacks Backup and Files (the dashboard is the console plus Files, Storage, Backup) | D-41, 11 §6.2.2 | (a) | M2-11 |
| DE-4 | Missing | Windows Hello states (waiting, confirmed, cancelled, failed, unavailable → owner passphrase) | 11 §6.2.2 | (b) B-10 | M2-11 |
| DE-5 | Outdated | Update banner "its signature didn't match" (default UI); owner to confirm or reword (see Owner decisions) | `d2/MANIFEST.md`, 11 §5.1 | (a) | M2-11 |

## Copy: `strings.en.json`, Chat-copy, Terminal-copy (M1-35c)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| S-1 | Outdated | `chat.status.needs_credits.summary` → "Adding proof needs credits. Add at least {shortfall} here: {url}. $5 covers 50 proofs."; while not live, the #344 line | 06 §2.4, D-113, M1-26-e | (a) | M1-35c |
| S-2 | Outdated | `chat.status.pending_approval.summary`: add the terminal path `agentlink approve {approvalId}` (M1a has no URL) | 06 §2.5 | (a) | M1-35c |
| S-3 | Outdated | Chat-copy "Permission prompt titles · proposed" uses placeholder names (`agentlink_invite`, `agentlink_terms`). Use the 15 frozen tool names | 06 §2.0, D-53, D-55 | (a) | M1-35c |
| S-4 | Outdated | `{contactFirstName}` in `chat.status.ok.sent.summary` and the invite summary derives text from a counterparty name; use `{contactName}` under the name rule | 06 §2.1, 11 §5.2 | (a) | M1-35c |
| S-5 | Outdated | `chat.status.ok.invite.summary`: add "Send it only to {contactName}: whoever uses it first is connected" and where the safety code is compared (local page or `agentlink contacts --verify`, never chat) | 11 §6.1, G-28 | (a) | M1-35c |
| S-6 | Outdated | `common.safetyCode.changed`: a key update by the same owner keeps the check; no new comparison | 11 (drift in `d1/MANIFEST.md`) | (a) | M1-35c |
| S-7 | Outdated | `common.untrusted.label.unknown` "Request from Contact {fingerprint}" (X-7) | D-72 | (a) | M1-35c |
| S-8 | Outdated | `common.credits.today`, `common.state.quotaReached` (X-4); `common.state.passkeyUnsupported` (LS-2); `common.approval.state.decidedElsewhere` (LA-6); `local.firstRun.body` (LF-1) | as listed | (a) | M1-35c |
| S-9 | Missing | Keys for: the 11 §5.6 lines; receipt request and confirm; `agentlink_acknowledge` delivered; `requestReceipt` summary; export summary; contact flagged; own storage, backup and restore (07 copy table); `status --brief` output (06 §6.1); top-up not live; `policy recover`; the doctor line "Delivery receipts are on from an older default…" | 11 §5.6, 06, 07, D-100, D-109, D-115 | (a) | M1-35c |
| S-10 | Outdated | "Suggested relay" (never-say word) → "Suggested way to pass it on"; EmptyState "…and notarize it" → "…and add proof" | 11 §5.1, `d2/MANIFEST.md` | (a) | M1-35c |
| T-1 | Outdated | Terminal-copy shows the owner passphrase as the default prompt. The default is the generated owner code shown once; the passphrase only if the owner chooses it, never with a key file | D-67, 11 §5.5 | (a) | M1-35c |
| T-2 | Missing | Terminal flows: `approve` with no ID (review together), `backup export` / `restore`, `storage connect` / `disconnect`, `credits --topup` (not live), `verify` results, `policy recover`, `status --brief` | 06 §8, 07 copy table, 11 §6.10 | (a) | M1-35c |

## Components (`d1/components/*.md`, M1-35b)

| ID | Kind | Item | Follows | Class | Card |
|---|---|---|---|---|---|
| C-1 | Outdated | ApprovalCard: "Remember for this contact only for new-contact and proof-limit approvals" (LA-4); remove type `file-over-limit` (LA-5); add a disclosure slot (X-5); method names include owner code (X-10) | 06 §3, 11 §8 | (a) | M1-35b |
| C-2 | Missing | ApprovalCard batch variant for review together | D-68 | (b) B-2 | M1-35b |
| C-3 | Missing | CommitmentCard: the public receipt line (LA-8) | 11 §5.6 | (a) | M1-35b |
| C-4 | Outdated | ContactCard and UntrustedContent: unknown sender naming (X-7); ContactCard states `flagged` (proof mismatch) and pairing `mismatch`; no presence for contacts (X-11) | D-72, M1-7g-c | (a) | M1-35b |
| C-5 | Outdated | ReceiptTimeline: "Free receipts render lighter than paid proof receipts". Receipts are covered by the sender's proof fee; keep the lighter style for steps the recipient gave, and add not confirmed, asked, waiting to post | D-114, D-109 | (a) | M1-35b |
| C-6 | Outdated | CreditsMeter: "today's spend" → last 24 hours; Add credits only when the pay page is live | G-7, M1-26-e | (a) | M1-35b |
| C-7 | Missing | FileCard: removal mode per file and a removed state | M1-1g-i, D-98 | (a) | M1-35b |
| C-8 | Missing | StatusChip ("never invent statuses outside the list"): add Delivery requested, Flagged, Waiting to post | D-109, M1-7g-c, D-114 | (a) | M1-35b |
| C-9 | Missing | ProofBadge: `submitted` and needs credits | 06 §2.4 (`ProofStatus`) | (a) | M1-35b |
| C-10 | Missing | SafetyCode: "waiting for the other agent" state | 11 §8 | (a) | M1-35b |
| C-11 | Missing | New component: receipt request card | D-109 | (b) B-1 | M1-35b |
| C-12 | Missing | New component: export proof dialog | D-109, 07 §8 | (b) B-8 | M1-35b |

## Briefs for Claude Design

Paste one brief at a time. Every brief carries the same constraints, repeated so each stands alone.

### B-1 · Receipt request card (new component; Activity, contact detail, console home, browser accept)

> **Screen:** a new "receipt request" card, used in the local app's Activity list and contact detail, the console home attention list, and the browser accept flow. **Change:** when a contact asks for a delivery confirmation, show the request with **Confirm delivery** and **Not now**, and next to it a switch "Confirm deliveries from {contactName} automatically". **Why:** delivery receipts are now off by default because each one shows publicly that a proof reached your agent (D-109). **Copy (fixed):** "{contactName} asked you to confirm delivery. Confirming shows publicly that this reached your agent. Nothing about the content." After confirming: "This is public: anyone can see that your agent received it, and when." Switch help: "Confirm deliveries from {contactName} automatically? Each confirmation shows publicly that their proof reached your agent." **Constraints:** vocabulary of 11 §5.1 (no wallet, chain, transaction, on-chain); no network names; {contactName} follows the name rule (alias, or the quoted name with its identity label); no text written by the contact on the card; the switch needs the owner's passkey on save; production uses classes, no inline styles (CSP). **States:** asked · confirmed · not now (can confirm later) · auto-confirm on · offline · light, dark, increased contrast · 360 and 1280 wide.

### B-2 · Review together (local Approvals, console Approvals; ApprovalCard batch variant)

> **Screen:** Approvals, local web app and console. **Change:** a "Waiting for you (4)" view that lists one agent's pending approvals as full approval cards, soonest to expire first, at most 20. Each card has Approve, Deny and Later. Below the list, one button that names exactly what is included, e.g. "Approve 3 and deny 1", then the passkey (or owner code, or owner passphrase) once, with "This covers exactly these 4. Anything new waits for your next review." Accepting or rejecting terms is never in the list: its card says "Decide this one on its own" and has its own Approve. **Why:** owner decision D-68 (batch approval). **Constraints:** 11 §5.1 vocabulary; no network names; no default button and no autofocus on any Approve; the passkey prompt appears only after the summary button is clicked and is the browser's own; "Your AI can't approve this for you." on the view; production uses classes, no inline styles (CSP). **States:** nothing waiting · 1 · several · over 20 (the rest wait) · a card expires while reviewing · decided elsewhere · presence failed (nothing applied) · done with per-item results · light, dark, increased contrast · 360 and 1280.

### B-3 · Recovery kit and Backup (Local-recovery first-run step, Local-backup)

> **Screen:** the first-run "Save your recovery kit" step and the Backup page of the local web app. **Change:** a recovery kit is now a **file plus a recovery code** that is new for every kit, shown once, and opens only that kit. Export offers "Everything (contacts and history)" (default) or "Identity and contacts only", warns "Anyone with the kit and its recovery code can act as your agent and read its history, so keep them apart: the kit in your backups, the code in your password manager.", and confirms by typing the code's last four characters. Remove "Show recovery code" (there is no stored code to show again). Restore is not "replace this agent": it never overwrites, and it runs in a terminal on the new computer (`agentlink backup restore <file>`); the page explains that and shows the command. After a restore the computer shows "Stop the agent on your old computer now" and, if own storage was used, "Connect your storage again". **Why:** owner decision D-115 (A–E). **Constraints:** 11 §5.1 and §5.5 (the code is the "recovery code", never "password" or "seed phrase"); no network names; export needs the owner's passkey (D-117 A: export on this page, restore in the terminal only); the page never restores a kit; secrets use the secret display (Copy, Download, Print, confirm); production uses classes, no inline styles (CSP). **States:** no kit yet · exporting · code shown once · kit saved (date, kind) · export failed (nothing written) · restore explained · light, dark, increased contrast · 1280 and 360.

### B-4 · Own storage connect (Local-storage, Advanced)

> **Screen:** Storage in the local web app, the "Own storage (Advanced)" part. **Change:** a guided connect flow for an S3-compatible bucket: provider (R2, S3, Backblaze, Hetzner, Scaleway, MinIO, other) → short steps for that provider → endpoint, bucket, region → access key ID and secret ("They stay on this computer and are never shown again.") → test upload, download and delete → offer a lifecycle rule → approve with passkey → "Your storage works. Files too large to send inside a message now go to your own bucket." **D-117 (UX north star): credential entry stays in the terminal.** 06 §8 makes `agentlink storage connect` an interactive-terminal command (credentials read with echo off), and the page must not take the secret. So the page does not have a form for the endpoint and keys. It shows the status (not connected · connected · broken), the provider list with the short steps for each, and one step "Connect in terminal" with the command to copy (`agentlink storage connect`) and "Then come back: this page shows when it works". The page keeps Test again, Disconnect and Connect again (which shows the same command), each behind the passkey where it changes anything. The guided flow (provider → steps → endpoint, bucket, region → keys → test → lifecycle rule → approve) runs in the terminal, and the page shows its result: "Your storage works. Files too large to send inside a message now go to your own bucket." Plus a connected state (provider, bucket, last test, Test again, Disconnect: "Files you already sent stay in your bucket until their links expire.") and a broken state after a restore or a key problem: "Your own storage isn't working on this computer, so files that need it aren't sent." with Connect again (never falls back to the encrypted drop). **Why:** D-115 (credentials are not in the recovery kit) and 07 §5.2. **Constraints:** 11 §5.1 vocabulary; no network names; no field on the page takes a secret (credentials are typed only in the terminal, 06 §8); the encrypted drop stays the default and needs no setup; production uses classes, no inline styles (CSP). **States:** not connected · each step · test failed (which step) · private-address endpoint refused · connected · broken · disconnecting · light, dark, increased contrast · 1280 and 360.

### B-5 · Rules page update (Local-rules; console Rules later)

> **Screen:** Rules in the local web app. **Change:** add (1) a "Contact rules" list: each rule created by "Remember for this contact" or here, e.g. "Allow proofs for Marko up to $2.00 each without asking", with Remove; (2) "Confirm deliveries publicly: Off (recommended). Turn on for contacts you trust." and the contacts it is on for; (3) a review step shown when saving any rule while delivery receipts are still on from an older default: "Delivery receipts are on from an older default. Each one shows publicly that a proof reached your agent, never the content." with Keep on / Turn off (default off). Also relabel "Daily budget" to "Proof budget in any 24 hours" with "used in the last 24 hours". **Why:** contact rules (06 §3, D-90) and D-109. **Constraints:** 11 §5.1 and §5.6 wording; no network names; one save asks for the passkey once; "Accepting terms" keeps "Ask me every time (recommended)"; production uses classes, no inline styles (CSP). **States:** no contact rules · several · remove confirm · older-default review · rules couldn't be checked (everything asks; `agentlink policy recover`) · saving · saved · light, dark, increased contrast · 1280 and 360.

### B-6 · Pay page, crypto first (Pay)

> **Screen:** the pay page "Add credits" (separate origin, mobile first). **Change:** methods in this order: free test credits (testnets only); **Use crypto you already have**: connect the app or browser extension where you hold US-dollar stablecoins, show "From your account · $42.10 available", one confirmation, no network choice (picked from where the funds are); **Send from an exchange**: Agent ID with QR code and Copy, the coin, and, inside the opened exchange steps only, one informational line "Network: {network}" filled in for you (never a choice, D-117 B), the $5 minimum and what happens on a wrong network; **Pay by card** comes later and is not shown in the beta. Each method shows its privacy line once (e.g. "The account you add credits from is publicly linked to your agent. For more privacy, use free test credits or a separate account only for AgentLink."). Remove "Advanced · connect a browser wallet" and "choose Base (cheapest)". The page opens from a link carrying the Agent ID and a suggested amount, preselected. **Why:** D-111 (crypto first, card last), D-113 (link), D-40 (network chosen automatically), D-109 (privacy). **Constraints:** amounts in $ only; 11 §5.1 (our copy never says wallet, gas, deposit, transaction; the token appears only inside a method that needs it); no network name outside the exchange steps' one line; the word "wallet" never appears in our labels (D-117 C); the page never sees messages, files or keys; production uses classes, no inline styles (CSP). **States:** waiting · received ("Your agent turns this into credits the next time it runs") · added · below the minimum ("Received $3. The minimum is $5; send at least $2 more and your agent adds it all", D-117 D) · Agent ID mismatch · offline · damaged link ("This link is damaged. Ask your agent for a new one.") · save a payment record · light, dark · 360 and 1280.

### B-7 · Verify results (Verify)

> **Screen:** the public verify page. **Change:** design every result besides "valid": **Record only** (the record checks out, but the file doesn't confirm who sent the content), **Doesn't check out** (with its reason in plain words), **Not checked** (the file couldn't be read, or the public record couldn't be reached; nothing is decided), **Document matches / doesn't match** (when the file includes the document), the recipient line when the file doesn't include the recipient ("Recipient not included in this file"), and non-fatal warnings (a receipt link that doesn't confirm; a signer that no longer confirms) shown calmly under the result. Also the empty state: drop a file, **Choose file** button, or open a link. **Why:** D-95, D-96, D-105 and the 06 §8 verify outcomes; today only the valid result is drawn. **Constraints:** 11 §5.1 vocabulary ("public record", never chain or transaction); the record ID and network stay inside the collapsed "Details (Advanced)"; names in quotes with their identity label; result announced in a live region; production uses classes, no inline styles (CSP). **States:** empty · checking · each result above · offline · light, dark · 360 and 1280; print for valid and record only.

### B-8 · Export proof dialog (Proof detail, local Proofs, console)

> **Screen:** a new "Export proof" dialog, opened from proof detail and the proofs list. **Change:** choose what to share: proof file, printable record, verify link; two options off by default: "Include who received it" and "Include the document so they can open it" (the second asks for approval). The dialog states what the export shows, using the fixed line: "This file shows the proof, your agent profile and the message details. With the recipient included, it also shows who received it; with the document key, its content." Received proofs can be exported too. **Why:** D-109 (disclosure), D-107 (both sides export), 07 §8. **Constraints:** 11 §5.1 vocabulary ("document key" as in 11 §6.12, never "encryption key" or "decrypt"); no network names; the document option uses an approval with passkey; production uses classes, no inline styles (CSP). **States:** default · recipient on · document on (approval pending) · exported (where it was saved) · failed · light, dark, increased contrast · 360 and 1280.

### B-9 · First run with an existing owner code (Local-firstrun)

> **Screen:** first run, step 1 "Protect your approvals", local web app. **Change:** add the path for an owner who already set up an owner code in a terminal: "I already have an owner code" → enter it once (paste allowed) → create the passkey, which then replaces typing the code. Keep "Use an owner passphrase instead" for browsers without passkeys. Body text: "Approvals need you: each approval, or each list of approvals you review together, asks for your passkey, owner code or owner passphrase, and only after you click Approve. Never give them to your AI." **Why:** 08 §1 (the passkey is registered with one entry of the owner code), 11 §6.2.1, D-67, D-68. **Constraints:** 11 §5.5 code names (never "password"); the browser's passkey dialog is its own and is never drawn; the copy must not claim that an AI on this computer can never get around it; production uses classes, no inline styles (CSP). **States:** choose · owner code entry · wrong code (generic, tries left) · passkey created · passkey unsupported → passphrase · light, dark, increased contrast · 1280 and 360.

### B-10 · Windows Hello states (desktop approval window)

> **Screen:** the native approval window on Windows. **Change:** the biometric states, as already drawn for Touch ID: waiting for Windows Hello (face, fingerprint or PIN) · confirmed · cancelled · failed · unavailable → owner passphrase. **Why:** 11 §6.2.2; only the pending Windows state exists. **Constraints:** the Windows Hello prompt is the OS's own and is never drawn; the reason line names only the action and the owner's alias (no counterparty text); no default button; 11 §5.1 vocabulary; production uses classes, no inline styles (CSP). **States:** the five above · light, dark, high contrast (forced colours) · 440 wide.

## Owner decisions (not redesigns)

**All answered by the owner on 2026-10-21 (D-117): "let's go with your recommendations"** (A to D accepted; 5 and 6 were already settled by the spec).

1. **Answered → D-117 (A), accepted recommendation.** **Backup in the local UI or the terminal only.** 06 §8 marks `backup export` and `backup restore` as interactive-terminal commands, while 08 §1 and M1-11c list export and restore on the local Backup page; a restore also runs on a computer where no agent (and so no local page) exists yet. *Recommendation:* the page exports with the passkey and explains restore as the terminal command; B-3 is written that way.
2. **Answered → D-117 (B), accepted recommendation.** **Network line on the pay page (11 §14 Q5).** Show "Network: {network}" in the exchange method by default, or only when the user opens the exchange steps. *Recommendation:* inside the exchange method only, as 11 §5.1 allows; never as a choice.
3. **Answered → D-117 (C), accepted recommendation.** **"Wallet" in the connect method's label** (11 §5.1, open). *Recommendation:* keep it out of our copy; the third-party connector may use it.
4. **Answered → D-117 (D), accepted recommendation.** **Below-minimum top-ups.** A $5 minimum. Below it the page says "Received $3. The minimum is $5; send at least $2 more and your agent adds it all" (`topup-ux.md` §6, §7 #6). This fills the design's "[WHAT HAPPENS TO IT]".
5. **Settled by the spec (D-117 restates it).** **Update banner "its signature didn't match"** (`d2/MANIFEST.md`): keep the 11 §6 Updates string.
6. **Settled by the spec (D-117 restates it).** **Console restore of a computer's recovery kit.** The console restores its own kit (`ALKR`); nothing specifies restoring a computer's kit (`ALKK`) there. *Recommendation:* no; CN-6 adds one line pointing to the terminal.

## Summary

| Surface | Card | (a) | (b) |
|---|---|---|---|
| Cross-cutting | M1-35a–c and building cards | 12 | 0 |
| Local first run, recovery, approvals, states | M1-11b | 13 | 3 |
| Local settings (activity, contacts, files, storage, proofs, rules, backup, advanced) | M1-11c | 25 | 7 |
| Invite landing | M1-19-c | 3 | 0 |
| Browser accept | M2-13 | 2 | 0 |
| Verify, proof detail, print | M2-5a | 4 | 2 |
| Onboarding, pricing | M2-8 | 5 | 0 |
| Pay | M2-2f, M2-18b–d | 4 | 3 |
| Owner console | M2-2a–e, M2-12 | 6 | 1 |
| Cloud agent | M2-3 | 2 | 0 |
| Desktop | M2-11 | 4 | 1 |
| Copy (strings, chat, terminal) | M1-35c | 12 | 0 |
| Components | M1-35b | 9 | 3 |
| **Total** | | **101** | **20** |

The 20 (b) rows map to 10 briefs (B-1…B-10); several rows share one brief.

**Recommended order.**
1. **Now, in code (wave 0–1):** X-1…X-12, the copy (S-*, T-*) and the component (a) items in M1-35a–c; they unblock everything else.
2. **Owner, first:** B-1 (receipt request), B-2 (review together), B-9 (first run), B-3 (backup) and B-5 (rules): they sit on M1 surfaces (M1-11b, M1-11c). Agents build the rest of those screens meanwhile and leave these parts functional.
3. **Owner, next:** B-4 (own storage), B-8 (export), then the M1 invite page (M1-19-c) needs no brief.
4. **Owner, for M2:** B-7 (verify), B-6 (pay page, only when the pay page is scheduled; it stays off until then), B-10 (Windows Hello).
5. Owner decisions 1–4 are answered (D-117); B-3, B-4 and B-6 are written to match and can be briefed to Claude Design.
