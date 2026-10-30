# Design intake and status

The owner (Tali) designs the brand and the app in **Claude Design**, following the brief in `docs/foundation/11-claude-design-brief.md`. The single file to paste or upload into Claude Design is **[`claude-design-handoff.md`](claude-design-handoff.md)**, derived from the brief. The design arrives in three drops (D-30; schedule in `docs/foundation/10-build-plan.md` → *Design deliveries*). **Agents check this file before any UI work.**

## Status

| Drop | Contents | Needed by | Status | Where |
|---|---|---|---|---|
| **D1** | Brand core (11 §2, D-56): chosen direction, mark, wordmark, lockups, favicon, Claude Desktop extension / MCP server icon. In-chat copy sheet (§6.1) and terminal copy (§6.10); tokens (§11.7) and core components (§8); local settings and approvals app (§6.2.1, local web UI) with storage (§6.11) and the proof list (§6.12), with its states (§9); invite placeholder page. Optional, if the owner wants them early: desktop-app-ready versions of the local approval screens (approval, commitment approval, first run) | Week 3 of M1 | ✅ delivered, partial points (14 Oct 2026) | [`d1/`](d1/MANIFEST.md), [`brand/`](brand/MANIFEST.md) |
| **D2** | Full component library (incl. terms card, terms diff, printed record); OS app icons, tray and menu-bar icons, PWA and Web Push icons (§2.4); owner console (§6.3, desktop and mobile), whose screens also serve as the desktop app's dashboard (D-41); desktop apps for macOS, Windows and Linux (§6.2.2: tray menu, native approval window, biometric prompt states, AI app auto-setup, updates, per-OS chrome); cloud agent pages (§6.9); verify (§6.4, incl. proof of agreement and print); invite landing (§6.5) with one-link install and browser view-and-accept (D-35); onboarding (§6.6, leading with "paste this to your agent"); pay page (§6.7, separate origin) and pricing (§6.8); storage connectors (§6.11); registration and domain verification (§6.13); J8 negotiation screens; prototypes J1, J2, J4, J5, J8; rationale notes | Before the M1 gate | 🟡 first pass landed (14 Oct 2026); predates later decisions, needs adjustment (D-116, DESIGN-ADJ-1) | [`d2/`](d2/MANIFEST.md), [`brand/`](brand/MANIFEST.md) |
| **D3** | Brand final after the trademark check (M1-24); marketing site for the production domain (§6.15); social and README images | Before M3 public launch | ⏳ pending (social images arrived early, in `brand/social/`) | [`brand/`](brand/MANIFEST.md) |

### Intake of 14 Oct 2026

The owner exported the brand (`agentlink-brand`) and the application design (`agentlink-app-design`, first full pass) from Claude Design. Intake task: DESIGN-D1 (branch `docs/DESIGN-D1-intake`). Direction chosen: "Signal, run in a terminal" (dark first, graphite, one signal-orange accent, Geist). Claude Design links: none supplied. What did not come into git (and why) is listed in each `MANIFEST.md`.

| Item (11 §) | Status | Where and note |
|---|---|---|
| **D1** Brand core: mark, wordmark, lockups, one-colour, usage rules, favicon, AI-app icon (2) | delivered | `brand/`. Only one direction explored (owner's choice); name and marks not final until the trademark check (M1-24) |
| **D1** In-chat copy sheet (6.1) | delivered | `d1/copy/in-chat.md`, `strings.en.json` (109 keys), `d1/screens/copy/`. Tool names and permission titles are proposals; see "Drift from 11" below |
| **D1** Terminal copy (6.10) | delivered | `d1/copy/terminal.md`; no `cli.*` string keys |
| **D1** Tokens (11.7) | delivered | `d1/tokens/` (5 JSON, `tokens.css`, fonts with `OFL.txt`), `d1/design-system/contrast.md` |
| **D1** Core components (8) | delivered, partial | 31 specs and a reference bundle in `d1/components/`; increased contrast only for the approval card; rules editor and terms card exist as screens only |
| **D1** Local settings and approvals app (6.2.1), storage (6.11), proof list (6.12), states (9) | delivered, partial | `d1/screens/local/` (12 screens); dark only; states on state sheets |
| **D1** Invite "how to install" placeholder | delivered | Covered by the full invite landing, `d2/screens/invite/` |
| **D1** Optional desktop-ready approval, first run | delivered | `d1/screens/desktop-*` (approval windows), `d2/screens/desktop-macos/first-run--*` |
| **D2** Component library (terms diff, printed record, …) | partial | `TermsDiff` and 30 others; no standalone specs for negotiation thread, proof-of-agreement summary, printed record, biometric sheet, config diff, OAuth consent card, update banner |
| **D2** OS app, tray, PWA and Web Push icons (2.4) | delivered | `brand/icons/` |
| **D2** Owner console, desktop and mobile (6.3) | partial | `d2/screens/console/` (7); mobile is home only |
| **D2** Desktop apps for macOS, Windows, Linux (6.2.2) | partial | tray, approval windows, first run, auto-setup, dashboards, settings; no Windows Hello states |
| **D2** Cloud agent pages (6.9) | delivered | `d2/screens/cloud/` |
| **D2** Verify with proof of agreement and print (6.4, 6.12) | partial | valid result only; printed record A4 only |
| **D2** Invite landing, browser view-and-accept (6.5) | delivered | `d2/screens/invite/`, `accept/` (Q3 option A) |
| **D2** Onboarding (6.6), pay (6.7), pricing (6.8) | delivered | `d2/screens/onboarding/`, `pay/`, `pricing/` |
| **D2** Storage connectors (6.11), registration and domain verification (6.13) | partial | connectors only on the local Storage screen; registration and domain verification delivered in the console |
| **D2** J8 negotiation screens; options for the 11 §14 questions | partial | negotiation thread and commitment card delivered; one option each for Q1, Q3, Q4, Q5, Q7; Q2, Q6, Q8 not shown |
| **D2** Clickable prototypes J1, J2, J4, J5, J8 | **missing** | only a static screen gallery (`d2/source/screens/index.html`) |
| **D2** Rationale notes (13) | **missing** | the direction is recorded in the manifests only |
| **D3** Marketing site (6.15), final brand | **missing** | not due; social images (OG, GitHub preview) arrived early in `brand/social/` |

### Re-export of 15 Oct 2026 (DESIGN-D2 intake check)

The owner exported the brand and the application design again. Compared byte for byte with `docs/design/`, the application design (`agentlink-app-design`) is **identical** to the 14 Oct intake, so **no surface gained a design**: the Status table and the tables above stand and DESIGN-D2 stays partial. *Superseded by D-116 (21 Oct 2026):* surfaces with a delivered or partial screen are built styled from it, after DESIGN-ADJ-1; only surfaces with no screen stay functional and unstyled. The only new files are the logo and social JPG renderings, now in `brand/logo/jpg/` and `brand/social/` (see `brand/MANIFEST.md`). The production-domain and trademark check (M1-24) is still pending, so the brand is not final.

**Drift from 11.** The drop was designed from an older handoff text than `claude-design-handoff.md` here (pairing safety-code timing, scope of "Remember for this contact", per-contact proof rules, invite answered twice). **11 wins**; the differences are listed in `d1/MANIFEST.md`. The D2 vocabulary check (hits such as "owner key" in the console) is in `d2/MANIFEST.md`.

**Intake cards.** DESIGN-D1's acceptance is met (drop recorded), so M1-9g, M1-11b and the M1-19 restyle no longer wait on design (their other dependencies still apply). DESIGN-D2's first pass has landed (D-116): UI cards build every surface that has a screen below, styled, once DESIGN-ADJ-1 has listed its adjustments; surfaces with no screen stay functional and unstyled until the owner delivers or waives them.

## Design adjustment (D-116)

**Owner, in chat, 2026-10-21:** "Please write in the build plan because this was built from the beginning And for some reason we did not know that it existed", and "The design must be adjusted. It was built before we fine-tuned everything."

D1 and the D2 first pass are the visual basis. They were designed on 14 Oct 2026, before later decisions, so each surface is adjusted before or while it is built. Card **DESIGN-ADJ-1** (Opus, S0) writes `docs/design/adjustments.md`: per screen, what is outdated, missing or to remove, each item marked **(a) agents fix in code** (copy, small flow changes) or **(b) owner redesigns in Claude Design** (layout, new screens), with a paste-ready brief per (b) item: **[`adjustments.md`](adjustments.md)** (in review). Decisions that may affect screens and copy: D-56 onward, especially D-96…D-115:

- D-109: delivery receipts off by default, a receipt request and confirm UI, and the 11 §5.6 proof privacy disclosure lines;
- D-111…D-114: top-up direction (crypto first, card last), messages and files free, the top-up link format, who pays for receipts;
- the pay page and top-up link are gated off until the pay page ships (`PAY_PAGE.live`, M1-26-e);
- D-115: backup and restore (`ALKK` recovery kit, fresh recovery code, restore never overwrites, storage reconnected after restore);
- D-39, D-40: networks only under Advanced, the funded network chosen automatically.

`packages/ui` tokens and fonts (M1-35a) start in parallel; the other UI cards wait for DESIGN-ADJ-1.

**Production rules.** The `.dc.html` screens and `d2/source/screens/support.js` are previews: they never ship. Production is rebuilt in TypeScript in `packages/ui` with classes, because the 08 §4 CSP forbids inline styles. The PNGs are the visual reference. The Lucide ISC notice ships with the first Lucide path (M1-35a).

### Screen index

Source previews are in `d2/source/screens/<Name>.dc.html`; PNGs as listed. "Card" is the card that builds the surface.

| Surface | Screens (preview name → PNG) | Card |
|---|---|---|
| Tokens, fonts, icons | `d1/tokens/`, `d1/design-system/`, `brand/icons/ui/` | M1-35a |
| Core components (31 specs) | `d1/components/*.md`, `d1/components/reference/`; `d1/screens/components/approval-card--all-states` | M1-35b (M2-1b for D2-only parts) |
| Copy | `d1/copy/strings.en.json`, `in-chat.md`, `terminal.md`; Chat-copy, Terminal-copy → `d1/screens/copy/` | M1-35c |
| Local UI: first run | Local-firstrun → `d1/screens/local/first-run--protect-approvals`; Local-recovery → `first-run--recovery-kit` | M1-11b |
| Local UI: approvals, states | Local-approvals → `approvals--pending`; Local-states → `shared-states--all`; Approval-light, Approval-contrast, Approval-states, Commitment-mobile → `d1/screens/mobile/` | M1-11b |
| Local UI: settings | Local-activity, Local-contacts, Local-files, Local-storage, Local-proofs (`proofs-credits`), Local-rules, Local-backup (`backup--restoring`), Local-advanced → `d1/screens/local/` | M1-11c |
| Invite landing | Invite-landing → `d2/screens/invite/invite-landing--default--light--360` | M1-19-c (M2-5b later) |
| Browser view-and-accept | Accept-browser → `d2/screens/accept/` | M2-13 |
| Verify, proof detail, printed record | Verify → `d2/screens/verify/`; Proof-detail → `d2/screens/desktop-macos/proof-of-agreement--recorded`; Print-record → `d2/screens/print/` | M2-5a |
| Onboarding | Onboarding → `d2/screens/onboarding/` | M2-8 |
| Pay, pricing | Pay → `d2/screens/pay/`; Pricing → `d2/screens/pricing/` | M2-2f, M2-18b–d; pricing with M2-8 |
| Owner console | Console-signin, Console-home, Console-mobile-home, Console-negotiation, Console-agents, Console-credits, Console-settings → `d2/screens/console/` | M2-2a–e, M2-12 |
| Cloud agent | Cloud-setup, Cloud-signin, Cloud-status → `d2/screens/cloud/` | M2-3 |
| Desktop (M2, D-31…D-41) | Desktop-tray, Desktop-approval-mac, -windows, -touchid, Desktop-welcome, Desktop-firstrun-setup, Desktop-dashboard-windows, Desktop-linux, Desktop-settings → `d1/screens/desktop-*`, `d2/screens/desktop*` | M2-11b–g |
| Gallery | Main, `index.html` (preview only) | — |

### Known gaps and copy issues

- **Gaps:** no clickable prototypes (J1, J2, J4, J5, J8) or rationale notes; light and increased-contrast themes sparse (approval card only); verify shows the valid result only; printed record A4 only; no Windows Hello states; open questions Q2, Q6, Q8 not shown; standalone specs missing for the negotiation thread, proof-of-agreement summary, printed record, biometric sheet, config diff, OAuth consent card and update banner; D3 (marketing site, final brand) not present. Missing because of later decisions (DESIGN-ADJ-1 confirms): receipt request and confirm UI (D-109), the 11 §5.6 disclosure lines, top-up gated off, backup and restore per D-115, own storage connect.
- **Copy, fix before building:** Pay "If your exchange asks for a network, choose Base (cheapest)" names a network in the default UI (D-40, 11 §5); verify and proof detail show raw `0x…` record IDs in the default view (move to Advanced or detail); `strings.en.json` needs a full 11 §5 audit (M1-35c); "owner key" and similar hits in the console (`d2/MANIFEST.md`).
- **Licence:** the Lucide ISC notice is not in the reference bundle and must ship with `packages/ui` (M1-35a). Geist and Geist Mono are SIL OFL 1.1 (`d1/tokens/fonts/OFL.txt`).

**Design briefs.** Briefs for flows the owner has set a direction for, ahead of their design drop: [`topup-ux.md`](topup-ux.md), adding credits on the pay page (D-111, direction only). [`b11-local-app.md`](b11-local-app.md), brief B-11 for the owner: a state-of-the-art local app (Home, live state, motion, "Under the hood"; v2 decisions taken 2026-10-27, D-132; §19 paying for proof and registration with one confirmation sheet), DESIGN-B11; nothing built until the owner approves the screens (D-116).

When a drop lands, the orchestrator records it here: the date, the links or files, and the delivered or partial status. It then schedules the intake tasks from the backlog.

### Motion kit (wave 4, W4-MOTION-KIT)

The motion values of the owner-approved wave-4 prototype (v23) are tokens, added to the D1 source (`d1/tokens/tokens.source.json`, `d1/tokens/tokens.css`) and to `packages/ui` (`tokens.css`, `motionTokens`): `--al-duration-press` 150 ms, `-fade` 160, `-exit` 180, `-crossfade` 220, `-reveal` 300, `-page` 340, `-shimmer` 1200, `-pulse` 1600; `--al-easing-spring` (a CSS `linear()` spring that settles at exactly 1), `-overshoot`, `-pop`, `-ping`. Transitions stay within 150–350 ms and move only opacity and transform (`motion-lint.test.ts`).

Every wave-4 screen takes motion and loading from the kit in `@4thtech-io/ui` (`motion.css`), never local keyframes or a motion library:

- `useViewTransition()` / `startViewTransition()`: same-document View Transitions for page changes and the simple-to-pro morph; regions named by `VT_CLASS`, one shared element via `from` / `to` (`data-vt-shared`). No API: the update runs at once and `.al-route` fades up.
- Skeletons in the real layouts after 300 ms: `SkeletonGate`, `SkeletonRow`, `SkeletonCard`, `SkeletonList`, `SkeletonTable`, `SkeletonLine`.
- `Pulse` (live dot while working), `useOptimisticItems` (sent items appear at once), the existing `ProgressBar` for transfers, and the moment classes `.al-reveal`, `.al-pop`, `.al-draw`, `.al-menu`, `.al-press`, `.al-crossfade`.
- Reduced motion (system or the app's setting): fades only, no pulse, still skeletons. In e2e, `e2e/test/helpers/motion.ts` checks it (`emulateReducedMotion`, `expectFadesOnly`) and the layout shift (`observeLayoutShift`, `expectStableLayout`, CLS ≤ 0.01).

## Rules for agents

1. **Check the Status and the screen index first.** This file is the only design status (D-116, LL-16). A surface with a screen in the index is built **styled** from it, after DESIGN-ADJ-1, using `packages/ui`. Only a surface with no screen is built functional and unstyled: semantic HTML, accessible markup (WCAG 2.2 AA, keyboard navigation, visible focus) and placeholder CSS variables. **Never invent a visual design**, colour scheme, icon or brand for it.
2. **Copy.** Until the D1 copy sheet lands, user-facing strings follow the vocabulary in 11 §5 and live in externalized string files, so they can be swapped without code changes. The product name is `{productName}` in strings, never hard-coded in images.
3. **Implementation target** (11 §11.7):
   - tokens become CSS variables plus JSON in `packages/ui`;
   - React components go in `packages/ui`;
   - fonts and icons are self-hosted;
   - light, dark and increased-contrast themes;
   - no external CDNs.
4. **Fidelity.** Implement the design as delivered. Any deviation, whether technical, accessibility or security (e.g. the CSP forbids something), is written up in the PR and needs the owner's OK.
5. **Intake.** The orchestrator routes design-to-code work to Sonnet, and anything touching keys, passkeys, approvals or the deposit page to Opus (S1/S2 per `docs/process/audit-rules.md`).
6. **Keep the handoff in sync.** A PR that changes 11 updates `claude-design-handoff.md` in the same PR, or says in the PR why it doesn't need to. On conflict, 11 wins.

## How the owner delivers

Use either or both:
- **Claude Design links:** paste the links into the drop's `MANIFEST.md`. They are for people; whether agents can read Claude Design links is unverified (check before D1), so agents build only from exported files.
- **Exported files:** committed under `docs/design/` as below. This repo is public; anything that must stay private goes to `agentlink-ops`.

### Folder layout

```
docs/design/
  README.md                   # this file
  claude-design-handoff.md    # the file given to Claude Design
  brand/                      # current approved brand; any drop may update it
    MANIFEST.md
    brand-guidelines.md       # the brand export's own usage rules
    logo/                     # mark, wordmark, lockups: SVG + PNG
    icons/app/{macos,windows,linux,web,ai-apps,source}/
    icons/tray/{macos,windows,linux}/
    icons/ui/                 # custom UI icons, SVG on the 24 px grid (+ PNG)
    colors/                   # palette.json, colors.md
    social/                   # D3
  d1/  d2/  d3/               # one folder per drop
    MANIFEST.md
    tokens/                   # base.json, theme-light.json, theme-dark.json,
                              # theme-light-contrast.json, theme-dark-contrast.json, tokens.css
                              # (+ fonts/ with the OFL licence when tokens.css loads them)
    copy/                     # strings.en.json (ICU MessageFormat), in-chat.md, terminal.md
    components/               # <component>.md + PNGs; reference/ = reference bundle and previews
    source/                   # exported live HTML, only when small (see MANIFEST.md)
    screens/<surface>/        # PNG screens
    print/                    # printed record samples, PDF (D2)
```

### File naming

- **Screens:** `screens/<surface>/<screen>--<state>--<theme>--<size>.png`, e.g. `screens/console/approval-card--pending--dark--360.png`. Themes: `light`, `dark`, `contrast`. Sizes: `360`, `768`, `1280`, `1440`, `440` (approval window), `960` (dashboard window), `a4`, `letter`. Desktop surfaces name the OS: `desktop-macos`, `desktop-windows`, `desktop-linux`.
- **Brand assets:** `agentlink-<asset>-<variant>[-<size>].<ext>`, e.g. `agentlink-mark-mono-16.png`, `agentlink-tray-macos-approvals-36.png`.
- **Tokens:** W3C Design Tokens JSON plus `tokens.css`, named per 11 §11.7.
- Lowercase, hyphens, no spaces.

### What to export

- **Minimum PNG set** (keeps a drop under about 25 MB): each screen's default state in light and dark at its primary size; key components (approval card, commitment card, untrusted container, safety code, proof badge) also in increased contrast; all brand assets.
- **Everything else** (other states, sizes, prototypes) stays in the Claude Design project, linked from `MANIFEST.md`. If Claude Design offers an HTML or handoff-bundle export, include it when small or link it; at intake an agent renders further PNGs from it with a headless browser.
- **Formats Claude Design may not produce:** tokens as W3C JSON, ICO and ICNS, and every PNG icon size are requested "if available". Otherwise export the CSS or a token table and the SVG masters, and the intake agent converts them.

### Size and source files

- PNG screens are optimized, 1× or 2× only, ideally under 500 KB each; aim for under 25 MB per drop folder.
- SVGs are optimized and contain no scripts, external references or embedded raster images.
- **Large sources stay out of git:** design project files, video prototypes and layered masters over a few MB stay in Claude Design or private storage, linked from `MANIFEST.md`.
- **Git LFS: not now.** With the limits above, plain git is enough, and LFS on the GitHub Free plan has small storage and bandwidth quotas that every public clone would consume. Revisit only if the design folders grow past about 100 MB; adding LFS or a `.gitattributes` rule is an owner decision.

### MANIFEST.md (one per folder)

- Drop, date, Claude Design links and the chosen direction.
- Contents (folders, counts) and what is partial.
- Decisions taken and options shown for the open questions in 11 §14.
- Open points and known deviations.
- Fonts and icon set, with licences and source links.
- A line confirming nothing private is included (no real personal data, keys or addresses, nothing from docs 01 or 09, no unreleased security details).
