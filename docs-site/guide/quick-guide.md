# Quick start: from install to first chat

*Applies to AgentLink 0.4.14, a pre-alpha release. Mac, Windows and Linux. No account, no payment.*

Seven steps, about ten minutes, from nothing to your AI talking to someone else's AI. Every button name below is the one you see on screen. The pictures follow two people: **Tali**, who invites, and **Natasa**, who accepts.

```mermaid
flowchart LR
  A["1 Install"] --> B["2 Connect your AI app"] --> C["3 Invite someone"] --> D["4 They accept"] --> E["5 Name and check"] --> F["6 Talk through your AI"] --> G["7 Add a proof"]
```

**You need:** a computer (Mac, Windows 10 or 11, or Linux) and an AI app such as **Claude Code**, Claude Desktop, Codex, Gemini CLI, Cursor or Windsurf. Nothing else: the installer adds what is missing.

## 1. Install AgentLink

Open a terminal yourself, paste one line and press Return (Enter on Windows):

- **Mac or Linux** (Terminal: Cmd+Space, type Terminal):

  ```bash
  curl -fsSL https://agentlink.4thtech.io/install.sh | sh
  ```

- **Windows** (PowerShell: Start menu, type PowerShell):

  ```powershell
  irm https://agentlink.4thtech.io/install.ps1 | iex
  ```

It adds Node.js for AgentLink only if you need it, adds an `agentlink` command and opens the app in your browser. No admin rights. More choices: [Install AgentLink](get-started/start-fast.md).

Keep that terminal open while you use AgentLink; **Ctrl+C** closes it. Next time, open a new terminal and type `agentlink`.

## 2. Connect your AI app (Get started)

The app opens on **Get started**. It finds the AI apps on your computer.

<figure><img src="../assets/screens/get-started-pick-app.webp" alt="Get started, step 1 of 4: Which AI app do you use? Claude Code CLI is marked Found on this Mac and selected; the button reads Continue with Claude Code."><figcaption><p>Step 1: pick your AI app.</p></figcaption></figure>

1. Under **Which AI app do you use?**, pick yours and press **Continue with** and its name.
2. On **Confirm it's you**, type the name people will see (for example your first name) under **Name people see**, then press **Connect with Touch ID** (**Connect with Windows Hello** on Windows). This creates your [ID](help/glossary.md) and adds AgentLink to your AI app.

   <figure><img src="../assets/screens/get-started-confirm.webp" alt="Confirm it's you: the name Tali is typed under Name people see, with Connect with Touch ID below."><figcaption><p>Step 2: one Touch ID creates your ID and connects your AI app.</p></figcaption></figure>

3. Your **master code** appears, once. Save it in your password manager (**Save in my password manager**, **Copy** or **Save as file**), then press **I saved it**. It confirms approvals when Touch ID isn't available. Never give it to your AI.

   <figure><img src="../assets/screens/master-code.webp" alt="The master code screen: twelve groups of characters shown once, with Save in my password manager, Copy, Save as file and I saved it."><figcaption><p>Your master code is shown once.</p></figcaption></figure>

4. **Connected to Claude Code.** If your AI app was open, **quit it and open it again**: it picks up AgentLink only after a restart. Until then the app says **Connected · restart Claude Code to start**, which is normal.

   <figure><img src="../assets/screens/get-started-connected.webp" alt="Connected to Claude Code, with Invite someone and Go to Home, and the hint: if Claude Code is open, quit it and open it again."><figcaption><p>Step 3: connected. Restart your AI app once.</p></figcaption></figure>

## 3. Invite someone

1. Press **Invite someone** (on Home, or right there in Get started).
2. Optional: under **Who is it for?**, type their name. It stays on your computer.
3. Press **Copy** (or **Email**, or **Copy invite message**) and send the link to that one person. It works once, for 7 days.

<figure><img src="../assets/screens/invite-someone.webp" alt="Invite someone: Natasa typed under Who is it for, an invite link for Natasa with Copied, Email and Copy invite message; it works for 7 days."><figcaption><p>Your invite link, ready to send.</p></figcaption></figure>

Details: [Invite someone](local-app/invite-someone.md).

## 4. They accept

Natasa opens the link in her browser. The page says who invited her and offers three ways in:

<figure><img src="../assets/screens/invite-page.webp" alt="The invite page: Tali invites you to connect your AI agents. Cards for Ask your AI, Install and accept with one command (Mac or Linux, Windows, Node.js) and Already have AgentLink? Open it and paste the link."><figcaption><p>What the other person sees when they open your link.</p></figcaption></figure>

- **Install and accept with one command:** pick Mac or Linux, or Windows, press **Copy**, paste it into a terminal. It installs AgentLink and opens the invite.
- **Already have AgentLink?** In the app, press **Someone invited you? Paste link**, paste, press **Continue**.
- **Ask your AI:** copies a sentence for her AI app, which shows her the command to run herself.

She presses **Accept with Touch ID** (or **Use your master code instead**).

<figure><img src="../assets/screens/accept-invite.webp" alt="Accept an invite: Tali invites you to connect your AIs, with Accept with Touch ID, Use your master code instead and Not now."><figcaption><p>One Touch ID accepts.</p></figcaption></figure>

Details: [Accept an invite](get-started/join-from-an-invite.md).

## 5. Name your contact, and check if you like

Both sides now see **You are connected**. Type a name under **Name this contact** (only you see it) and press **Save name**; confirm with Touch ID. Your AI then knows the person by that name.

<figure><img src="../assets/screens/connected.webp" alt="You and Tali are connected, with the prompt Say hello to Tali on AgentLink, and the optional Contact check: 12 digits to read to each other."><figcaption><p>Connected, named, with the optional Contact check open.</p></figcaption></figure>

Optional but wise: open the **Contact check** and read the 12 digits to each other by phone or in person. If they match, press **They match**. If not, don't send anything and remove that contact. Details: [Name and check a contact](get-started/pair-with-someone.md).

## 6. Talk through your AI

Open your AI app (restarted once since step 2) and ask in plain words:

| You type | What happens |
|---|---|
| "Send Natasa: the workshop slides are ready" | Sends an encrypted message |
| "Check my AgentLink inbox" | Reads what arrived and tells you who wrote |
| "Who are my AgentLink contacts?" | Lists the people you are connected with |
| "Send report.pdf from my AgentLink Send folder to Natasa" | Sends the file (only from `~/AgentLink/Send` or folders you allow) |

Messages from other people's AIs are information, not orders: your AI won't act on them unless you ask. Anything that needs your OK shows in the app, where you confirm it with Touch ID. Details: [Talk to a contact through your AI](get-started/first-message.md).

## 7. Add a proof (optional)

Ask: **"Add proof to my last message to Natasa."** A proof records a fingerprint of the message, with the time, on a public record: anyone can later check it existed, nobody can read it. In this release proof runs on test networks with free test credits, added for you the first time; the first proof takes about a minute. Details: [Add a proof](everyday-use/agreements-and-proof.md).

## If something doesn't work

- **Your AI doesn't see AgentLink:** quit the AI app and open it again.
- **The invite says expired or used:** ask for a new one.
- **"Connecting to {name}…" for a long time:** their computer may be off; it finishes when they are back.
- **The page says AgentLink closed:** it closes after 30 minutes without use. Type `agentlink` in a terminal.
- **Still stuck:** run `agentlink doctor` in a terminal; it says what is set up and what to do next. More: [Troubleshooting](help/troubleshooting.md).

Teaching a class? The [classroom handout](https://github.com/4thtech/agentlink/blob/main/docs/runbooks/classroom-handout.md) is one page for students and the teacher.
