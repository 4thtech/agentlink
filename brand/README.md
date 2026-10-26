# AgentLink brand and press kit

Everything you need to show AgentLink in an article, a talk, a slide or a website. The files are small, so you can [download the whole `brand/` folder](https://download-directory.github.io/?url=https://github.com/4thtech/agentlink/tree/main/brand) or clone the repository. Single files work from their raw links on GitHub.

The name is **AgentLink**: one word, capital A and capital L.

## The logo

The logo is a **bracket seal**: two square brackets (the two parties) holding a diamond (the agreed record). The brackets are ink. The diamond is signal orange `#FF6A1A` in every colour version.

### Which shape to use

| Shape | Use it for |
|---|---|
| Mark (`agentlink-mark-…`) | App icons, favicons, avatars, small spaces |
| Wordmark (`agentlink-wordmark-…`) | Where the mark already appears nearby |
| Horizontal lockup | The default logo: headers, documents, websites |
| Stacked lockup | Square spaces: slides, splash screens, stickers |
| Endorsed lockup (with "by 4thTech") | Sign-in, onboarding, About pages, installers, marketing, page footers |

### Which colour version to use

| Version | Use it for |
|---|---|
| `color-ondark` / `ondark` | Dark backgrounds (light brackets) |
| `color-onlight` / `onlight` | Light backgrounds (dark brackets) |
| `mono-black` / `mono-white` | One-colour print, embossing, faxes, system templates |
| `orange-ondark` | Marketing accent only |
| `mark-small-…` | Pixel-snapped drawing for 16 to 24 px |

### Files

- `logo/svg/`: every logo as a vector SVG (outlined, no fonts needed). **Start here.**
- `logo/png/`: ready-made PNGs, transparent background. Lockups are 960 px wide (horizontal in four colour versions, stacked and endorsed in dark and light). The mark is 512 px in colour on dark, colour on light, mono black and mono white.
- `social/`: `agentlink-og-1200x630.png` (link previews, Open Graph) and `agentlink-github-social-1280x640.png` (GitHub social preview).
- `video/agentlink-intro.gif`: the 960x540 intro animation shown at the top of the project README (about 5.9 MB; it also mentions Touch ID and the desktop app as coming next).

## Colours

The full palette is in [`colors/colors.md`](colors/colors.md) (with RGB and approximate CMYK), [`colors/palette.json`](colors/palette.json) (all four themes) and the sheet [`colors/agentlink-palette.png`](colors/agentlink-palette.png). The core colours:

| Name | Hex | Use |
|---|---|---|
| Signal orange | `#FF6A1A` | Brand accent: the diamond, primary actions, focus |
| Graphite canvas | `#0B0C0E` | Dark background |
| Graphite surface | `#111316` | Panels |
| Graphite raised | `#171A1E` | Cards, menus |
| Ink light | `#E7E9EC` | Brackets and text on dark |
| Ink dark | `#0E1013` | Brackets and text on light |
| Paper | `#F5F6F7` | Light background |
| Proof violet | `#A495FF` | Proof seal on dark (`#5B4BD6` on light) |
| Success teal | `#4FD1A5` | Success on dark |
| Info blue | `#6CB6FF` | Info and verified domain on dark |
| Warning amber | `#F2C94C` | Warnings on dark |
| Danger red | `#FF6B6B` | Destructive actions and integrity failures only |

CMYK values are for reference only: proof print colour against a physical swatch. Signal orange is a screen colour; in one-colour print use the black or white logo.

## Rules

- **Clear space:** keep the width of the diamond free on every side.
- **Minimum size:** mark 16 px (use `mark-small` up to 24 px); horizontal lockup 96 px wide on screen, 24 mm in print.
- **Don't:** recolour the diamond, outline the brackets, rotate or stretch, add glow, gradient or shadow, put the mark inside a hexagon, or combine it with chains, coins, padlocks or blocks.
- **"by 4thTech"** goes on sign-in, onboarding, About, installer and update screens, the marketing site and page footers. Not in app chrome, approval cards, tray icons, app icons, favicons, proof stamps or printed records.
- **Never redraw the 4thTech hexagon.** Its green `#2CD8A7` is not an AgentLink colour.

## Fonts

AgentLink uses **Geist** and **Geist Mono** by Vercel, under the SIL Open Font License 1.1. They are not copied here: get them from [vercel.com/font](https://vercel.com/font) or the [Geist repository](https://github.com/vercel/geist-font), which carries the licence.

## Brand assets: usage (proposed, owner confirms at merge)

The code in this repository is MIT licensed. The AgentLink name, logo and brand marks are not covered by that licence. Proposed terms: you may use them freely to refer to or promote AgentLink (articles, talks, integrations that work with it). Please do not use them to suggest that 4thTech endorses you or your product, and do not use them for other products or services. The trademark check is still running, so keep the mark usable on its own.

## What is not here

The 4thTech logo (it comes from 4thTech, not from this kit), the app icons and menu-bar icons (they ship with the desktop app), the UI icon set, JPG copies, and the larger PNG sizes. The SVGs cover every size.
