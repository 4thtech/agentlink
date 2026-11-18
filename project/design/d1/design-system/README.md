AgentLink lets AI agents from different people exchange end-to-end encrypted messages and files for free, and buy a $0.10 public proof when it matters. The owner supervises; the AI proposes. This system is **"Signal, run in a terminal"**: precise instruments, graphite neutrals, one signal orange, and the working habits of an IDE (mono labels, status bars, keyboard first, dense but calm). It must feel native on macOS, Windows and Linux, and readable to a lawyer who has never opened a terminal.

## Principles

1. **UX first.** The chat is the main interface. Our UI exists for setup, supervision, approvals and proof. "Paste this to your agent" (`CopyPrompt`, `size="hero"`) is the largest onboarding element.
2. **Owner in control.** Agents propose, owners decide. Every owner action needs a passkey, Touch ID, Windows Hello or the owner passphrase, requested only after the owner clicks Approve. Every approval surface ends with "Your AI can't approve this for you."
3. **Their words are never our UI.** Anything another party wrote (messages, names, file names, terms subjects) renders inside `UntrustedContent`, or, outside it, through `ContactName`. Never as a heading, button, link, notification or OS prompt text.
4. **Money first, plain language.** "Add proof · $0.10 from credits". Exact dollars, never "≈".
5. **Technical detail lives under Advanced.** IDs, networks, fingerprints of terms, record IDs: mono, collapsed, labelled Advanced.
6. **Calm, exact, async.** No typing indicators, no "online now" pulses, no live-chat styling. Nothing loops except progress.

## Content fundamentals

- Outcome first, then the next step, in one or two sentences: "Sent to Marko's agent. End-to-end encrypted: only you, Marko and your agents can read it."
- Sentence case everywhere. Verb-first buttons ("Approve with Touch ID", "Add credits", "Request fresh link").
- Names, not roles: "Marko", "Ana's agent". Exact times in proof contexts ("Recorded 12 Oct 2026, 14:02"), relative times elsewhere.
- Errors say what happened, whether anything was sent or charged, and what to do: "I couldn't reach the message network. Nothing was sent."
- No emoji. Exclamation marks only for success, and rarely.
- Privacy lines are literally true: "4thTech can't read this." Never "100% secure".
- Follow the vocabulary in **Voice and vocabulary** exactly: no wallet, gas, chain, token, hash, seed phrase, smart contract or MCP outside developer contexts.

## Visual foundations

**Character.** IDE-grade precision. Hairline borders do the structural work; shadows only lift floating layers. Small radii (`al-radius-md` 4px for controls, `al-radius-lg` 6px for cards). Uppercase mono labels (`al-text-label`) act as eyebrows and table headers, the way an editor labels panes. A status bar (`AppShell`) carries connection, credits and version. Terminal references are structural, never costume: no green-on-black, no scanlines, no fake cursors blinking.

**Colour.** Dark is the primary theme; Light, Dark · increased contrast and Light · increased contrast are complete and checked (see **Contrast**).
- Surfaces step from `al-color-bg-canvas` (window) to `al-color-bg-surface` (panels, sidebar) to `al-color-bg-raised` (cards, menus, dialogs). `al-color-bg-sunken` is for wells: inputs, code, the copy-prompt block, safety codes.
- Text: `al-color-fg-default`, `al-color-fg-muted`, `al-color-fg-subtle`; all three pass 4.5:1 on every surface.
- **Signal orange** `al-color-accent-default` is the only accent: the primary action (once per view), the selected nav marker, focus (`al-color-focus-ring`), the approval-count badge and the seal in the mark. Text on orange is `al-color-fg-on-accent` (dark ink), never white, except in Light · increased contrast where the fill deepens to burnt orange.
- **Proof** has its own seal colour (`al-color-proof-*`, a cool violet) and is never the success colour.
- **Status**: success is teal (off the red–green axis), warning amber-yellow, info blue, neutral grey. **Red (`al-color-status-danger-*`) only for destructive, irreversible or integrity failures.** Every status carries an icon and a word.
- **Untrusted content** is khaki: dashed `al-color-untrusted-border`, inset `al-color-untrusted-bg`, label strip `al-color-untrusted-label-*`.
- **Commitment** (accepting terms) is a burnt-orange frame (`al-color-commitment-*`) so it never looks like a routine approval.
- **Identity labels** strengthen visually with trust: Self-declared is a dashed grey outline, Safety code checked teal, Registered the proof violet, Verified domain blue, Domain no longer verified amber.
- **Diff**: added teal +, removed red − struck through, changed amber ~.
- **Code and terminal text** on `al-color-bg-sunken` uses `al-color-syntax-*`.

**Type.** Geist for the interface, Geist Mono for everything a machine produced or a person must compare: codes, IDs, fingerprints, amounts in tables, commands, labels, the wordmark. Both are SIL OFL, self-hosted from `fonts/`, cover Latin Extended (č, š, ž) and set tabular figures by default.
- Desktop body is `al-text-body` (14/20), the IDE density; mobile body and every mobile input is `al-text-body-lg` (16/24).
- Headlines: `al-text-title-2` for approval and dialog headlines, `al-text-title-1` for page titles, `al-text-display` at most once per screen.
- `al-text-code-lg` for safety, pairing and recovery codes, always in groups of four.
- Leave room for 40% longer translations and a 14-character product name; the name is live text `{productName}` in every source.

**Spacing and layout.** A 4px base: `al-space-1` 2px through `al-space-12` 80px. Cards pad with `al-space-5`, rows with `al-space-3`, sections gap `al-space-6`. Breakpoints `al-breakpoint-sm` 600, `al-breakpoint-md` 1024, `al-breakpoint-lg` 1440: phone with bottom tabs, tablet, then sidebar + list + detail. Desktop dashboard window at least 960 × 640; the native approval window about 440 × 600 (`al-layout-max-content` caps cards at reading width).

**Borders, radii, elevation.** `al-border-width-thin` everywhere; `al-border-width-thick` for selection, the untrusted container's dashed edge and increased-contrast outlines. Shadows (`al-shadow-1`…`al-shadow-4`) only on menus, dialogs, toasts and the approval window; the increased-contrast themes drop them for borders.

**Focus.** A solid 2px `al-color-focus-ring` outline at 2px offset (`al-focus-ring-width`, `al-focus-ring-offset`), at least 3:1 on every surface in every theme. Never hidden by sticky bars, bottom tabs or toasts.

**Motion.** Calm and exact: `al-duration-fast` 120ms for hover and press, `al-duration-base` 200ms for menus and toasts, `al-duration-slow` 320ms for the three signature moments (proof recorded: the seal settles; approval confirmed; pairing matched), easing `al-easing-standard`. Only progress loops. Under reduced motion use fades or nothing.

**Imagery.** Optional, minimal, geometric SVG built from the bracket and diamond, about 10 KB, both themes, never the only carrier of meaning. No stock photos, robots, brains, sparkles, magic wands, coins, chains, blocks, padlocks with circuits, shields with checks, neon gradients, glowing networks or decorative hexagons.

## Logo

The **bracket seal**: two square brackets, the two parties, holding a diamond, the agreed record. Brackets in `al-color-brand-mark`, the diamond in `al-color-brand-seal` (signal orange #FF6A1A in every theme). It reads at 16px, works in one colour, and stays clearly apart from the 4thTech hexagon.
- Assets (Logos): `agentlink-mark-color-ondark.svg` / `-onlight.svg`, `agentlink-mark-mono-black.svg` / `-white.svg`, `agentlink-mark-small-*.svg` (pixel-snapped 16px drawing), `agentlink-wordmark-*.svg`, `agentlink-lockup-horizontal-*.svg` (incl. mono black and white), `agentlink-lockup-stacked-*.svg`, `agentlink-lockup-endorsed-*.svg` ("by 4thTech").
- In React use `Mark`, `Wordmark` and `Lockup`, which follow the theme.
- **Clear space**: the diamond's width on every side. **Minimum size**: mark 16px (use the small drawing up to 20px), horizontal lockup 96px wide on screen, 24mm in print.
- **Endorsement**: "by 4thTech" appears on console sign-in, onboarding, About, desktop first run, installer and update screens, the marketing site, and the footers of console, verify, invite and pay. Never in app chrome, approval cards, tray or app icons, favicons, chat text, proof stamps or printed records. The 4thTech mark itself is never redrawn: use the supplied file (Endorsement group) or a labelled placeholder.
- **Don't**: recolour the diamond, outline the brackets, rotate or stretch, add glow or gradient, place it in a hexagon, pair it with a chain, coin or padlock, or set our mark near content from an unknown sender.

## Platform

- **App icon** (Platform): `agentlink-app-icon.svg` is the 1024 master on the Apple grid with separable `background` and `mark` layers; `agentlink-app-icon-fullbleed.svg` for Windows tiles, Linux and maskable PWA icons (mark inside the central 80% circle); `favicon.svg` adapts to light and dark tabs; `agentlink-mcp-icon-512.png` for the Claude Desktop extension and MCP server listing.
- **Tray and menu bar** (Tray): monochrome template images, black on transparent, 16px grid. Status variants differ by **shape**: connected (solid), approvals waiting (badge dot), paused (hollow diamond), offline (slash), update ready (arrow). The OS tints them; never rely on colour.
- macOS: ⌘, opens Settings, ⌘W closes the window while the app keeps running, standard menu bar. Windows: Ctrl+, , close hides to the notification area with a one-time note. Linux: everything works without a tray. Every OS: system light/dark and high-contrast settings select the matching theme.
- Never draw an OS or browser passkey prompt. The real one names `localhost`, `{consoleHost}` or the signed app.

## Iconography

Lucide (ISC licence) on a 24px grid, 2px stroke, round caps and joins, rendered through `Icon` with `currentColor`. AgentLink's own icons sit on the same grid (Icons group, exported in neutral grey #8B949E for documents): `proof-seal`, `receipt-recorded`, `receipt-delivered`, `receipt-opened`, `receipt-accepted`, `receipt-rejected`, `untrusted`, `safety-code`, `identity-selfdeclared`, `identity-checked`, `identity-registered`, `identity-verified`, `domain-warning`, `commitment`, `approval`, `encrypted-drop`, `own-storage`, `agent`, `ai-app`, `cloud-agent`, `browser-agent`. The diamond recurs as the proof motif. AI apps are named in text only; no third-party logos. No emoji anywhere.

## Accessibility

WCAG 2.2 AA in Dark and Light; the increased-contrast themes reach 7:1 for text. No colour-only status. Reflow at 320px. Full keyboard: Escape closes dialogs, focus starts on an approval's headline, Enter does nothing until focus is on Approve or Deny. Targets 44px by default (`al-size-touch-min`, `al-size-control-lg`), 24px minimum. Live regions for "Checking…", "Recording…" and toasts. Codes are read in groups. Forced colours (Windows High Contrast) map every control to system colours with a border.

## Tokens for engineering

Every CSS variable is `--al-<category>-<role>[-<variant>][-<state>]`, matching the handoff (`--al-color-bg-canvas`, `--al-space-4`, `--al-radius-md`). Font stacks are `--font-sans` and `--font-mono`; type styles are classes (`.al-text-body`). Themes switch with `data-theme="dark" | "light" | "dark-contrast" | "light-contrast"` on the root. Components only use semantic tokens.
