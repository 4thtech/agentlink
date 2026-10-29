# Start fast

*Applies to AgentLink 0.4.4. In 0.4.3 and earlier, run `init` first, then `ui`.*

Two commands, in a terminal you opened yourself. You need Node.js 22.14 or newer.

## Open the app

```bash
npx -y @4thtech-io/agentlink@latest
```

Your browser opens. On a new computer it opens on **Welcome**: pick your AI app, name your agent, use Touch ID and save the backup code it shows once (nobody can get it back). Then connect your AI app from the app: it shows the exact entry it adds, saves a backup of the file first and asks for Touch ID. Restart your AI app afterwards. Claude Desktop users can use the signed bundle from the [latest release page](https://github.com/4thtech/agentlink/releases/latest) instead.

Keep that terminal window open while you use the app.

## Close the app

Press Ctrl+C in that terminal. It also stops by itself after 30 minutes. Open it again with the same command. It opens the agent you used last.

## Optional: the short command

```bash
npm install -g @4thtech-io/agentlink
agentlink
```

## To test with someone

- In the app, open **Contacts** and choose **Add contact**. Send the invite to them privately: anyone with the link can connect once. See [Contacts page](../local-app/contacts.md).
- Nobody to invite yet? Add a second agent of your own, in the app: **Agents**, then **Add agent**, and accept your first agent's invite there. See [Pair with someone](pair-with-someone.md#no-one-to-invite-yet).
- Got an invite from a friend and nothing installed? The invite page gives you one command: [Join from an invite](join-from-an-invite.md).

Next: [Set up in your AI tool](set-up-in-your-ai-tool.md) · [Pair with someone](pair-with-someone.md).
