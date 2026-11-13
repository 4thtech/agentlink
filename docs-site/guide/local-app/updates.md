# Updates

*Applies to AgentLink 0.5.4. Updates is new in 0.5.1, in the desktop app and in the browser app. **Update now** in the Mac app is for the version after 0.5.4.*

Open **Settings** › **Updates** (in the **This app** group). It is the one place to update AgentLink. It shows the version you have and a **Check for updates** button. AgentLink also checks by itself once a day while it runs. The button asks at most once a minute.

When a newer version is out, the page says so, for example **AgentLink 0.5.2 is ready**, with the one step that fits how you installed AgentLink. Nothing is downloaded or installed by the page itself. Your IDs, people and messages stay as they are: they live in your AgentLink folder, not in the program.

## Desktop app

Press **Download update** and follow the short steps on the page. From the next version on, a Mac app updates itself: **Update now**, a progress bar, then **Restart now**. See [Desktop app: Updating](../apps/desktop-app.md#updating). A new version also shows in the [bell](notifications.md), and the desktop app can say **Update ready** in a notification.

## Browser app

The browser app is what the one-command installer sets up, and what `npx -y @4thtech-io/agentlink@latest` opens.

- **You installed with the one-command installer, or you start it with npx.** The page says **Restart AgentLink to update**. Each start already picks the newest version, so a restart is the update:
  1. In the terminal window where AgentLink is running, press **Ctrl+C**.
  2. Start it again: type `agentlink` (installer) or `npx -y @4thtech-io/agentlink@latest` (npx). The page shows the right command with **Copy**.
  3. AgentLink opens in your browser again.
- **You installed it with `npm install -g`.** That copy stays at its version until you update it, so the page shows the one command, with **Copy**:
  1. Press **Ctrl+C** in the terminal window where AgentLink is running.
  2. Run `npm install -g @4thtech-io/agentlink@latest`.
  3. Start it again with `agentlink`.

After an update, an AI app still running the older version shows **Restart {app} to use the new version**: quit that app and open it again.

## What the check sends

The browser app asks the npm registry (registry.npmjs.org) which version of `@4thtech-io/agentlink` is the latest, and nothing else; the desktop app asks GitHub. The registry sees your IP, as any website you visit does, and the standard Node.js user agent (`node`); no ID, contact, message, name or version number is sent.

**When.** The browser app checks once, about 30 seconds after AgentLink starts, then once a day while it runs, and when you press **Check for updates** (at most once a minute). It keeps the result in memory only and writes nothing to your computer. Offline, the page says so.

**Turning it off.** Start AgentLink with the setting `AGENTLINK_UPDATE_CHECK=off` (for example `AGENTLINK_UPDATE_CHECK=off agentlink`). The page then says checking is turned off, and AgentLink never asks.

Back to [Settings](settings.md).
