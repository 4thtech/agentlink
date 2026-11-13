# Release notes template (early-adopter preview)

> Early-adopter preview. Not signed. Desktop apps are coming soon; fill this in for each preview build and delete this line only when a signed build ships.

## AgentLink desktop preview <version>

**Who this is for:** early adopters on a Mac who accept an unsigned build. The Windows desktop app is coming later; on Windows, use the browser app (one command).

### What is new

- <one sentence per user-visible change, in the words of 11 §5>

### Install

The one canonical page is [Desktop app](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/apps/desktop-app.md). Short version:

- **Mac:** open the `.dmg`, drag AgentLink to Applications and open it. macOS says it cannot check the app: click **Done**, then **System Settings**, **Privacy & Security**, **Open Anyway** (on macOS 13 or 14 you can also Control-click the app and choose **Open**). If macOS says the app is "damaged", run `xattr -dr com.apple.quarantine /Applications/AgentLink.app` in Terminal and open it again. The preview is not signed by Apple yet; the `.dmg` has a short "Read me first" file with these steps.
- **Windows:** the desktop app is coming later. Use the browser app (one command; see the Windows guide).

### Known limits

- <for example: Touch ID in the app window not available on Mac yet>

### Checksums

| File | SHA-256 |
|---|---|
| `<file>` | `<hash>` |

Only download from `https://github.com/4thtech/agentlink/releases`.
