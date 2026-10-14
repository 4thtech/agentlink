# Design intake and status

The owner (Tali) designs the brand and the app in **Claude Design**, following the brief in `docs/foundation/11-claude-design-brief.md`. The single file to paste or upload into Claude Design is **[`claude-design-handoff.md`](claude-design-handoff.md)**, derived from the brief. The design arrives in three drops (D-30; schedule in `docs/foundation/10-build-plan.md` → *Design deliveries*). **Agents check this file before any UI work.**

## Status

| Drop | Contents | Needed by | Status | Where |
|---|---|---|---|---|
| **D1** | Brand core (11 §2, D-56): chosen direction, mark, wordmark, lockups, favicon, Claude Desktop extension / MCP server icon. In-chat copy sheet (§6.1) and terminal copy (§6.10); tokens (§11.7) and core components (§8); local settings and approvals app (§6.2.1, local web UI) with storage (§6.11) and the proof list (§6.12), with its states (§9); invite placeholder page. Optional, if the owner wants them early: desktop-app-ready versions of the local approval screens (approval, commitment approval, first run) | Week 3 of M1 | ✅ delivered, partial points (14 Oct 2026) | [`d1/`](d1/MANIFEST.md), [`brand/`](brand/MANIFEST.md) |
| **D2** | Full component library (incl. terms card, terms diff, printed record); OS app icons, tray and menu-bar icons, PWA and Web Push icons (§2.4); owner console (§6.3, desktop and mobile), whose screens also serve as the desktop app's dashboard (D-41); desktop apps for macOS, Windows and Linux (§6.2.2: tray menu, native approval window, biometric prompt states, AI app auto-setup, updates, per-OS chrome); cloud agent pages (§6.9); verify (§6.4, incl. proof of agreement and print); invite landing (§6.5) with one-link install and browser view-and-accept (D-35); onboarding (§6.6, leading with "paste this to your agent"); pay page (§6.7, separate origin) and pricing (§6.8); storage connectors (§6.11); registration and domain verification (§6.13); J8 negotiation screens; prototypes J1, J2, J4, J5, J8; rationale notes | Before the M1 gate | 🟡 partial, first pass (14 Oct 2026) | [`d2/`](d2/MANIFEST.md), [`brand/`](brand/MANIFEST.md) |
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

**Drift from 11.** The drop was designed from an older handoff text than `claude-design-handoff.md` here (pairing safety-code timing, scope of "Remember for this contact", per-contact proof rules, invite answered twice). **11 wins**; the differences are listed in `d1/MANIFEST.md`. The D2 vocabulary check (hits such as "owner key" in the console) is in `d2/MANIFEST.md`.

**Intake cards.** DESIGN-D1's acceptance is met (drop recorded), so M1-9g, M1-11b and the M1-19 restyle no longer wait on design (their other dependencies still apply). DESIGN-D2 is partial: M2-1a can start from the delivered tokens and components; M2-1b, M2-5a/b and M2-11g build only the surfaces listed as delivered and keep the rest functional and unstyled until the owner delivers or waives the missing items.

When a drop lands, the orchestrator records it here: the date, the links or files, and the delivered or partial status. It then schedules the intake tasks from the backlog.

## Rules for agents

1. **No design yet means functional and unstyled.** Use semantic HTML, accessible markup (WCAG 2.2 AA, keyboard navigation, visible focus) and placeholder CSS variables. **Never invent a visual design**, colour scheme, icon or brand for a surface whose drop hasn't landed.
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
