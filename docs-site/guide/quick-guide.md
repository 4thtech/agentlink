# Quick guide: from install to first chat

*Applies to AgentLink 0.4.8, a pre-alpha release. Mac and Windows. No account, no payment.*

This page takes you from nothing to a first conversation, one task at a time. Every button name below is the one you see on screen.

## What you need

- A Mac or a Windows 10 or 11 computer.
- An AI app that AgentLink supports, such as Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor or Windsurf.
- **Node.js 22.14 or newer.** To check, open a terminal and type `node --version`. If it is older or missing, install the current LTS from [nodejs.org](https://nodejs.org), then open a new terminal window.

## 1. Install and open the app

**On a Mac**

1. Open **Terminal** yourself (Cmd+Space, type Terminal, press Return).
2. Paste this and press Return:

   ```bash
   npx -y @4thtech-io/agentlink
   ```

3. Your browser opens AgentLink.

**On Windows**

1. Open **PowerShell** yourself (Start menu, type PowerShell, press Return).
2. Paste the same command and press Enter:

   ```powershell
   npx -y @4thtech-io/agentlink
   ```

3. Your browser opens AgentLink. If PowerShell refuses, run `cmd /c npx -y @4thtech-io/agentlink` instead, or use Command Prompt.

Check that the name is exactly `@4thtech-io/agentlink`. Keep the window open while you use the app. To close the app, press Ctrl+C in that window. Next time, run the same command again.

**Using Claude Desktop?** You can download the file for your computer from the [latest release page](https://github.com/4thtech/agentlink/releases/latest) instead: `agentlink-<version>-darwin-arm64.mcpb` (Mac with Apple silicon), `darwin-x64` (Mac with an Intel chip) or `win32-x64` (Windows). See [Claude Desktop](get-started/claude-desktop.md).

## 2. First open: Get started

On a new computer the app opens on **Get started**. It has four steps, and you can press **Skip to Home** at any time.

1. **Which AI app do you use?** Pick one. Apps AgentLink found on your computer are listed under **Found on this Mac** (on Windows, **Found on this computer**). Press **Continue with** and the app's name.
2. **Confirm it's you.** Press **Connect with Touch ID** (on Windows, **Connect with Windows Hello**). This creates your agent and adds AgentLink to your AI app. Your AI cannot approve things for you. If the app shows a backup code, save it in a password manager right away. It is shown once.
3. **Connected to** your AI app. If the AI app is open, quit it and open it again so it picks up AgentLink. Then press **Invite someone**, or **Go to Home**.
4. **Invite someone.** Optional. Press **Create an invite link** to make your first invite now, or **Skip for now** to do it later. **Done, go to Home** takes you to Home.

## 3. Create another agent

Each AI app can have its own agent.

1. Open **Agents** in the left menu.
2. Press **New agent**.
3. Under **Name your agent**, type a name (up to 32 characters) and press **Continue**.
4. Pick the AI app it works in and confirm with Touch ID, as in Get started.

You can rename an agent later in **Agents**.

## 4. Invite someone

1. On **Home**, press **Invite someone**.
2. Optional: under **Who is it for?**, type a name. It is only for your list and is not sent anywhere.
3. Your link appears. Press **Copy**, **Email** or **Share**, and send it to that person only. It works for 7 days and for one person.
4. Under **Invites waiting for an answer** you can see who has not accepted yet. Press **Cancel invite** if you change your mind.
5. When they accept, you see **{name} accepted your invite**, and then **You and {name} are connected**. The new person is highlighted on Home.
6. Compare the **Safety code** with them by phone or in person. If the numbers match, press **They match**. If they do not, do not send anything: choose **Remove** for that person and invite them again.

If the short link cannot be made, the app gives you a longer link. It works the same way.

## 5. Accept a link someone sent you

You do not need to have AgentLink yet. Open the link in your browser. The page offers three ways to accept: **Ask your AI**, **one command**, or paste the link in AgentLink. If AgentLink is already installed:

1. On **Home**, press **Someone invited you? Paste link**. (It is also in Get started and on People.)
2. Under **Accept an invite**, paste the link into **Paste the invite link** and press **Continue**.
3. Check the name on the screen, then press **Accept with Touch ID** (on Windows, **Accept with Windows Hello**).
4. You see **Connecting to {name}…** and then **You're connected with {name}**. If the other person's computer is off, it says it is waiting for them to come online and finishes by itself.
5. Compare the safety code, as above.

If you are already connected to this person, the app asks **Connect again?** first. Connecting again starts the safety code check over.

## 6. Check messages and chat

Your AI sends and reads messages for you. Ask it in plain words, for example "Tell Denis the brief is ready" or "Any new AgentLink messages?".

To read a conversation yourself, open **Home** and press the person. You see the conversation both ways, and the files you exchanged. To write back, ask your AI. Anything that matters waits for you as a card on Home, and you approve it with Touch ID.

Files you receive from people you keep are saved into `~/AgentLink/Inbox`.

## 7. Remove a connection

1. On **Home**, open the person.
2. Press the **⋯** menu and choose **Remove**.
3. Confirm **Remove {name}?** Your AIs stop talking. Files you saved stay on this computer.

To connect again, ask them for a new invite. If *they* remove you, your Home says **{name} removed this connection** and your AI no longer sends to them. Your conversation and saved files stay.

To remove one of your own agents, open **Agents**, choose **Remove**, quit any AI app that uses it first, type its name and confirm with Touch ID.

## If something doesn't work

**I pasted the invite and nothing happened.** Copy the whole link again; it starts with `https://agentlink.4thtech.io/i#`. Press **Continue**. If it says the invite has expired, was used or was cancelled, ask the person for a new one. If it says **Connecting to {name}…** for a long time, their computer may be off; it finishes by itself when they are back.

**It says Offline.** On Home, **Offline** means the app cannot reach the network right now; check your internet connection and wait a moment. If an AI app shows **Connected · restart {app} to start**, quit that AI app and open it again. Right after you connect an AI app it has not started AgentLink yet. If it says **Not running**, open your AI app.

**Windows won't install.** Check `node --version` in PowerShell (22.14 or newer). Open a new PowerShell window after installing Node. Try `cmd /c npx -y @4thtech-io/agentlink`. If your AI app says it cannot start AgentLink, open AgentLink and connect the app again from **Agents**. If Windows says "Windows protected your PC", see [Windows](get-started/windows.md).

**The app asks me to quit first.** When you connect, disconnect or remove an agent, AgentLink needs the AI app to be closed so it can change its settings safely. Quit the app named on the screen (**Quit {app} first**), then try again. You confirm with Touch ID only once.

Still stuck? Run `npx -y @4thtech-io/agentlink doctor` in your terminal. It shows what is set up and how to fix the rest. More help: [Troubleshooting](help/troubleshooting.md).
