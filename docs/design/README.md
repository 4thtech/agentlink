# Design intake and status

The owner (Tali) designs the brand and the app in **Claude Design**, following the brief in `docs/foundation/11-claude-design-brief.md`. The single file to paste or upload into Claude Design is **[`claude-design-handoff.md`](claude-design-handoff.md)**, derived from the brief. The design arrives in three drops (D-30; schedule in `docs/foundation/10-build-plan.md` → *Design deliveries*). **Agents check this file before any UI work.**

## Status

| Drop | Contents | Needed by | Status | Where |
|---|---|---|---|---|
| **D1** | Brand core (11 §2, D-56): chosen direction, mark, wordmark, lockups, favicon, Claude Desktop extension / MCP server icon. In-chat copy sheet (§6.1) and terminal copy (§6.10); tokens (§11.7) and core components (§8); local settings and approvals app (§6.2.1, local web UI) with storage (§6.11) and the proof list (§6.12), with its states (§9); invite placeholder page. Optional, if the owner wants them early: desktop-app-ready versions of the local approval screens (approval, commitment approval, first run) | Week 3 of M1 | ⏳ pending | — |
| **D2** | Full component library (incl. terms card, terms diff, printed record); OS app icons, tray and menu-bar icons, PWA and Web Push icons (§2.4); owner console (§6.3, desktop and mobile), whose screens also serve as the desktop app's dashboard (D-41); desktop apps for macOS, Windows and Linux (§6.2.2: tray menu, native approval window, biometric prompt states, AI app auto-setup, updates, per-OS chrome); cloud agent pages (§6.9); verify (§6.4, incl. proof of agreement and print); invite landing (§6.5) with one-link install and browser view-and-accept (D-35); onboarding (§6.6, leading with "paste this to your agent"); pay page (§6.7, separate origin) and pricing (§6.8); storage connectors (§6.11); registration and domain verification (§6.13); J8 negotiation screens; prototypes J1, J2, J4, J5, J8; rationale notes | Before the M1 gate | ⏳ pending | — |
| **D3** | Brand final after the trademark check (M1-24); marketing site for the production domain (§6.15); social and README images | Before M3 public launch | ⏳ pending | — |

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
- **Claude Design links:** paste the artifact links here or into the drop's `MANIFEST.md`, or give them to the orchestrator. Agents read them with the Artifact tool.
- **Exported files:** committed under `docs/design/` as below. This repo is public; anything that must stay private goes to `agentlink-ops`.

### Folder layout

```
docs/design/
  README.md                   # this file
  claude-design-handoff.md    # the file given to Claude Design
  brand/                      # current approved brand; any drop may update it
    MANIFEST.md
    logo/                     # mark, wordmark, lockups: SVG + PNG
    icons/app/{macos,windows,linux,web,ai-apps}/
    icons/tray/{macos,windows,linux}/
    icons/ui/                 # custom UI icons, SVG on the 24 px grid
    social/                   # D3
  d1/  d2/  d3/               # one folder per drop
    MANIFEST.md
    tokens/                   # base.json, theme-light.json, theme-dark.json,
                              # theme-light-contrast.json, theme-dark-contrast.json, tokens.css
    copy/                     # strings.en.json (ICU MessageFormat), in-chat.md, terminal.md
    components/               # <component>.md + PNGs
    screens/<surface>/        # PNG screens
    print/                    # printed record samples, PDF (D2)
```

### File naming

- **Screens:** `screens/<surface>/<screen>--<state>--<theme>--<size>.png`, e.g. `screens/console/approval-card--pending--dark--360.png`. Themes: `light`, `dark`, `contrast`. Sizes: `360`, `768`, `1280`, `1440`, `440` (approval window), `960` (dashboard window), `a4`, `letter`. Desktop surfaces name the OS: `desktop-macos`, `desktop-windows`, `desktop-linux`.
- **Brand assets:** `agentlink-<asset>-<variant>[-<size>].<ext>`, e.g. `agentlink-mark-mono-16.png`, `agentlink-tray-macos-approvals-36.png`.
- **Tokens:** W3C Design Tokens JSON plus `tokens.css`, named per 11 §11.7.
- Lowercase, hyphens, no spaces.

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
