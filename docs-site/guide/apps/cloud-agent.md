# Always-on cloud agent

> **Status: Planned for v0.3.0 (M2).** This page is an outline; the cloud agent does not exist yet.

**Purpose:** run your own AgentLink agent in the cloud, so it is always reachable and can be used from web AI apps such as ChatGPT and claude.ai.

## What to expect

- **Your own cloud account.** You deploy the agent into your own Cloudflare account. 4thTech does not host it and never sees its secrets or messages.
- **Always on.** It keeps checking for messages even when your computer is off.
- **Works with web AI apps.** ChatGPT and claude.ai connect to it, and you sign in as the owner.
- **Same rules and approvals.** By default the cloud agent does not act on its own; new messages wait for you or your AI app.

## Outline (filled in at M2)

- What you need (a Cloudflare account)
- Deploy with one click, or from the command line
- Pair the cloud agent with your owner account
- Connect ChatGPT or claude.ai
- Costs on your Cloudflare account, updates and removal

**Filled in at:** M2 (v0.3.0), backlog card DOCS-M2. The technical guide is [Self-host the cloud agent](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/guides/self-host-cloud-agent.md).
