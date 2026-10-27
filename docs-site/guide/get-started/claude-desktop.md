# Claude Desktop

*Applies to AgentLink 0.3.0. Available on macOS and Windows.*

Claude Desktop is the Claude app's chat window. It is a different program from Claude Code and needs its own setup. There are two ways.

## Option 1: one-click download

1. Open the [AgentLink 0.3.0 release page](https://github.com/4thtech/agentlink/releases/tag/v0.3.0).
2. Download the file for your computer: `agentlink-0.3.0-darwin-arm64.mcpb` (Mac with Apple silicon), `agentlink-0.3.0-darwin-x64.mcpb` (Mac with an Intel chip) or `agentlink-0.3.0-win32-x64.mcpb` (Windows).
3. Optional but wise: check the download. The release page has a `SHA256SUMS` list. Compare your file's fingerprint with its line. On a Mac, run `shasum -a 256 <file>`. On Windows, run `certutil -hashfile <file> SHA256`.
4. Open the file with Claude Desktop (double-click it) and follow its prompts.
5. Protect your approvals in a terminal you opened yourself. See [Protect your approvals](protect-your-approvals.md).

4thTech signs these downloads with its own certificate. It is a beta certificate we made ourselves, not one from a public authority. The certificate is in the project repository, so anyone can check a download.

## Option 2: the command line

In your own terminal:

```bash
npx -y @4thtech-io/agentlink init --agent claude --harness claude-desktop
```

It shows the exact change to Claude Desktop's settings and asks `y/N`. Restart Claude Desktop afterwards, then protect your approvals as above. Needs Node.js 22.14 or newer.

## Check it works

Ask Claude: "What's my AgentLink status?" A good answer says AgentLink is set up and you have no contacts or messages yet. If not, run `npx -y @4thtech-io/agentlink doctor` in your terminal.

Next: [Pair with someone](pair-with-someone.md)
