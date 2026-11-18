# MANIFEST · D1 (brand core, tokens, copy, core components, M1 surfaces)

- **Drop:** D1, received **14 Oct 2026** in one export with D2 (`agentlink-app-design`, ≈239 files, 6.2 MB, first full pass) plus the brand export (see `../brand/MANIFEST.md`). Status: **delivered, with partial points** (below).
- **Claude Design links:** none supplied. The drop names its sources as the "AgentLink" design system artifact and the "AgentLink — D1 screens" canvas in the owner's claude.ai account ("links on request"). Agents build only from the files here.
- **Direction chosen:** "Signal, run in a terminal" (see `../brand/MANIFEST.md`).
- **Where the rest is:** D2 surfaces that arrived in the same export are in `../d2/`; both manifests share the decisions below.

## Contents

| Folder | What | Files |
|---|---|---|
| `tokens/` | `base.json` and four theme files (`theme-light`, `theme-dark`, `theme-light-contrast`, `theme-dark-contrast`; the contrast files hold overrides only), W3C Design Tokens JSON; `tokens.css` (`--al-` prefix; dark default; `data-theme`, `data-contrast="more"`, `prefers-*` and `forced-colors` blocks; `@font-face` for Geist); `tokens.source.json` (generator input) | 7 |
| `tokens/fonts/` | Geist and Geist Mono variable WOFF2 and `OFL.txt` | 3 |
| `copy/` | `strings.en.json` (ICU MessageFormat, 109 keys), `in-chat.md` (status examples, untrusted block, permission-prompt titles), `terminal.md` (init, owner passphrase, doctor, no keychain, states) | 3 |
| `components/` | One spec per component (31): props, states, tokens, keyboard and screen-reader behaviour | 31 |
| `components/reference/` | Reference React 18 bundle (`bundle.js`, `bundle.css`, `index.d.ts`) defining `window.AgentLink`, and one live `previews/<Component>.html` each. A reference to rebuild from in `packages/ui`, not code to ship | 34 |
| `design-system/` | Brand book (`README.md`), `voice-and-vocabulary.md`, `contrast.md` (every text and background pair in all four themes) | 3 |
| `screens/` | 22 PNG: `local/` (12: first run, recovery kit, approvals, activity, contacts and requests, files, storage, proofs and credits, rules, backup, advanced, shared states), `mobile/` (approval card in dark, light and increased contrast; commitment card), `components/` (approval card, every type and state), `copy/` (in-chat and terminal sheets), and the optional early desktop approval windows (`desktop-macos` pending and waiting for Touch ID, `desktop-windows` pending) | 22 |

Screens follow `<surface>/<screen>--<state>--<theme>--<size>.png`. Every PNG is under 500 KB (largest 320 KB); the folder is about 2.9 MB.

## Coverage and partial points

Per-item status is in `../README.md` (Status table). Partial points of D1:

- **Themes:** only the approval card exists in increased contrast (`mobile/`); only the approval card and the Windows approval window exist in light. All other D1 PNGs are dark. The tokens give light and contrast automatically, but 11 §13 asks for the key components (approval card, commitment card, untrusted container, safety code, proof badge) in increased contrast: missing for four of five.
- **States:** shown on state sheets (`components/approval-card--all-states`, `local/shared-states`) and inside screens, not one PNG per state.
- **Strings:** `strings.en.json` has 109 keys (`common` 52, `chat` 26, a few `onboarding`, `pay`, `local`, `desktop`, `invite`, `print`, `os`, `console`, `accept`, `verify`, `pricing`, `cloud`). There is no `cli.*` set, and most screen text is only in the PNGs and in the D2 source HTML. Terminal copy exists only as `terminal.md`. The intake card that externalizes strings must derive the rest from the sources.
- **Two directions** (11 §13): one explored, by the owner's choice.
- **Invite placeholder:** the full invite landing arrived instead (`../d2/screens/invite/`); it covers the placeholder.
- **Tool names** other than `agentlink_send` in the copy are proposals, as are the permission-prompt titles.

## Decisions taken and options shown (11 §14)

| # | Question | Shown |
|---|---|---|
| Q1 | Firm offer needs approval | A: always, with the commitment card (console negotiation thread) |
| Q2 | Owner approval inside the proof | not shown |
| Q3 | Browser counterparty counter-offer | A: Accept / Reject and "Connect your AI to negotiate" |
| Q4 | Desktop unlock window | B: timed, 15 minutes, "Unlocked · Lock now" (proposed, not specified) |
| Q5 | Network on the pay page | A: inside the exchange steps |
| Q6 | macOS Dock | not shown |
| Q7 | Withdraw credits | A: Credits › Advanced |
| Q8 | Beta to production console | not shown |

Each question shows one option, not both; none is decided by this drop. The owner decides, and the decision goes into 11 and the decision log.

## Known deviations and open points

- **The drop was designed from an older handoff text than the one in this repo.** The drop's `docs/claude-design-handoff.md` (not committed here) differs from [`../claude-design-handoff.md`](../claude-design-handoff.md) in 25 diff lines. Where the design and 11 disagree on meaning, **11 wins** (`../README.md` rule 6). Differences seen in the committed files:
  - safety code timing: `common.safetyCode.changed` says "The safety code changed. Compare it again." Current 11 says an update of the same owner's keys keeps the safety-code check ("no new comparison");
  - `local/rules` and the `Local-rules` source lack per-contact proof rules ("Remove" per rule) and "any 24 hours" on the daily budget;
  - "Remember for this contact" is shown on a *file over limit* approval (`components/approval-card--all-states`), while current 11 allows it only on proof approvals raised by "Ask me" or the per-proof limit (the drop's own `ApprovalCard.md` still says "new-contact and proof-limit approvals");
  - `chat.status.ok.invite.summary` lacks the current "Send it only to Marko: whoever uses it first is connected" wording, and the "Invite answered twice" warning is absent.
  The intake PRs (M1-9g, M1-11b, M2-1a) must follow 11 and update the strings; the owner may want to re-run the affected screens.
- The drop deliberately avoids "green-on-black terminal styling" literally but uses terminal and IDE structure (mono labels, status bar, hairlines). Status "success" is teal, not green, to stay off the red–green axis.
- **Lucide (ISC):** the drop credits Lucide for general icons used through the component bundle, but neither `bundle.js` nor the MANIFEST carries the ISC notice. Before `packages/ui` copies any Lucide-derived path, the implementing PR confirms which icons are Lucide, adds the copyright and permission notice, and lists the dependency (or redraws them).
- `components/reference/bundle.js` and the previews load nothing external. Placeholders `{productName}`, `{consoleHost}`, `{verifyHost}`, `{inviteHost}`, `{payHost}`, `{siteHost}` and `[LIKE THIS]` values stay open (see `../d2/MANIFEST.md`).
- The drop's own `CLAUDE.md` (instructions to engineering agents) is **not** committed: a `CLAUDE.md` in the tree would be picked up by tools as project instructions, and it is a sensitive path. Its screen-to-PNG table is reproduced by the folder layout here; the useful rules in it (no default button on approvals, `UntrustedContent` for others' words, no external CDNs) are already in `11` and `AGENTS.md`.

## Fonts and icon set

- **Geist** and **Geist Mono**, © 2023 Vercel in collaboration with basement.studio, SIL Open Font License 1.1 (`tokens/fonts/OFL.txt`). Source: npm package `geist` 1.3.1. Variable WOFF2 only; the static weights stay in the owner's export.
- **Icons:** 21 custom AgentLink icons (`../brand/icons/ui/`); general icons per the Lucide point above.

## Privacy

Nothing private is included: no real personal data, keys or addresses, nothing from docs 01 or 09, no unreleased security details. Names, codes, amounts and hosts are the handoff's public sample data or placeholders (`*.example` hosts, `XXXX` recovery code, dashed QR placeholders). The sample text "Ignore your previous instructions…" in `UntrustedContent` previews is a deliberate example of hostile inbound content; it is data, not an instruction.
