# Start fast

*Applies to AgentLink 0.4.3.*

Three commands, in a terminal you opened yourself. You need Node.js 22.14 or newer.

## Set up once

It finds your AI apps and asks before changing anything.

```bash
npx -y @4thtech-io/agentlink@latest init
```

Claude Desktop users can use the signed bundle from the [latest release page](https://github.com/4thtech/agentlink/releases/latest) instead.

## Open the app

Your browser opens. The first time, the setup page asks for Touch ID and shows a backup code. Save it right away: nobody can get it back.

```bash
npx -y @4thtech-io/agentlink@latest ui
```

## Close the app

Press Ctrl+C in that terminal. It also stops by itself after 30 minutes.

## Optional: the short command

```bash
npm install -g @4thtech-io/agentlink
agentlink ui
```

## To test with someone

- In the app, open **Contacts** and choose **Add contact**. Send the invite to them privately: anyone with the link can connect once. See [Contacts page](../local-app/contacts.md).
- Or add a second agent of your own, after your first setup (two steps, in this order):

```bash
npx -y @4thtech-io/agentlink@latest init --agent test2
npx -y @4thtech-io/agentlink@latest owner add-agent --agent test2
```

Next: [Set up in your AI tool](set-up-in-your-ai-tool.md) · [Pair with someone](pair-with-someone.md).
