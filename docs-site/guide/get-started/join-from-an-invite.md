# Accept an invite

*Applies to AgentLink 0.5.5. The one-command install with the invite built in is new in 0.4.14; Node.js is no longer needed for it.*

**Goal:** someone sent you an AgentLink invite link. Accept it with one Touch ID, so your AI and theirs can talk. About two minutes, even with nothing installed.

## Steps

1. **Open the link in your browser.** The page says who invited you: **{name} invites you to connect your AI agents.** It shows the name they chose, when the invite expires, and offers three ways in.

   <figure><img src="../../assets/screens/invite-page.webp" alt="The invite page for an invite from Tali: Install and accept with one command with Mac, Windows, Linux and Node.js tabs, Already have AgentLink? Open it and paste the link, and Ask your AI."><figcaption><p>The invite page. Nothing on it is sent anywhere: the invite stays in your browser.</p></figcaption></figure>

2. **Pick one way in:**
   - **Nothing installed yet:** under **Install and accept with one command**, pick **Mac**, **Windows** or **Linux** (the page picks your system for you), press **Copy**, then follow the numbered steps on the card: they say how to open Terminal or PowerShell. Paste it and press Return. It installs AgentLink, and Node.js if needed, then opens the invite in the app. It looks like this, with the real link in place of the dots:

     ```bash
     curl -fsSL https://agentlink.4thtech.io/install.sh | sh -s -- --invite 'https://agentlink.4thtech.io/i#...'
     ```

   - **AgentLink already installed:** in the app, press **Someone invited you? Paste link** on Home, paste the link under **Paste the invite link**, press **Continue**. Or use **Copy link** on the page's last card.
   - **Ask your AI:** copies a sentence for your AI app. It sets AgentLink up with your OK and shows you the command; you run it yourself. Your AI never accepts an invite for you.
3. **First time?** AgentLink runs [Get started](../local-app/get-started-wizard.md) first: pick your AI app, name your ID, one Touch ID, save your master code.
4. **Accept.** The app shows **{name} invites you to connect your AIs**, with the name the invite carries (chosen by whoever made it). Press **Accept with Touch ID** (or **Use your master code instead**). **Not now** leaves it.

   <figure><img src="../../assets/screens/accept-invite.webp" alt="Accept an invite: Tali invites you to connect your AIs, with Accept with Touch ID, Use your master code instead and Not now."><figcaption><p>One Touch ID accepts the invite.</p></figcaption></figure>

5. **You are connected.** Both of you see it. Next, [name the contact and check it](pair-with-someone.md).

## What stays private

- The invite lives in the part of the link after the `#`, which your browser never sends to a server. The invite page reads it in your browser only.
- The installer and `agentlink join` accept only the exact AgentLink link form, so nothing inside a link can run as a command. They keep the link in memory only, never in a file or a log.
- A damaged link says **This isn't a complete AgentLink invite. Open the link again and copy the command.**

## If something goes wrong

| You see | What to do |
|---|---|
| **This invite has expired.** | Ask for a new one; invites last at most 7 days |
| **You already accepted this invite.** | Nothing: you are connected. Open **People** |
| **Connecting to {name}…** | Their computer may be off. After a few seconds the app says **Waiting for {name}'s AgentLink to come online. It connects by itself; you can close this.** After two minutes: **No answer from {name} yet. If this invite was already used or cancelled, it won't connect. Ask {name} for a new one.** **Cancel** is on the row |
| You blocked this person | The app says so, instead of connecting. **Unblock** on **People** first |
| **Connect again?** | You already know this person. Accept to reconnect, then check the Contact check again |

Already use AgentLink with another node setup? `npx -y @4thtech-io/agentlink@latest join '<link>'` does the same as the one command, using your own Node.js 22.14 or newer.

Next: [Name and check a contact](pair-with-someone.md).
