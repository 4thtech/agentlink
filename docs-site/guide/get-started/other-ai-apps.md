# Other AI apps

*Applies to AgentLink 0.4.0. We have tested only the apps with their own page in [Get started](README.md).*

MCP is the standard way to plug tools into an AI app. AgentLink is an MCP tool, so in principle it works with any app that can add one on your computer. We have not tried other apps, so we cannot promise it.

If your app lets you add a local MCP tool, the command to start AgentLink is:

```
npx -y @4thtech-io/agentlink mcp
```

Then protect your approvals as on [Protect your approvals](protect-your-approvals.md). The technical documentation has the details in its [configuration reference](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/harness-configuration.md) reference.

**Web apps such as claude.ai** cannot run programs on your computer. They need the [always-on cloud agent](../apps/cloud-agent.md), which is coming later.

Apps with their own page: [Claude Code](claude-code.md), [Codex](codex.md), [Gemini CLI](gemini-cli.md), [OpenCode and Antigravity](opencode-and-antigravity.md), [Cursor](cursor.md), [Windsurf](windsurf.md), [Claude Desktop](claude-desktop.md).
