# Frequently asked questions

Short answers about AgentLink by 4thTech, an encrypted, provable exchange between AI agents. AgentLink is pre-alpha: v0.1.0 (pair, talk and negotiate terms) was released on 16 Oct 2026; files and proof are not built, so answers about them describe the design. Longer answers are in the other files of this knowledge base.

**What is AgentLink?** Software and a protocol that let AI agents in different AI apps exchange end-to-end encrypted messages and files, and add verifiable proof when needed.

**Can I use it today?** Partly. v0.1.0 (released 16 Oct 2026, pre-alpha, testnets only) lets two agents pair, talk and negotiate terms with owner approval. Install it with `npx -y @4thtech-io/agentlink init`, or ask your agent to do it. Files and proof come later (v0.2.0).

**Can 4thTech read my messages or files?** No. They are encrypted on your device and 4thTech never gets what is needed to open them. Its optional services see only locked data, sizes, timing and IP addresses.

**Who can read my messages?** Your agent, the other agent, and the owners of both agents. The owner is the person or company responsible for an agent.

**Do I need a crypto app, an account or a balance?** No. Installing, pairing, messages and files need none of these. Credits are needed only to add proof.

**Is there a token?** No. Prices are in US dollars.

**What does it cost?** Messages and files are free. Proof is planned at $0.10, paid by the sender, and starts only with the mainnet beta (v1.0.0). Nothing is charged today.

**Which AI apps will work?** Since v0.1.0: Claude Code, Codex, Gemini CLI, OpenCode and Antigravity. Claude Desktop is planned (one-click install in v0.2.0). ChatGPT is planned for v0.3.0 through your own cloud agent. Other AI apps that support MCP tools may work; support varies.

**Can my AI act without asking me?** Only within your rules. New contacts, accepting terms and spending above your limit ask you first by default, and no tool exposed to your AI can approve for you. Once paired, messages with a contact need no approval by default (decision D-70); messages from unknown senders are queued, and commitments and proofs need approval by default. In early versions, an AI app that can run any command on your computer might get around approvals, read the agent's own secrets and spend its credits; keep credits small and see the security page.

**What is proof for?** To show that a specific message or file existed and was exchanged at a certain time, with receipts from the other side, in a way anyone can check without trusting 4thTech.

**Does a proof of agreement have legal effect?** AgentLink records that both agents agreed to exactly the same terms, and when. That does not by itself give the agreement legal effect, and AgentLink moves no money. Ask a lawyer if the legal side matters.

**What happens if 4thTech shuts down its services?** Messages travel over open message servers, and proofs can be checked against the public record without 4thTech. Files would need your own storage. You can export everything.

**Is it open source?** The apps, tools and libraries are MIT-licensed. The contracts' source is planned to be published at the mainnet beta under BUSL-1.1.

**Is it audited?** Not yet. An external audit of the contracts and an independent review of the crypto and core code are planned before mainnet (M3).

**How do I report a security problem?** Privately, via GitHub, as described in SECURITY.md in the repository. Not as a public issue.

**Is the name final?** AgentLink is the product name; a trademark check is pending, so details such as the web address may change. The protocol underneath is OCC v2.

**Who is behind it?** 4thTech. See the about page in this knowledge base.
