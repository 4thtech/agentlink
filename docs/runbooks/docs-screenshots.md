# Docs screenshots

Every screenshot in the user guide and the README is drawn from the real build, so the pictures cannot drift from the app.

## Refresh them

```bash
pnpm docs:screenshots          # build the app, run the story, write docs-site/assets/screens/*.webp
pnpm docs:screenshots:check    # offline: pages and manifest agree (also part of tools `pnpm check`)
```

Needs Chromium once: `pnpm exec playwright install chromium`. The run takes about a minute.

## How it works

- `e2e/docs-screens/capture.screens.ts` runs the journey harness: two "computers" (temp home folders, never your real HOME, the keychain stand-in file, never the OS keychain), one in-memory relay, one fake encrypted drop, and a virtual passkey as Touch ID. Nothing is faked in the app; every owner check really runs.
- The story: Tali sets up and connects Claude Code, invites Natasa, Natasa accepts, they exchange messages, a file each way and an offer of terms; then the Settings pages, My IDs, Activity and Under the hood are shot.
- Light theme, 1280 x 800 CSS pixels at scale 2, WebP. The invite page is the built `apps/invite` site with a made-up invite.
- Fixed clock: the test process pins `Date` to 12 Nov 2026 10:00 UTC (host, agents, relay) and every page gets the same shifted clock, so dates and "just now" read the same each run.
- Fresh values are replaced before each shot (`maskFresh`): the master code, the 12-digit Contact check, the invite link and the temp-home folder name show made-up stand-ins. Names and messages are fixed. Two runs draw the same pixels.

## The manifest

`tools/docs-screenshots/manifest.json` lists every image the pipeline writes: name, path under `docs-site/`, page, state, viewport, theme. `tools/docs-screenshots/check.mjs` fails when:

- a Markdown page in `docs-site/` (or the README) shows an image the manifest does not list;
- the manifest lists an image no page shows, or one missing on disk.

The capture run itself fails if a manifest shot was not written.

## Add or change a screenshot

1. Add a `shot(page, '<name>')` at the right moment in `capture.screens.ts` (step names fail with the step that broke).
2. Add the entry to `manifest.json`.
3. Reference `../../assets/screens/<name>.webp` (relative to the page) in the guide, with alt text that says what the reader should notice.
4. Run `pnpm docs:screenshots`, look at the result, run the check, commit the images.

A phone-width shot: pass a 360 x 800 viewport to `screenPage` and list `"viewport": "360x800"` in the manifest. The guide does not use one today.

## Not producible by the real app

The "second connection with the same person" notice on People needs two pairings with one person; the scripted story does not make it, so the guide has no picture of it.

## Hand-made shots

Entries with `"source": "manual"` in the manifest were captured by hand on the owner-preview harness (restore steps, My IDs, Rules, Settings, Touch ID and master code, People across IDs). The check still requires them on disk and on a page, but the run does not write them. Moving them into the pipeline is open work.
