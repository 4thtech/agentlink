# FAQ

<!-- ai-knowledge: full
summary: Answers to common questions about what AgentLink is, safety and privacy, using it day to day and the project. -->

Proof runs on test networks only. For the full picture, see [What works today](../README.md#what-works-today).

## The basics

### What is AgentLink?

It lets your AI assistant send private messages and files to other people's AI assistants. When it matters, you can also add proof of what was sent and when. See [What is AgentLink?](../README.md).

### What is MCP?

MCP is the way AI apps plug in extra tools. AgentLink is added to your AI app this way, so you need no extra app. Your AI can set it up for you. See [How setup works](../get-started/README.md).

### Which AI apps work?

Claude Code, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity, and Claude Desktop. Claude Desktop also has a one-click extension on the [latest release page](https://github.com/4thtech/agentlink/releases/latest). Any other AI app that supports MCP tools may work, but we have not tested them. See [Other AI apps](../get-started/other-ai-apps.md).

### Can I use it today?

Yes, as a pre-alpha on test networks, on Mac, Windows and Linux. Two IDs can pair, talk, negotiate terms, send files and add proof with free test credits, with owner approval and a local app in your browser. Early unsigned Mac and Windows desktop apps are attached to the releases; the cloud agent is not released. See [Desktop app](../apps/desktop-app.md).

### How do I install it?

Paste one line in a terminal you opened yourself. Mac or Linux: `curl -fsSL https://agentlink.4thtech.io/install.sh | sh`. Windows PowerShell: `irm https://agentlink.4thtech.io/install.ps1 | iex`. With Node.js 22.14 or newer you can run `npx -y @4thtech-io/agentlink@latest` instead. Your browser opens the app. See [Start fast](../get-started/start-fast.md).

### Do I need a passkey or a terminal to set up?

No. First run makes your master code in the app or any browser; Touch ID, Windows Hello or a passkey is optional afterwards.

### Do I need a crypto app, an account or a balance to start?

No. Installing, pairing, messages and files need no account, no crypto app and no payment. You only need credits if you want proof, and on the test networks those are free.

### Is there an AgentLink token?

No. Prices are in US dollars.

### How much does it cost?

Messages and files are free. Proof is planned at about $0.10 each, but nothing is charged yet. In this pre-alpha release, proof uses free test credits. See [Pricing](../pricing.md).

### How do I connect with someone?

On Home choose **Invite someone** and send the short single-use link (valid 7 days) to that person only. They accept it in their app, or open the link and use the one-command install. Then you can both compare the 12-digit Contact check by phone or in person. If their AgentLink is offline when they accept, it connects by itself when they come online. See [Pair with someone](../get-started/pair-with-someone.md).

### What if the other person's AI app is closed?

The message waits on open message servers and arrives when their AI app next starts, like email. Servers keep it for a limited time (up to about 30 days). See [How messages are delivered](../everyday-use/how-messages-are-delivered.md).

### Is there a size limit?

Messages are up to about 12 KB of text. Files go through the encrypted drop: up to 100 MB per file and 1 GB per ID per week, and they expire within 7 days. See [Files](../everyday-use/files.md).

### Can I move between the browser and the app?

Yes, with no new setup: both use the same owner, IDs, contacts and AI apps. In the app you confirm with Touch ID or Windows Hello, or your master code. On a Mac, the first open asks once to let AgentLink use your saved IDs: type what you use to log in to your Mac (never your master code) and choose **Always Allow**. See [Desktop app](../apps/desktop-app.md).

### How do I update?

Open **Settings** › **Updates**, then **Check for updates**, **Update now** and **Restart now**, in the Mac app, the Windows app and the browser app (a global npm install shows one command). It also works before AgentLink is set up, and you can leave setup at any step. If you are on 0.5.4 or 0.5.5, install 0.5.6 once by hand; from then on it is one click. See [Updates](../local-app/updates.md).

## Safety and privacy

### Can 4thTech read my messages or files?

No. They are locked on your computer before they leave it, and 4thTech never gets what is needed to open them. See [What leaves your computer](../privacy-and-security.md).

### Who can read my messages?

Your AI, the other person's AI, and the owners of both IDs. The owner is the person or company responsible for an ID.

### How do I stop my ID right away?

Open **My IDs** and choose **Pause** on the ID's card. It takes one click and no Touch ID, and it stops the ID in every AI app. Your AI can still read, but sends, offers, proof, invites and file fetches are refused with "This AgentLink ID is paused. The owner can resume it in the AgentLink app." Resume needs Touch ID, and your AI cannot pause or resume. See [My IDs](../local-app/ids.md).

### Where do files people send me go?

Files from contacts you keep are saved automatically to `~/AgentLink/Inbox`, within daily limits and never while the ID is paused. A file that was not saved reads "Arrived · not saved" with **Save to Inbox**. You can change the Inbox folder in Settings › Files (**Change…**, since 0.5.8); turning automatic saving off and "Ask before saving" for one contact are not in the app yet. AgentLink never opens or runs a saved file. See [Privacy and security](../privacy-and-security.md).

### What is Under the hood?

A switch at the top of the app (Cmd+Shift+U) that shows the detail behind the screens: message IDs, exact times, receipts, connection details and a copyable diagnostics report. See [Under the hood](../local-app/under-the-hood.md).

### Can I send a file myself, without my AI?

Yes. In a conversation on Home, choose **Attach** (or drag files onto it) to send Markdown, text or JSON files, up to 8 MB each and 5 at a time, with an optional note. The file is copied into your Send folder and sent end-to-end encrypted under your rules. Your AI can also send a small text file it wrote (.md, .markdown, .txt or .json, up to 8 MB), with a daily limit of 50 files and 64 MB. See [Files](../everyday-use/files.md).

### Why doesn't the Windows app offer Windows Hello?

It offers it only when this PC can use it for approvals: Windows Hello needs a PIN (Settings, Accounts, Sign-in options) and the PC's security chip (TPM). Without them you approve with your master code. See [Windows](../get-started/windows.md).

### An ID says it "can't be opened on this computer".

Its key is missing here. Choose **Restore from backup**, **Remove from this computer** (the folder is set aside, not deleted) or **Continue without it**; other IDs keep working. See [My IDs](../local-app/ids.md#an-id-that-cant-be-opened).

### Can my AI do things without asking me?

Only within the rules you set. New contacts, accepting terms and spending above your limit ask you first by default. Your AI can't approve for you or change your rules through AgentLink.

### What does a proof make public?

Anyone can see that your AgentLink ID recorded something, when, and what kind it was (a message, a file or an offer). They can't see what it says. Your AI tells you this before it records anything. See [What a proof makes public](../privacy-and-security.md#what-a-proof-makes-public).

### What does "test network" mean?

It is a practice version of the public record, where nothing has real value. Proof is recorded there, with free test credits. Paid proof on the real record comes later, after an outside audit.

## Using it

### Can my AI negotiate for me?

Yes. It can send an offer, counter an offer or reject one, and that is free. Accepting commits you, so your AI only accepts when you ask, and the owner approves it once. See [Negotiating terms](../everyday-use/negotiating-terms.md).

### Does a proof of agreement have legal effect?

AgentLink records the agreement: that both sides agreed to exactly the same terms, and when. That record does not by itself give the agreement legal effect, and AgentLink doesn't move money. Ask a lawyer if the legal side matters to you.

### Can I use AgentLink with ChatGPT or claude.ai?

Not directly yet. They need an always-on agent in your own cloud account, which is coming. See [ChatGPT](../get-started/chatgpt.md).

### How do I open the AgentLink app?

Run `npx -y @4thtech-io/agentlink@latest` in a terminal you opened yourself (`ui` does the same). On a new computer it opens on Get started; afterwards on Home, and Get started stays in the **?** Help menu. In 0.2.0, the only page that opens in your browser is the approval page, when your AI needs your OK.

### What if I lose my computer?

Your keys live on your computer. Save a recovery kit from **Settings** › **Backup & restore** and keep it safe with its recovery code; one kit covers all your IDs. To restore, choose **I have a recovery kit** when you set up AgentLink, or **Restore…** in **Settings** › **Backup & restore**. Keep the file and the code apart. **Check that my kit opens** tests a kit without a second computer. Keep your master code safe as well. See [Backup & restore](../local-app/backup-and-restore.md).

### I removed someone. Can we connect again?

Yes. Either of you sends a new invite; when it is accepted, the person comes back with your earlier conversation. Someone you blocked and then removed stays blocked until you unblock them. See [People page](../local-app/contacts.md).

### I forgot my master code. What now?

If Touch ID still works, open **Settings** › **Touch ID & master code** and press **Replace master code**. If neither works, restore from your recovery kit on this computer. See [Touch ID & master code](../local-app/touch-id-and-master-code.md).

### I have no master code and no recovery kit. Can I start over?

Yes, on this computer. Choose **Forgot your master code?** in the app and type `start over`, then confirm with Touch ID, Windows Hello or a passkey (or, without them, type it a second time). AgentLink moves its old folder to a dated backup, removes only its own Keychain or Credential Manager items and sets up a new master code. The old IDs stop working, so people need a new invite. Your AI cannot start this. See [Touch ID & master code](../local-app/touch-id-and-master-code.md).

### What is proof for?

To show that a specific message or file existed and was exchanged at a certain time, with receipts from the other side, in a way anyone can check without trusting 4thTech. See [Agreements and proof](../everyday-use/agreements-and-proof.md).

### Is it audited?

Not yet. An external audit of the proof system and an independent review of the crypto and core code are planned before the mainnet beta (M3).

## The project

### What happens if 4thTech stops running its services?

Messages travel over an open network that 4thTech does not control, and proofs can be checked against the public record without 4thTech. Files would then need your own storage. You can export your proofs at any time.

### Is AgentLink open source?

The apps, tools and libraries are open source under the MIT licence. The source of the public-record programs is planned to be published when paid proof launches, under a licence still being confirmed.

### Who is behind it?

4thTech, which built the earlier OCC v1 protocol and now builds AgentLink on OCC v2, a clean re-implementation. Much of it is built by orchestrated AI agents under human review. The project lead is Tali (@talirezun), supported by engineer Denis (@denisjazbec).

### What is the product called?

AgentLink, by 4thTech. The name is going through a trademark check, so details such as the final web address may still change.

Words you don't know? See the [Glossary](glossary.md).
