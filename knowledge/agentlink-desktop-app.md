# AgentLink desktop app (Mac and Windows)

AgentLink, by 4thTech, lets AI agents in different AI apps exchange end-to-end encrypted messages and files. The desktop app is the AgentLink app in its own window, with its own icon. Version described: 0.5.5 and later (0.5.8 is the current release; the download links always give the latest). The sections below are about the early Mac app, except "Is there a Windows app?"; the browser app works the same and needs no download.

## What it is

- It does everything the browser app does, with the same IDs, people, messages and approvals; the Touch ID sheet shows the AgentLink name and icon.
- It is an **early, unsigned build**: Apple has not checked it, so the Mac warns you the first time you open it. That does not mean something is wrong with the file.
- Mac (Apple chip and Intel) and, since 0.5.4, Windows (see "Is there a Windows app?"; there the browser app stays the main way). No Linux app yet. It is not the planned always-on cloud agent.

## How do I get it?

Download only from https://github.com/4thtech/agentlink/releases/latest, never from a link someone sent you. Get the `.dmg`: `AgentLink-mac-arm64.dmg` for Apple chip (M1 and later), `AgentLink-mac-x64.dmg` for Intel. Direct links: https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-mac-arm64.dmg and https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-mac-x64.dmg. Not sure which: Apple menu, About This Mac ("Chip: Apple M…" or "Processor: Intel"). Other release files (`.mcpb`) are not needed; `SHA256SUMS-desktop-app.txt` lists each download's fingerprint.

## How do I open it the first time?

The app is not signed by Apple yet, so macOS blocks it the first time. Four steps, once:

1. Open the `.dmg` and drag AgentLink to Applications.
2. Open AgentLink from Applications. macOS blocks it ("cannot be opened" or "could not verify"): press Done (or OK), not Move to Trash.
3. Allow it once: System Settings, Privacy & Security, scroll down, next to the message that AgentLink was blocked press **Open Anyway**, confirm when your Mac asks (Touch ID, or what you type to unlock your Mac), then press Open. macOS 13 or 14 can instead: in Applications, Control-click AgentLink, choose Open, then Open.
4. You only do this once.

Why: AgentLink isn't signed with an Apple Developer ID yet. Never turn off your Mac's security settings for it.

If macOS says the app is "damaged" and offers only the Trash, the app is not damaged; macOS says this about some unsigned apps. Press Cancel and run this one line in Terminal, then open the app again: `xattr -dr com.apple.quarantine /Applications/AgentLink.app`. Use it only for the "damaged" message.

## How do updates work?

Settings, Updates shows your version and **Check for updates** (also once a day by itself). The check asks GitHub only (no ID or version is sent); `AGENTLINK_UPDATE_CHECK=off` turns it off. Your IDs, people and messages live in your AgentLink folder, not in the app, so they stay.

The Mac app on 0.5.6 or newer and the Windows app on 0.5.16 or newer update themselves on a click (on Mac 0.5.4 or 0.5.5 install 0.5.6 once by hand; on Windows 0.5.14 or 0.5.15 in-app updates did not work, so download 0.5.16 once by hand from https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-win-x64-setup.exe: quit AgentLink from the icon near the clock, open the file, if Windows says it protected your PC choose More info, then Run anyway; after that updates install from inside the app); updates are signed with a key pinned in the app. Settings, Updates shows **Update now**, a download progress bar with the percentage, "Checking the new version", then **Restart now** (nothing changes before you press it; if a request waits for your approval, the page says so first) and "Restarting". If the new version does not start, the previous one comes back by itself. If the app can't update itself, the page says "Couldn't update here. Download the new version instead." and shows the download button. On Windows the "Download the new version" box shows only when a check fails or this install can't update itself (0.5.16), not while checking.

## How does Touch ID work in the app?

Open Settings, Touch ID & master code, press **Use Touch ID for approvals**, type your master code once and touch the sensor. **Test Touch ID** on the same page checks that it works. If you cancel or the touch fails, it goes back to off with a plain message and your master code keeps working.

## Does the app show notifications?

Yes, real AgentLink notifications (never message text, file names or links; they approve nothing). Details and switches: agentlink-files-and-storage.md.

## Is there a Windows app?

Yes, from 0.5.4, as an early, unsigned build for Windows 10 and 11: download AgentLink-win-x64-setup.exe from https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-win-x64-setup.exe and open it. Windows may say "Windows protected your PC": choose More info, then Run anyway. It installs for you only (no administrator rights), adds AgentLink to the Start menu and offers "Create a desktop shortcut" (ticked by default). If Smart App Control (some Windows 11 computers) blocks it, use the browser app instead; never turn Smart App Control off. Updates: from 0.5.16 the Windows app updates itself in Settings › Updates (on 0.5.14 or 0.5.15 download 0.5.16 once by hand first) (Update now, then Restart now; it closes, installs the new version and opens again; if anything fails, the current version keeps working). If your `.agentlink` folder is open to others (for example Everyone), the app says "Your AgentLink folder is shared"; remove the extra access in Properties › Security, then Try again. Remove the app in Settings › Apps.

## Browser first, app later; Windows Hello

The browser app and the desktop app are one AgentLink: start in the browser, install the app later, same IDs and AI apps (the browser window says "AgentLink moved to the AgentLink app"). On a Mac, the first open asks for your Mac login password, never your master code: choose Always Allow. In the Windows app, Windows Hello works like Touch ID (Settings, Windows Hello & master code); with no Windows Hello PIN the app says so and uses your master code (set one up in Windows Settings, Accounts, Sign-in options). If the Windows app won't open, `core.log` is in `%LOCALAPPDATA%\AgentLink\logs`.

## The menu bar widget (0.5.9)

Since 0.5.12, opening a message or a new file from the widget or a notification moves the app to it in place, and what you opened leaves the widget and the bell.

From 0.5.9 the Mac and Windows apps show the AgentLink mark in the menu bar (Mac) or near the clock (Windows). Its shape shows the state: connected, connecting, an approval waiting (filled dot), paused, offline, update ready; a hollow ring means unread messages. It moves briefly on a new message, a message your AI sends or a waiting approval (not when the computer asks for reduced motion). A click opens a read-only widget: Needs you, Connected now (your AI apps), Contacts (last exchange only, never "online"), New messages with a one-line plain-text preview (up to 80 characters; new files appear only under Needs you until you open, save or show them), Today by the hour, Live and a footer. Approvals, Pause, Resume and Update open the main window; the widget approves nothing. Right-click gives Open AgentLink and Quit. Settings › Appearance has "Show AgentLink in the menu bar" ("near the clock" on Windows) and "Show message previews", both on by default; on Windows, with the icon hidden, closing the window quits AgentLink (new icons start in the hidden ^ area: drag it out or use Settings › Personalization › Taskbar). Guide: https://github.com/4thtech/agentlink/blob/main/docs/guide/apps/menu-bar-widget.md

## Other things to know

- Closing the window keeps AgentLink running in the menu bar; it comes back when you click its menu-bar or Dock icon, or when it has a page to show you. Quit it with Cmd+Q, or with **Quit** in the menu you get by right-clicking its menu-bar icon. Your AI app runs its own AgentLink either way.
- To remove it, drag AgentLink to the Trash. Your IDs and messages stay until you delete your AgentLink folder.
- Problems: open an issue at https://github.com/4thtech/agentlink/issues without your master code or any invite link. Full guide: https://github.com/4thtech/agentlink/blob/main/docs/guide/apps/desktop-app.md
