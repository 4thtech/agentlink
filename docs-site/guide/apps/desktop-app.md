# Desktop app

> **Status: Planned.** An early-adopter preview of the desktop app for Mac and Windows is coming soon. It is not released yet; this page says what to expect so you are ready. Until it is out, use the [one-line install](../get-started/start-fast.md) or the browser version.

*Applies to the desktop app preview, not yet released. A Linux app is not planned for now.*

The desktop app is AgentLink in its own window, with the same Home, IDs, contacts, messages and approvals as the [local app](../local-app/README.md) that opens in your browser. It is the same AgentLink and the same data.

## Why the first builds show a warning

The early-adopter builds are **not signed** with a publisher certificate yet. Your computer cannot tell who made the file, so it shows a warning the first time you open it (on a Mac, that it cannot check the app). That does not mean something is wrong with the file; it means the app has not been checked by Apple or Microsoft. Download it only from the AgentLink releases page, `https://github.com/4thtech/agentlink/releases`, never from a link someone sent you.

A signed build comes later. Then these steps go away.

## Mac

You need a Mac with macOS 13 or newer (to be confirmed).

**Recommended once available:** the one-command installer (a separate package) does the steps below for you.

Manual steps:

1. Download the `.dmg` file for your Mac and open it. Its window also has a short **Read me first** file with these steps.
2. Drag AgentLink to the **Applications** folder. Run it from there, not from inside the `.dmg` window or from Downloads.
3. Open AgentLink from Applications. The first time, macOS stops it and says it cannot check the app. Click **Done** (not **Move to Bin**).
4. Allow it once, in one of these two ways:
   - **macOS 15 (Sequoia) or newer:** open **System Settings**, then **Privacy & Security**. Scroll down to the message about AgentLink and click **Open Anyway**. Confirm when your Mac asks (for example with Touch ID), then click **Open Anyway** again.
   - **macOS 13 or 14:** in Applications, hold **Control** and click AgentLink (or right-click it), choose **Open**, then click **Open** in the message. If there is no **Open** button, use the System Settings way above.

### If macOS says the app is damaged

On some Macs the message says "AgentLink.app is damaged and can't be opened" and offers only to move it to the Bin. The app is not damaged; macOS says this about some apps that are not signed by Apple. Click **Cancel**, open **Terminal** and run this one line, then open AgentLink again:

```
xattr -dr com.apple.quarantine /Applications/AgentLink.app
```

That command only removes the "downloaded from the internet" mark from this one app.

Do not turn off Gatekeeper or other Mac security settings; you do not need to.

You do this once. Later you open AgentLink like any other app.

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

- Touch ID in the app window is not available in the first builds on Mac. Approvals use your browser or your master code (to be confirmed).
- Windows Hello approvals in the app window are to be confirmed.
- Nothing about your IDs, contacts or messages changes. Your data stays in your AgentLink folder on your computer.

## Where your data lives

Your IDs, contacts and messages stay on your computer, exactly as with the browser version. The preview does not send your master code or your messages to 4thtech. See [What leaves your computer](../privacy-and-security.md).

## Removing it

Mac: drag AgentLink from Applications to the Bin. Windows: Settings, then Apps, then AgentLink, then Uninstall. Your IDs and messages stay in your AgentLink folder until you delete that folder.

## Report a problem

The preview is early. If a step here does not match what you see, tell the person who invited you, or open an issue at `https://github.com/4thtech/agentlink/issues`. Do not include your master code or any invite link.
