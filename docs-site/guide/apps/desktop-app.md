# Mac desktop app

*Applies to AgentLink 0.5.1. This is an early, unsigned build, meant for people who are happy to try it first. Windows has an early installer too; Linux is not available yet.*

The AgentLink desktop app is the local app in its own window, with its own icon. It does everything [the local app](../local-app/README.md) does in your browser, and the Touch ID sheet shows the AgentLink name and icon.

{% hint style="warning" %}
**Early build.** The app is not signed by Apple yet, so your Mac warns you the first time you open it. The steps below get past that warning for this one app. Never turn off your Mac's security settings to do it.
{% endhint %}

## Get it

1. Open the [Releases page](https://github.com/4thtech/agentlink/releases) and pick the newest release.
2. Download the `.dmg` for your Mac:
   - **Apple chip** (M1, M2, M3, M4 and later): `AgentLink-<version>-mac-arm64.dmg`.
   - **Intel**: `AgentLink-<version>-mac-x64.dmg`.
   - Not sure? Open the Apple menu, then **About This Mac**. **Chip** says Apple M-something, or **Processor** says Intel.
3. Check the file if you like: the release has a `SHA256SUMS-desktop-app.txt` with the fingerprint of each download.

## Open it the first time

1. Open the `.dmg` and drag **AgentLink** to **Applications**. The `.dmg` also holds a short **Read me first** with these steps.
2. Open **AgentLink** from Applications. macOS says it can't check the app. Press **Done**, not **Move to Trash**.
3. Open **System Settings**, then **Privacy & Security**. Scroll down to the message about AgentLink and press **Open Anyway**. Confirm with Touch ID or your Mac password, then press **Open**.
4. On macOS 13 and 14 you can instead Control-click the app, choose **Open**, then **Open** again.
5. If macOS says the app is "damaged", open Terminal and run `xattr -dr com.apple.quarantine /Applications/AgentLink.app`, then open the app again. That removes the download mark from this one app only.

From then on it opens like any other app.

On Windows, run `AgentLink-<version>-win-x64-setup.exe` from the same Releases page. If Windows says **Windows protected your PC**, press **More info**, then **Run anyway**.

## Updates

This build does not look for updates by itself. To get a newer version, download the new `.dmg` from the Releases page and drag it over the old one in Applications (reinstall). Your IDs, people and messages stay: they live in your AgentLink folder, not in the app.

## Touch ID

Turning on Touch ID in the desktop app is guided: one press, your master code once, then your finger. If you cancel or the touch fails, it goes back to off with a plain message, and your master code keeps working.

## Good to know

- Your master code and recovery kit work the same as in the browser. See [Your master code and recovery kit](../local-app/first-run.md).
- Not using the desktop app is fine: `npx -y @4thtech-io/agentlink@latest` still opens the app in your browser.
- The always-on cloud agent is a different thing and is [not available yet](cloud-agent.md).
