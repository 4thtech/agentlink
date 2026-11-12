# Release notes template (early-adopter preview)

> Early-adopter preview. Not signed. Desktop apps are coming soon; fill this in for each preview build and delete this line only when a signed build ships.

## AgentLink desktop preview <version>

**Who this is for:** early adopters on Mac or Windows who accept an unsigned build.

### What is new

- <one sentence per user-visible change, in the words of 11 §5>

### Install

The one canonical page is [Desktop app](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/apps/desktop-app.md). Short version:

- **Mac:** recommended once available: the one-command installer. Manual: open the `.dmg`, drag AgentLink to Applications, run `xattr -dr com.apple.quarantine /Applications/AgentLink.app` in Terminal, then open it. (The preview is not signed by Apple yet, so macOS says it is "damaged"; the command only removes the download mark for this one app.)
- **Windows:** run the installer, **More info**, **Run anyway**.
- **Windows with Smart App Control on:** the preview cannot run yet. Use the browser version until the signed build. Do not turn Smart App Control off.

### Known limits

- <for example: Touch ID in the app window not available on Mac yet>

### Checksums

| File | SHA-256 |
|---|---|
| `<file>` | `<hash>` |

Only download from `https://github.com/4thtech/agentlink/releases`.
