# Mac desktop app

*Applies to AgentLink 0.5.1. This is an early, unsigned build, meant for people who are happy to try it first. The Windows desktop app is coming later; on Windows, use the browser app (one command). Linux is not available yet.*

## Which file do I download?

| Your computer | Download this |
|---|---|
| Mac with Apple chip (M1, M2, M3, M4) | **[AgentLink-0.5.1-mac-arm64.dmg](https://github.com/4thtech/agentlink/releases/download/v0.5.1/AgentLink-0.5.1-mac-arm64.dmg)** |
| Mac with Intel chip | **[AgentLink-0.5.1-mac-x64.dmg](https://github.com/4thtech/agentlink/releases/download/v0.5.1/AgentLink-0.5.1-mac-x64.dmg)** |
| Windows or Linux | No app to download: use the [one command](../get-started/start-fast.md) |

Not sure which Mac? Click the Apple menu (top left of your screen), then **About This Mac**. "Chip: Apple M…" means Apple chip; "Processor: Intel" means Intel. In the file names, **arm64 = Apple chip** and **x64 = Intel**.

The release page also lists other files (`.mcpb`, `SHA256SUMS`). They are for AI-app extensions and checks; you don't need them.

The AgentLink desktop app is the local app in its own window, with its own icon. It does everything [the local app](../local-app/README.md) does in your browser, with the same IDs, contacts, messages and approvals, and the Touch ID sheet shows the AgentLink name and icon.

{% hint style="warning" %}
**Early build.** The app is not signed by Apple yet, so your Mac warns you the first time you open it. That does not mean something is wrong with the file; it means Apple has not checked the app. The steps below get past that warning for this one app. Never turn off your Mac's security settings to do it. Download it only from the AgentLink Releases page, never from a link someone sent you.
{% endhint %}

## Get it

1. Download the file for your Mac from the table above. Newer versions are always on the [latest release](https://github.com/4thtech/agentlink/releases/latest) page, under **Assets**.
2. Check the file if you like: the release has a `SHA256SUMS-desktop-app.txt` with the fingerprint of each download.

## Open it the first time

The app is not signed by Apple yet, so macOS blocks it the first time. These four steps get past that, once:

1. **Open the `.dmg`** and drag **AgentLink** to **Applications**. Run it from there, not from inside the `.dmg` window or from Downloads. The `.dmg` also holds a short **Read me first** with these steps.
2. **Open AgentLink from Applications.** macOS blocks it: it says AgentLink "cannot be opened" or that it "could not verify" it. Press **Done** (or **OK**), not **Move to Trash**.
3. **Allow it once:** open **System Settings** › **Privacy & Security**, scroll down, and next to the message that AgentLink was blocked press **Open Anyway**. Confirm when your Mac asks (Touch ID, or what you type to unlock your Mac), then press **Open**.
   - **macOS 13 or 14:** you can instead hold **Control** and click AgentLink in Applications (or right-click it), choose **Open**, then press **Open** in the message. If there is no **Open** button, use the System Settings way above.
4. **You only do this once.** From then on it opens like any other app, on **Get started** the first time.

**Why step 3?** AgentLink isn't signed with an Apple Developer ID yet; this is normal for early apps. It does not mean something is wrong with the file. Never turn off your Mac's security settings for it.

### If macOS says the app is damaged

On some Macs the message says "AgentLink.app is damaged and can't be opened" and offers only to move it to the Trash. The app is not damaged; macOS says this about some apps that are not signed by Apple. Press **Cancel**, open **Terminal** and run this one line, then open AgentLink again:

```
xattr -dr com.apple.quarantine /Applications/AgentLink.app
```

That command only removes the "downloaded from the internet" mark from this one app. Use it only for the "damaged" message; for the usual warning, the steps above are enough.

## Windows

The Windows desktop app is coming later. On Windows, use the browser app: one command installs AgentLink and opens it in your browser. See [Windows](../get-started/windows.md).

## Updating

Open **Settings**, then **Updates** (the same page as in the browser app, see [Updates](../local-app/updates.md)). It shows the version you have and a **Check for updates** button. The app checks once a day by itself, and when you press the button (at most once a minute), and only says something on this page.

When a newer version is out, the page says so, for example **AgentLink 0.5.2 is ready**. Then:

1. Press **Download update**. Your browser downloads the `.dmg` for your Mac (Apple chip or Intel) from the AgentLink Releases page.
2. Open the file you downloaded.
3. Quit AgentLink: click its icon in the menu bar and choose **Quit AgentLink**.
4. Drag **AgentLink** to **Applications** and choose **Replace**.
5. Open AgentLink again. The first time, macOS may ask you to allow it again, as in [Open it the first time](#open-it-the-first-time).

If you open the new version while the old one is still running, AgentLink says an older AgentLink is still open and offers to quit it for you.

Your IDs, people and messages stay as they are: they live in your AgentLink folder, not in the app.

**What the check sends.** The app asks GitHub which AgentLink release is the newest, and nothing else. GitHub sees your IP, as any website you visit does, and the name "AgentLink-Desktop"; no ID, contact, message or version number is sent. The app downloads and installs nothing by itself, and offline it doesn't check.

**Turning it off.** Start the app with the setting `AGENTLINK_UPDATE_CHECK=off` (for example, an administrator can set it for a computer with `launchctl setenv AGENTLINK_UPDATE_CHECK off`, then reopen AgentLink). Settings › Updates then says checking is turned off, and the app never asks GitHub.

You can always get a newer version by hand too: download the new `.dmg` from the [Releases page](https://github.com/4thtech/agentlink/releases) and drag it over the old one in Applications.

## Touch ID

Turning on Touch ID in the desktop app is guided: open **Settings**, then **Touch ID & master code**, and press **Use Touch ID for approvals**. Type your master code once, then touch the sensor. **Test Touch ID** on the same page checks that it works. If you cancel or the touch fails, it goes back to off with a plain message, and your master code keeps working.

## Removing it

Drag AgentLink from Applications to the Trash. Your IDs and messages stay in your AgentLink folder until you delete that folder.

## Good to know

- Your master code and recovery kit work the same as in the browser. See [Your master code and recovery kit](../local-app/first-run.md).
- Your data stays on your computer, exactly as with the browser version. See [What leaves your computer](../privacy-and-security.md).
- Not using the desktop app is fine: `npx -y @4thtech-io/agentlink@latest` still opens the app in your browser.
- The always-on cloud agent is a different thing and is [not available yet](cloud-agent.md).
- If a step here does not match what you see, open an issue at `https://github.com/4thtech/agentlink/issues`. Do not include your master code or any invite link.
