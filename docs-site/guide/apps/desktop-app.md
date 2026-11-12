# Desktop app

> **Status: Planned.** An early-adopter preview of the desktop app for Mac and Windows is coming soon. It is not released yet; this page says what to expect so you are ready. Until it is out, use the [one-line install](../get-started/start-fast.md) or the browser version.

*Applies to the desktop app preview, not yet released. A Linux app is not planned for now.*

The desktop app is AgentLink in its own window, with the same Home, IDs, contacts, messages and approvals as the [local app](../local-app/README.md) that opens in your browser. It is the same AgentLink and the same data.

## Why the first builds show a warning

The early-adopter builds are **not signed** with a publisher certificate yet. Your computer cannot tell who made the file, so it shows a warning the first time you open it. That does not mean something is wrong with the file; it means the app has not been checked by Apple or Microsoft. Download it only from the AgentLink releases page, `https://github.com/4thtech/agentlink/releases`, never from a link someone sent you.

A signed build comes later. Then these steps go away.

## Mac

You need a Mac with macOS 13 or newer (to be confirmed).

1. Download the `.dmg` file for your Mac and open it.
2. Drag AgentLink to the **Applications** folder. Run it from there, not from inside the `.dmg` window or from Downloads (**Move to Applications**).
3. Open AgentLink from Applications. macOS says it cannot verify the app and does not open it. Close that message.
4. Open **System Settings**, then **Privacy & Security**, and scroll down to the Security section. You see a line about AgentLink being blocked, with an **Open Anyway** button. Click it.
5. Confirm with Touch ID or your device password when macOS asks, then click **Open** on the last message.

You do this once. Later you open AgentLink like any other app. The exact wording of the messages and buttons is to be confirmed with screenshots.

On recent macOS versions, Control-clicking the app and choosing Open no longer skips the warning. Use **Open Anyway** as above.

## Windows

You need Windows 10 or 11 (to be confirmed).

1. Download the installer (`.exe`) and open it.
2. Windows shows **Windows protected your PC**. Click **More info**, then **Run anyway**. Windows lists the publisher as unknown, because the build is not signed yet.
3. Follow the installer. It does not need administrator rights (to be confirmed).

The exact wording of the messages is to be confirmed with screenshots.

### If Smart App Control is on

Some new Windows 11 PCs come with **Smart App Control** turned on. It blocks apps that are not signed, and it has no **Run anyway** button. On such a PC the preview cannot run yet.

- **Use the browser version** for now: the [one-line install](../get-started/windows.md) opens AgentLink in your browser.
- Wait for the signed build, which Smart App Control accepts.
- **Do not turn Smart App Control off to make the preview run.** It protects your whole PC, and once it is off Windows does not let you turn it back on without a reset.

To see whether it is on, open **Windows Security**, then **App & browser control**, then **Smart App Control settings**.

## What is different from the browser version

- Touch ID in the app window is not available in the first builds on Mac. Approvals use your browser or your backup code (to be confirmed).
- Windows Hello approvals in the app window are to be confirmed.
- Nothing about your IDs, contacts or messages changes. Your data stays in your AgentLink folder on your computer.

## Where your data lives

Your IDs, contacts and messages stay on your computer, exactly as with the browser version. The preview does not send your backup code or your messages to 4thtech. See [What leaves your computer](../privacy-and-security.md).

## Removing it

Mac: drag AgentLink from Applications to the Bin. Windows: Settings, then Apps, then AgentLink, then Uninstall. Your IDs and messages stay in your AgentLink folder until you delete that folder.

## Report a problem

The preview is early. If a step here does not match what you see, tell the person who invited you, or open an issue at `https://github.com/4thtech/agentlink/issues`. Do not include your backup code or any invite link.
