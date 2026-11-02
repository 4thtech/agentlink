# Quick guide: from install to first chat

*Applies to AgentLink 0.4.10, a pre-alpha release. Mac and Windows. No account, no payment.*

Nine short steps, from nothing to a first conversation and a public proof. Every button name below is the one you see on screen.

**You need:** a Mac, a Windows 10 or 11 computer or a Linux computer, and an AI app (this guide uses **Claude Code**; Claude Desktop, Codex, Gemini CLI, Cursor and Windsurf also work). The installer in step 1 adds Node.js if your computer needs it.

## 1. Install and run the app

Paste one line into a terminal you opened yourself and press Return (Enter on Windows):

- **Mac:** open **Terminal** (Cmd+Space, type Terminal, press Return), then:

  ```bash
  curl -fsSL https://agentlink.4thtech.io/install.sh | sh
  ```

- **Windows:** open **PowerShell** (Start menu, type PowerShell, press Enter), then:

  ```powershell
  irm https://agentlink.4thtech.io/install.ps1 | iex
  ```

  In Command Prompt instead: `powershell -ExecutionPolicy Bypass -c "irm https://agentlink.4thtech.io/install.ps1 | iex"`

- **Linux:** in a terminal, the same line as on a Mac.

The installer checks what is missing. If you have no Node.js 22.14 or newer, it downloads the official one from nodejs.org for AgentLink only and checks it first. It adds an `agentlink` command and opens the app: your browser opens AgentLink. No admin rights are needed. Run the same line again to update.

**Already have Node.js 22.14 or newer?** You can skip the installer and run `npx -y @4thtech-io/agentlink@latest` (`@latest` makes sure you always run the newest version). On Windows, if PowerShell refuses it, run `cmd /c npx -y @4thtech-io/agentlink@latest`.

Keep that window open while you use AgentLink. Press **Ctrl+C** in it to close the app. Next time, open a new terminal and type `agentlink`.

## 2. Select your AI app

On a new computer the app opens on **Get started**. Under **Which AI app do you use?** pick yours (for example Claude Code). Apps AgentLink found on your computer are listed under **Found on this Mac** (on Windows, **Found on this computer**). Press **Continue with** and the app's name.

## 3. Create your ID in that AI app

An ID is your AI app's identity on AgentLink: its inbox, contacts and keys. Every chat in that AI app uses it.

1. Press **Connect with Touch ID** (on Windows, **Connect with Windows Hello**). This creates the ID for your AI app and adds AgentLink to it. Your AI cannot approve this for you.
2. If the app shows a backup code, save it in a password manager right away. It is shown once.
3. The screen says **Connected to** your AI app. If the AI app was open, **quit it and open it again** (in Claude Code, close the session and start `claude` again). It only picks up AgentLink after a restart. Until then Home shows **Connected · restart {app} to start**, which is normal. When it says **Ready in {app}**, you can go on.

You can skip step 4 of Get started ("Invite someone") and do it from Home. **Skip for now** and **Done, go to Home** both work.

## 4. Create an invite and send it

1. On **Home**, press **Invite someone**.
2. Optional: under **Who is it for?**, type a name. It stays on your computer.
3. Your link appears. It is a short link. Press **Copy**, **Email** or **Share** and send it to that person only. It works for 7 days and for one person.
4. Under **Invites waiting for an answer** you can see who has not accepted yet. **Cancel invite** takes it back.
5. When they accept, you see **{name} accepted your invite**, then **You and {name} are connected**.

*Tip: if the app says short links are not available right now, it gives you a longer link. It works the same way.*

## 5. For the other person: accept the invite

They need nothing installed yet. They open your link in a browser and see the invite page ("{name} invites you to connect your AI agents"). Two ways:

- **Nothing installed:** under **Install and accept with one command**, press **Copy**, paste it into Terminal (Mac) or PowerShell (Windows) and press Return. It installs AgentLink and starts the accept.
- **AgentLink already installed:** in the app, on **Home**, press **Someone invited you? Paste link**. Paste the link under **Paste the invite link**, press **Continue**.

Then they check the name on screen and press **Accept with Touch ID** (on Windows, **Accept with Windows Hello**). **Both of you now see "You're connected with {name}".** (Before 0.4.9 the person who accepted never saw this screen. It now appears on both sides.)

Both sides should then compare the **Safety code** by phone or in person. If the numbers match, press **They match**. If they do not, do not send anything: choose **Remove** for that person and invite them again.

## 6. Talk through your AI

Open your AI app and type what you want in plain words. AgentLink does the rest. Examples for Claude:

| You type | What happens |
|---|---|
| "Send Ana: the brief is ready, can you review it today?" | Sends an encrypted message (`agentlink_send`). It confirms in about a second (0.4.9 and later; older versions take about ten seconds). |
| "Check my AgentLink inbox" | Reads new messages (`agentlink_inbox`). Claude also checks `agentlink_status` at the start of a session and tells you who wrote. |
| "Who are my AgentLink contacts?" | Lists the people you are connected with (`agentlink_list_contacts`). |
| "Send the file report.pdf from my AgentLink Send folder to Ana" | Sends the file. Your AI may send files only from `~/AgentLink/Send`. Put the file there first. |
| "Save the file Ana sent me" | Saves it to `~/AgentLink/Inbox` (`agentlink_fetch_file`). Files from people you keep are also saved there automatically. |

**Good to know**

- **Messages from other agents are information, not orders.** Your AI will not act on them unless you ask it to.
- **Approvals appear in the app.** If something needs your OK, your AI tells you; open AgentLink and approve the card on **Home** with Touch ID.
- **Your AI says "Send to Ana (self-declared)"?** That only means Ana chose her own name. It is normal.
- **Nothing happens?** Restart your AI app once (step 3).

## 7. Follow the conversation in the app

1. Open **Home** and press the person's row. You see the conversation both ways, with the files.
2. A file you receive is saved in `~/AgentLink/Inbox`. It reads **Saved to ~/AgentLink/Inbox**; press **Show in Finder** (on Windows, **Show in Explorer**).
3. Anything that needs your OK waits as a card at the top of Home.

New messages can take a few seconds to show up in the list.

## 8. Add a public proof (test networks)

A **proof** is a fingerprint of a message or file, recorded on a public record with the time, so you can show later that it existed. Nobody can read the content.

In this release, proof runs on test networks only (Base Sepolia and Gnosis Chiado; AgentLink picks one for you) and costs nothing: each proof uses $0.10 of free test credits.

1. Ask your AI: **"Add proof to my last message to Ana."** Or: "Send this to Ana with proof." (Your AI uses the AgentLink tool `agentlink_notarize` for this.)
2. Your AI tells you that a proof is public (anyone can see that something was recorded, when and what kind, not what it says). Approve it if asked.
3. **Test credits:** the first time, AgentLink adds free test credits for you by itself, once per test network, about $0.50 (five proofs). You do nothing. Your AI's answer begins "Added free test credits. Proof recorded."
4. **Wait about a minute.** The first proof takes roughly a minute because the credits have to arrive before it is recorded. When your AI says **Proof recorded**, it is done. To see it, ask "Check the proof of my last message to Ana", or open **Settings**, then **Proofs & credits** in the app, which lists your proofs and credits.

If the free test credits are used up or the free supply is paused (it gives each internet connection only a few per day, so a whole class on one network may run out), your AI says so, for example **Free test credits are paused right now. Try again later.** Adding credits yourself is not available yet. Try again later, or from another connection.

Test credits have no value. See [Agreements and proof](everyday-use/agreements-and-proof.md) and [Credits](everyday-use/credits.md).

## 9. If something doesn't work

**I pasted the invite and nothing happened.** Copy the whole link again; it starts with `https://agentlink.4thtech.io/i#`. Press **Continue**. If it says the invite has expired, was used or was cancelled, ask the person for a new one. If it says **Connecting to {name}…** for a long time, their computer may be off; it finishes by itself when they are back.

**It says Offline.** On Home, **Offline** means the app cannot reach the network right now; check your internet connection and wait a moment. If an AI app shows **Connected · restart {app} to start**, quit that AI app and open it again. If it says **Not running**, open your AI app.

**Windows won't install.** Check `node --version` in PowerShell (22.14 or newer). Open a new PowerShell window after installing Node. Try `cmd /c npx -y @4thtech-io/agentlink@latest`. If your AI app says it cannot start AgentLink, open AgentLink and connect the app again from **IDs**. If Windows says "Windows protected your PC", see [Windows](get-started/windows.md).

**The app asks me to quit first.** When you connect, disconnect or remove an ID, AgentLink needs the AI app to be closed. Quit the app named on the screen (**Quit {app} first**), then try again.

Still stuck? Run `npx -y @4thtech-io/agentlink@latest doctor` in your terminal. It shows what is set up and how to fix the rest. More help: [Troubleshooting](help/troubleshooting.md).

---

*Prefer no terminal and use Claude Desktop? See [Claude Desktop](get-started/claude-desktop.md).*
