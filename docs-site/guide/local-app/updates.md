# Updates

*Applies to AgentLink 0.5.6. Updates is new in 0.5.1. **Update now** works in the Mac app, the Windows app and the browser app from 0.5.6 on (the buttons in the Mac app did nothing in 0.5.4 and 0.5.5).*

**If you have 0.5.4 or 0.5.5, install 0.5.6 once by hand:** on a Mac, download the DMG and replace AgentLink in Applications; on Windows, run the new setup.exe; for the browser app, run `npx -y @4thtech-io/agentlink@latest`. From 0.5.6 on, an update is one click. Your IDs, people and messages stay as they are.

Open **Settings** › **Updates** (in the **This app** group). It is the one place to update AgentLink. It shows the version you have and a **Check for updates** button. AgentLink also checks by itself once a day while it runs. The button asks at most once a minute.

When a newer version is out, the page says so, for example **AgentLink 0.5.2 is ready**, with the one step that fits how you installed AgentLink. Your IDs, people and messages stay as they are: they live in your AgentLink folder, not in the program.

## Before AgentLink is set up

You can leave setup at any step. Every step of Get started and of restoring shows **Check for updates** and **Help**, in the browser and in the desktop app. Before AgentLink is set up, pages that need it say **Set up AgentLink first** with **Continue setup**, and Settings › Updates works: your version and **Check for updates**; **Update now** and **Restart now** in the Mac app; **Download the new version** in the Windows app; and how to update in the browser app. Nothing that needs your Touch ID, Windows Hello or master code opens without it.

## Desktop app

Press **Download update** and follow the short steps on the page. The Mac app and the Windows app, from 0.5.6, update themselves: **Update now**, a progress bar, then **Restart now**. See [Desktop app: Updating](../apps/desktop-app.md#updating). A new version also shows in the [bell](notifications.md), and the desktop app can say **Update ready** in a notification.

## Browser app

The browser app is what the one-command installer sets up, and what `npx -y @4thtech-io/agentlink@latest` opens.

From 0.5.6 the browser app updates itself, with no command to type:

1. When the page says **AgentLink 0.5.7 is available**, press **Update now**. AgentLink gets the new version and checks it (**Downloading…**, then **Checking the new version…**).
2. Press **Restart now**. AgentLink closes and opens again in a new browser tab with the new version, in the same terminal window. You can close the old tab.
3. Quit and reopen your AI apps so they use the new version too. The page says so.

AgentLink installs only the exact version the npm registry names as the latest, and only when the registry shows it was built by AgentLink's own release workflow; it checks every package it gets and runs no install scripts. Your own npm settings are not used for it. Your IDs, people and messages stay as they are.

If AgentLink can't update itself here, the page shows the steps instead:

- **You installed with the one-command installer, or you start it with npx.** A restart is the update, because each start picks the newest version:
  1. In the terminal window where AgentLink is running, press **Ctrl+C**.
  2. Start it again: type `agentlink` (installer) or `npx -y @4thtech-io/agentlink@latest` (npx). The page shows the right command with **Copy**.
  3. AgentLink opens in your browser again.
- **You installed it with `npm install -g`.** That copy is never changed from the page. The page shows the one command, with **Copy**:
  1. Press **Ctrl+C** in the terminal window where AgentLink is running.
  2. Run `npm install -g @4thtech-io/agentlink@latest`.
  3. Start it again with `agentlink`.

After an update, an AI app still running the older version shows **Restart {app} to use the new version**: quit that app and open it again.

## What the check sends

The browser app asks the npm registry (registry.npmjs.org) which version of `@4thtech-io/agentlink` is the latest, and nothing else; the desktop app asks GitHub. The registry sees your IP, as any website you visit does, and the standard Node.js user agent (`node`); no ID, contact, message, name or version number is sent.

**When.** The browser app checks once, about 30 seconds after AgentLink starts, then once a day while it runs, and when you press **Check for updates** (at most once a minute). It keeps the result in memory only and writes nothing to your computer. Offline, the page says so.

**Update now (browser app).** Only when you press it: npm downloads that one version from registry.npmjs.org (npm sends its usual user agent, with the npm and Node.js versions) and AgentLink keeps it in the `updates` folder inside your AgentLink folder; the older one there is removed. Nothing about your IDs, contacts or messages is sent.

**Turning it off.** Start AgentLink with the setting `AGENTLINK_UPDATE_CHECK=off` (for example `AGENTLINK_UPDATE_CHECK=off agentlink`). The page then says checking is turned off, and AgentLink never asks.

Back to [Settings](settings.md).
