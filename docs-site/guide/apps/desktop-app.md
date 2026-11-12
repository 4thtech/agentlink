# Mac desktop app

*Applies to AgentLink 0.5.1. This is an early, unsigned build, meant for people who are happy to try it first. Windows has an early installer too; Linux is not available yet.*

The AgentLink desktop app is the local app in its own window, with its own icon. It does everything [the local app](../local-app/README.md) does in your browser, with the same IDs, contacts, messages and approvals, and the Touch ID sheet shows the AgentLink name and icon.

{% hint style="warning" %}
**Early build.** The app is not signed by Apple yet, so your Mac warns you the first time you open it. That does not mean something is wrong with the file; it means Apple has not checked the app. The steps below get past that warning for this one app. Never turn off your Mac's security settings to do it. Download it only from the AgentLink Releases page, never from a link someone sent you.
{% endhint %}

## Get it

1. Open the [Releases page](https://github.com/4thtech/agentlink/releases) and pick the newest release.
2. Download the `.dmg` for your Mac:
   - **Apple chip** (M1, M2, M3, M4 and later): `AgentLink-<version>-mac-arm64.dmg`.
   - **Intel**: `AgentLink-<version>-mac-x64.dmg`.
   - Not sure? Open the Apple menu, then **About This Mac**. **Chip** says Apple M-something, or **Processor** says Intel.
3. Check the file if you like: the release has a `SHA256SUMS-desktop-app.txt` with the fingerprint of each download.

## Open it the first time

1. Open the `.dmg` and drag **AgentLink** to **Applications**. Run it from there, not from inside the `.dmg` window or from Downloads. The `.dmg` also holds a short **Read me first** with these steps.
2. Open **AgentLink** from Applications. macOS says it can't check the app. Press **Done**, not **Move to Trash**.
3. Allow it once, in one of these two ways:
   - **macOS 15 (Sequoia) or newer:** open **System Settings**, then **Privacy & Security**. Scroll down to the message about AgentLink and press **Open Anyway**. Confirm with Touch ID or your Mac password, then press **Open Anyway** again.
   - **macOS 13 or 14:** in Applications, hold **Control** and click AgentLink (or right-click it), choose **Open**, then press **Open** in the message. If there is no **Open** button, use the System Settings way above.

From then on it opens like any other app.

### If macOS says the app is damaged

On some Macs the message says "AgentLink.app is damaged and can't be opened" and offers only to move it to the Trash. The app is not damaged; macOS says this about some apps that are not signed by Apple. Press **Cancel**, open **Terminal** and run this one line, then open AgentLink again:

```
xattr -dr com.apple.quarantine /Applications/AgentLink.app
```

That command only removes the "downloaded from the internet" mark from this one app. Use it only for the "damaged" message; for the usual warning, the steps above are enough.

## Windows

Run `AgentLink-<version>-win-x64-setup.exe` from the same Releases page. If Windows says **Windows protected your PC**, press **More info**, then **Run anyway**. Windows lists the publisher as unknown, because the build is not signed yet.

Some new Windows 11 PCs have **Smart App Control** turned on. It blocks apps that are not signed and has no **Run anyway** button, so the early build cannot run there yet. Use the [one-line install](../get-started/windows.md), which opens AgentLink in your browser. Do not turn Smart App Control off: once it is off, Windows does not let you turn it back on without a reset.

## Updates

This build does not look for updates by itself. To get a newer version, download the new `.dmg` from the Releases page and drag it over the old one in Applications (reinstall). Your IDs, people and messages stay: they live in your AgentLink folder, not in the app.

## Touch ID

Turning on Touch ID in the desktop app is guided: open **Settings**, then **Touch ID & master code**, and press **Use Touch ID for approvals**. Type your master code once, then touch the sensor. **Test Touch ID** on the same page checks that it works. If you cancel or the touch fails, it goes back to off with a plain message, and your master code keeps working.

## Removing it

Mac: drag AgentLink from Applications to the Trash. Windows: Settings, then Apps, then AgentLink, then Uninstall. Your IDs and messages stay in your AgentLink folder until you delete that folder.

## Good to know

- Your master code and recovery kit work the same as in the browser. See [Your master code and recovery kit](../local-app/first-run.md).
- Your data stays on your computer, exactly as with the browser version. See [What leaves your computer](../privacy-and-security.md).
- Not using the desktop app is fine: `npx -y @4thtech-io/agentlink@latest` still opens the app in your browser.
- The always-on cloud agent is a different thing and is [not available yet](cloud-agent.md).
- If a step here does not match what you see, open an issue at `https://github.com/4thtech/agentlink/issues`. Do not include your master code or any invite link.
