# AgentLink · brand resources

Everything needed to use the AgentLink brand: logo in every shape, colour and format, app icons for macOS, Windows, Linux and the web, tray icons, UI icons, social images, colours and fonts.

## The logo

The **bracket seal**: two square brackets (the two parties) holding a diamond (the agreed record). Brackets are ink; the diamond is signal orange `#FF6A1A` in every colour version.

| Shape | Use |
|---|---|
| `mark` | App icons, favicons, avatars of AgentLink itself, small spaces |
| `wordmark` | Where the mark already appears nearby |
| `lockup-horizontal` | Default logo: headers, documents, websites |
| `lockup-stacked` | Square spaces: splash screens, slides, stickers |
| `lockup-endorsed` | With "by 4thTech": sign-in, onboarding, About, installers, marketing, page footers |

| Version | Use |
|---|---|
| `ondark` / `color-ondark` | On dark backgrounds (light brackets) |
| `onlight` / `color-onlight` | On light backgrounds (dark brackets) |
| `mono-black` / `mono-white` | One-colour print, embossing, faxes, OS templates |
| `orange-ondark` | Marketing accent only |
| `mark-small-*` | Pixel-snapped drawing for 16–24 px |

## Folders

```
logo/svg/                 every logo as vector SVG (outlined, no fonts needed)
logo/png/mark/<version>/  mark at 16–1024 px, transparent
logo/png/lockup/…         lockups at 240, 480, 960, 1920 px wide, transparent
logo/png/wordmark/…       wordmark at 240–1920 px wide, transparent
logo/jpg/                 every logo on its background (dark #0B0C0E or white), 1920 px / 1024 px
app-icons/source/         SVG masters with separate background and mark layers
app-icons/macos/          PNG 16–1024 and agentlink-app.icns
app-icons/windows/        agentlink-app-windows.ico (16–256) and PNGs
app-icons/linux/          agentlink.svg and PNG 16–512
app-icons/web/            favicon.svg, favicon.ico, PWA 192/512, maskable 512, monochrome 512,
                          apple-touch-icon 180, push icon 192, push badge 96
app-icons/ai-apps/        Claude Desktop extension / MCP server icon, 512 and 256
tray/macos/               menu-bar template images (…Template.png, @2x) for 5 states
tray/windows/             notification-area icons for light and dark taskbars, 16–32
tray/linux/               symbolic SVGs and PNG 22/24
icons/                    21 custom AgentLink UI icons (24 px grid): SVG grey, SVG currentColor, PNG
social/                   Open Graph 1200×630 and GitHub social preview 1280×640
colors/                   palette.json, colors.md, palette sheet
fonts/                    Geist and Geist Mono (variable WOFF2 + static TTF/WOFF2), SIL OFL
endorsement/              the 4thTech logo as supplied (reference only)
```

## Tray status variants

`connected` (solid) · `approvals` (badge dot) · `paused` (hollow seal) · `offline` (slash) · `update` (arrow). They differ by shape, never colour, because the OS tints tray icons.

## Rules

- **Clear space:** the width of the diamond on every side.
- **Minimum size:** mark 16 px (use `mark-small` up to 24 px); horizontal lockup 96 px wide on screen, 24 mm in print.
- **"by 4thTech"** appears on sign-in, onboarding, About, desktop first run, installer and update screens, the marketing site, and page footers. Never in app chrome, approval cards, tray icons, app icons, favicons, proof stamps or printed records.
- **Never redraw the 4thTech hexagon.** Use the original file from 4thTech. Its green `#2CD8A7` is not an AgentLink colour.
- **Don't:** recolour the diamond, outline the brackets, rotate or stretch, add glow, gradient or shadow, put the mark inside a hexagon, or combine it with chains, coins, padlocks or blocks.
- **Exception: the waiting mark** (owner decision, 2026-10-28). In the AgentLink app's "Waiting for your funds" step, and nowhere else, the diamond may turn about its own centre: a quarter turn every 2 seconds, resting in its normal pose between turns. The brackets never move. Nothing else changes: no recolour, glow, scaling or outline. It is not a loading indicator and is not used for any other waiting or loading state, in tray or app icons, favicons, marketing, video or print, or at 20 px and below. With reduced motion the mark is still.
- The name is **AgentLink**: one word, capital A and L. The trademark check is still running; keep the mark usable on its own.

## Fonts

Geist and Geist Mono © Vercel, SIL Open Font License 1.1 (`fonts/OFL.txt`). Install the TTF files to use them in documents and slides.
