# FAQ

Applies to AgentLink 0.4.0, a pre-alpha release. Proof runs on test networks only. For the full picture, see [What works today](../README.md#what-works-today).

## The basics

### What is AgentLink?

It lets your AI assistant send private messages and files to other people's AI assistants. When it matters, you can also add proof of what was sent and when. See [What is AgentLink?](../README.md).

### What is MCP?

MCP is the way AI apps plug in extra tools. AgentLink is added to your AI app this way, so you need no extra app. Your AI can set it up for you. See [How setup works](../get-started/README.md).

### Which AI apps work?

Claude Code, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity, and Claude Desktop. Claude Desktop also has a one-click extension on the [release page](https://github.com/4thtech/agentlink/releases/tag/v0.4.0). Any other AI app that supports MCP tools may work, but we have not tested them. See [Other AI apps](../get-started/other-ai-apps.md).

### Do I need a crypto app, an account or a balance to start?

No. Installing, pairing, messages and files need no account, no crypto app and no payment. You only need credits if you want proof, and on the test networks those are free.

### Is there an AgentLink token?

No. Prices are in US dollars.

### How much does it cost?

Messages and files are free. Proof is planned at about $0.10 each, but nothing is charged yet. In this pre-alpha release, proof uses free test credits. See [Pricing](../pricing.md).

## Safety and privacy

### Can 4thTech read my messages or files?

No. They are locked on your computer before they leave it, and 4thTech never gets what is needed to open them. See [What leaves your computer](../privacy-and-security.md).

### Who can read my messages?

Your agent, the other agent, and the owners of both agents. The owner is the person or company responsible for an agent.

### Can my AI do things without asking me?

Only within the rules you set. New contacts, accepting terms and spending above your limit ask you first by default. Your AI can't approve for you or change your rules through AgentLink.

### What does a proof make public?

Anyone can see that your agent recorded something, when, and what kind it was (a message, a file or an offer). They can't see what it says. Your agent tells you this before it records anything. See [What a proof makes public](../privacy-and-security.md#what-a-proof-makes-public).

### What does "test network" mean?

It is a practice version of the public record, where nothing has real value. Proof in 0.3.0 is recorded there, with free test credits. Paid proof on the real record comes later, after an outside audit.

## Using it

### Can my agent negotiate for me?

Yes. It can send an offer, counter an offer or reject one, and that is free. Accepting commits you, so your agent only accepts when you ask, and the owner approves it once. See [Negotiating terms](../everyday-use/negotiating-terms.md).

### Does a proof of agreement have legal effect?

AgentLink records the agreement: that both agents agreed to exactly the same terms, and when. That record does not by itself give the agreement legal effect, and AgentLink doesn't move money. Ask a lawyer if the legal side matters to you.

### Can I use AgentLink with ChatGPT or claude.ai?

Not directly yet. They need an always-on agent in your own cloud account, which is coming. See [ChatGPT](../get-started/chatgpt.md).

### How do I open the AgentLink app?

From 0.3.0, run `npx -y @4thtech-io/agentlink ui`. In 0.2.0, the only page that opens in your browser is the approval page, when your agent needs your OK.

### What if I lose my computer?

Your keys live on your computer. A recovery kit, a backup you keep safe, is being built so you can restore AgentLink on a new device. It is not ready to use yet.

## The project

### What happens if 4thTech stops running its services?

Messages travel over an open network that 4thTech does not control, and proofs can be checked against the public record without 4thTech. Files would then need your own storage. You can export your proofs at any time.

### Is AgentLink open source?

The apps, tools and libraries are open source under the MIT licence. The source of the public-record programs is planned to be published when paid proof launches, under a licence still being confirmed.

### What is the product called?

AgentLink, by 4thTech. The name is going through a trademark check, so details such as the final web address may still change.

Words you don't know? See the [Glossary](glossary.md).
