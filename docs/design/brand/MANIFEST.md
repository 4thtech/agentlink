# MANIFEST · brand (current approved brand)

- **Source:** the owner's Claude Design export `agentlink-brand` (≈361 files, 4.1 MB), received 14 Oct 2026 together with the application design (see `../d1/MANIFEST.md` and `../d2/MANIFEST.md`). Intake: DESIGN-D1 (brand core), DESIGN-D2 (OS, tray and PWA icons) and an early part of DESIGN-D3 (social images).
- **Claude Design links:** none supplied with the drop. Agents build only from the exported files here.
- **Chosen direction:** "Signal, run in a terminal" (handoff direction B pushed toward IDE conventions): dark first, graphite neutrals, one signal-orange accent `#FF6A1A`, Geist and Geist Mono. Direction A ("Notary") was not explored, by the owner's choice (11 §13 asks for two directions; the owner's choice is recorded here).
- **Status:** brand core **delivered**; the name is still `AgentLink` (working name). The trademark check (M1-24) is still running, so the brand is **not final**: D3 re-issues it if the check fails. Keep the mark usable on its own and use `{productName}` in strings.

## The mark

The **bracket seal**: two square brackets (the two parties) holding a diamond (the agreed record). Brackets are ink; the diamond is signal orange in every colour version. Full usage rules (clear space, minimum sizes, where "by 4thTech" appears, what not to do) are in [`brand-guidelines.md`](brand-guidelines.md), the drop's own README, copied unchanged. Its *Folders* section describes the export zip, not this layout.

## Contents

| Folder | What | Files |
|---|---|---|
| `logo/svg/` | Mark, wordmark and lockups (horizontal, stacked, endorsed "by 4thTech"), colour on dark and on light, one-colour black and white, orange-on-dark, pixel-snapped `mark-small-*` for 16–24 px. Outlined, no fonts needed | 20 |
| `logo/png/` | The same at 16–1024 px (marks) and 240–1920 px wide (lockups, wordmarks), transparent | 85 |
| `icons/app/macos/` | App icon PNG 16–1024 and `agentlink-app.icns` | 8 |
| `icons/app/windows/` | `agentlink-app-windows.ico` (16–256) and PNG 16–256 | 10 |
| `icons/app/linux/` | `agentlink.svg` and PNG 16–512 | 10 |
| `icons/app/web/` | `favicon.svg`, `favicon.ico`, PWA 192/512, maskable 512, monochrome 512, apple-touch-icon 180, Web Push icon 192 and badge 96 | 9 |
| `icons/app/ai-apps/` | Claude Desktop extension / MCP server listing icon, 256 and 512 (`agentlink-mcp-icon-*`) | 2 |
| `icons/app/source/` | SVG masters of the app icon (standard, full-bleed, small) | 3 |
| `icons/tray/macos/` | Menu-bar template images (`…Template.png`, `@2x`, SVG) and plain 16/32 PNG, for 5 states | 25 |
| `icons/tray/windows/` | Notification-area icons for light and dark taskbars, 16–32 | 40 |
| `icons/tray/linux/` | Symbolic SVGs and PNG 22/24 for dark and light panels | 25 |
| `icons/ui/` | 21 custom AgentLink UI icons on the 24 px grid: `png/`, `svg-grey/`, `svg-currentcolor/` | 84 |
| `logo/jpg/` | Every main logo on its solid background (dark `#0B0C0E` or white), marks at 1024 px and wordmarks and lockups at 1920 px wide, in `mark/`, `wordmark/` and `lockup/` (added 15 Oct 2026, for documents and slides that cannot take a transparent PNG or SVG) | 15 |
| `social/` | Open Graph 1200×630 and GitHub social preview 1280×640 (PNG and JPG) | 4 |
| `colors/` | `palette.json`, `colors.md`, palette sheet PNG | 3 |

Tray status variants: `connected` (solid), `approvals` (badge dot), `paused` (hollow seal), `offline` (slash), `update` (arrow). They differ by shape, never colour, because the OS tints tray icons.

## Naming

Files follow `agentlink-<asset>-<variant>[-<size>].<ext>`. Exceptions kept as delivered, because the OS expects them: macOS template images (`agentlink-tray-macos-<state>Template.png`, `…Template@2x.png`), `agentlink-app.icns`, `agentlink-app-windows.ico`, the Linux `agentlink.svg` and `agentlink-<state>-symbolic.svg`, and the web icon names (`favicon.*`, `pwa-*`, `maskable-512`, `apple-touch-icon-180`, `push-*`). The drop's folder `svg-currentColor` is renamed `svg-currentcolor` (lowercase rule); file contents are untouched.

## Left out of the repo, and why

| Item | Why |
|---|---|
| `endorsement/4thtech-logo-reference.png` (the 4thTech logo "as supplied, reference only") | It is 4thTech's own trademark artwork, supplied "reference only" by the drop. It is unclear whether it may be committed to this public MIT repo, so it stays out until the owner says. The endorsed lockups (`agentlink-lockup-endorsed-*`) are included because they are AgentLink brand files and carry "by 4thTech" as plain set text (checked: no 4thTech artwork in them). Never redraw the 4thTech hexagon; use the original file from 4thTech |
| Static font weights (`fonts/*.ttf`, `*-Regular/Medium/SemiBold.woff2`, about 1 MB) | Only the two variable WOFF2 files that `tokens.css` references are committed, with the licence: see `../d1/tokens/fonts/` |
| `.DS_Store` | OS junk |

### Re-export of 15 Oct 2026

The owner exported the same brand folder again. Byte for byte it equals the 14 Oct intake except `logo/jpg/` (now 15 files in `mark/`, `wordmark/` and `lockup/`) and the two `social/*.jpg`, which are now committed (about 1 MB together). Still left out: the static Geist weights (TTF and per-weight WOFF2, about 1.1 MB, OFL 1.1, redistributable; only the variable WOFF2 that `tokens.css` references is committed, in `../d1/tokens/fonts/`) and `endorsement/4thtech-logo-reference.png` (see above).

**Production domain and trademark check: still pending.** The name `AgentLink` and every mark here stay provisional until M1-24 closes and the production domain is chosen; nothing here is final or cleared for registration.

## Fonts and icon set

- **Geist** and **Geist Mono**, © 2023 Vercel in collaboration with basement.studio, SIL Open Font License 1.1. Source: npm package `geist` 1.3.1. Committed in `../d1/tokens/fonts/` together with `OFL.txt`. Self-hosted only; no CDN.
- **Custom UI icons:** 21 AgentLink icons (`icons/ui/`), authored for AgentLink; the same SVGs sit inside the reference component bundle.
- The drop's application MANIFEST also credits **Lucide** (ISC licence) for the general-purpose icons used by the components. See the open point in `../d1/MANIFEST.md`: the licence notice is not in the files.

## Checks done at intake

SVGs contain no scripts, external references or embedded raster images (scanned). No hidden files, no executables, no keys, tokens or addresses. Sizes are within the README limits (this folder is about 3.0 MB, 1.0 MB of it the JPG renderings added on 15 Oct 2026).

Nothing private is included: no real personal data, keys or addresses, nothing from docs 01 or 09, no unreleased security details.
