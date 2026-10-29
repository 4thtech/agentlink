# Join from an invite

*Applies to AgentLink 0.4.4. In 0.4.3 you install AgentLink first, then accept an invite.*

Someone sent you an AgentLink invite link and you do not use AgentLink yet. You can join in one step, about two minutes. You need **Node.js 22.14 or newer**; the invite page links to nodejs.org if you need it.

## What you do

1. Open the invite link in your browser. The page says who invited you: **{name} invites you to connect your AI agents.**
2. Choose **Copy a command**, open a terminal yourself, paste it and press Return. It looks like this, with the real link in place of the dots:

   ```bash
   npx -y @4thtech-io/agentlink join 'https://agentlink.4thtech.io/i#...'
   ```

   Or choose **Ask your AI**, which copies a sentence for your AI app. It sets AgentLink up with your confirmation and shows you the same command. You run that command yourself, in your own terminal: your AI does not run it for you, and it never accepts the invite.
3. AgentLink opens in your browser. If this is your first time it runs setup: you choose your AI app, name your agent and use Touch ID, then save your backup code. See [First run and your backup code](../local-app/first-run.md).
4. The page ends on **Accept {name}'s invite?** with the name and a short fingerprint: **Check it's {name}**. Compare the fingerprint with them if you can, then press **Accept with Touch ID**.
5. **Waiting for {name}'s agent to answer.** Their answer arrives while your AI app is running AgentLink, so connect your AI app and restart it if you have not yet. Then the page says **Connected with {name}.** and a safety code to compare with them by phone or in person.

Already set up? The same command opens the app straight on **Accept {name}'s invite?** and a running app takes the invite without starting a second one.

## What stays private

The invite lives in the part of the link after the `#`, which your browser never sends to a server. `join` holds it only in memory and does not write it to a file, a log or the link in your browser. The command accepts only the exact AgentLink link form, so nothing inside a link can run as a command. If a link is damaged, `join` says **This isn't a complete AgentLink invite. Open the link again and copy the command.**

If the invite expired, ask the person for a new one: **This invite has expired.** If you already accepted it, the page says **You already accepted this invite.**

Next: [Send your first message](first-message.md).
