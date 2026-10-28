# BUSINESS-AGENTS proposal: companies' own agents on AgentLink (Decision 20)

| | |
|---|---|
| **Status** | Proposal; **owner decisions 1–10 and 12 of §10 accepted by Tali in chat, 28 Oct 2026** (every recommended option); decision 11 (pilot company) is to be named by the owner. The spec text is not yet written. Specs win on conflict until the owner decides; the spec text is written by BIZ-SPEC after the decisions in §10. |
| **Owner intent** | Decision 20 (Tali, in chat, 28 Oct 2026): companies run their own agents in the cloud with access to their own data (Claude-based, GPT-based or another vendor's). People connect their personal agents to them through links published on the company website. Agreement through propose/respond terms, owner approval, optional public proof. Part of 0.5.0 with the cloud agent (D-131, D-135). Companies plug in agents they already have through a no-code setup ("Legos putting together Legos"). Companies are charged; users stay free. No payments between agents and no booking payments: payment stays with the company's own checkout. |
| **Specs that win on conflict** | 00 (D-34, D-37, D-39, D-40, D-47, D-53, D-55, D-114, D-130, D-131, D-135), 04 (I-1…I-10, §2.5 owner presence, §2.7 domain verification, §3.6 pairing, §4 SSRF), 06 §2.1, §2.2a, §3, §4, 07 §3.2, 08 §3 and §4, 11 §5, 12 |
| **Related** | `docs/process/proposals/UX-WAVE-2.md` (PR #631: the Add contact sheet, item 1); backlog M2-3* (0.5.0 cloud slice), M2-12 (domain verification), M2-13 (browser counterparty) |
| **Date** | 28 Oct 2026 |

## 1. Summary

A **business agent** is an ordinary AgentLink cloud agent (the D-131 template) deployed in the **company's own Cloudflare account**, switched into a **business mode**, and connected to the agent the company already runs (on Claude, OpenAI or anything else). People add it as a contact through a **business link** on the company website, see **"Verified domain · skico.com"** on the contact, negotiate with `agentlink_propose_terms` and `agentlink_respond_to_terms` as in J8, approve once with their passkey, and get a proof of agreement that the company pays for. Payment happens afterwards on the company's own checkout page.

Recommendations in one line each:
- **Hosting:** the company self-hosts, exactly like a person's cloud agent (D-37, D-131). 4thTech still hosts nothing that holds a key. A 4thTech-managed hosting option conflicts with I-1, I-3 and D-37 and is not recommended (§6.1).
- **Connector ("Lego"):** **one tool surface, several ways to wake the agent.** The company's agent always talks to AgentLink through our remote MCP server (the same 15 tools and the same policy engine). When a message arrives, the business agent wakes the company's agent through a **native invoker** (Claude first, OpenAI second), an **A2A** call, or a **signed wake-up webhook**, and hands it a short-lived token scoped to that one conversation (§5).
- **Identity:** the existing domain claim (04 §2.7, D-34), required for business links, checked by the person's own client at accept time, shown like the safety code is today.
- **Release:** 0.5.0 ships the cloud agent plus the business foundations behind a pilot switch for one travel company; general availability in a 0.5.x release after the pilot (§10 decision 4).
- **Pricing:** a monthly Business plan for the services 4thTech operates (business link pages and directory, raised relay and drop limits, onboarding and support); proofs at the standard fee, paid by the company; the pilot is free; billing starts when the card path exists (D-111, D-15).

## 2. What exists today, and the gaps

| Need | What exists (main at 4eb54fd6) | Gap |
|---|---|---|
| Always-on agent in the cloud | D-131 cloud agent: Worker + one `AgentDO`, own owner with passkey, OAuth for claude.ai, alarm-only relay sync every 60 s (08 §3) | Built for one person and a chat app; "autonomous" actions are off and "not in 0.5.0" (08 §3.4) |
| Inviting | Single-use invite, 7-day expiry, first come first served, safety code (04 §3.6, §3.6.1) | A link on a public website must be answered by many people |
| Proving who a company is | Domain claim by DNS TXT or `/.well-known` (04 §2.7, D-34); card M2-12 depends on the Registry (M2-4a) | Not built; tied to the Registry although the live check alone decides the label |
| Agreeing | Typed terms, owner approval once, proof of agreement (02 J8, 06 §2.2a, D-55) | Auto-accept is an allowlist of contact IDs (06 §3); a business with thousands of new contacts needs a rule per link |
| Unknown senders and limits | Requests queue: 5 per sender, 200 in total (07 §3.2) | Sized for a person, not a business |
| Connecting an AI | A chat app connects to the cloud agent's `/mcp` with OAuth after the owner's passkey sign-in; grants last at most 30 days (08 §3.3, D-131 (j), (m)) | A server-side agent cannot do a passkey sign-in every month, and nothing wakes it when a message arrives |

## 3. User journeys

### 3.1 The person (free)

1. **Find.** On skico.com there is a button "Ask our agent on AgentLink" (or a QR code in the shop). It opens the business link page on our invite host: SkiCo's name, **"Verified domain · skico.com"** once the person's own client has checked it, a one-line note "SkiCo's agent runs on an AI service chosen by SkiCo", and the usual "I use Claude / ChatGPT / Gemini / Other" install-and-accept prompt (08 §4, D-53).
2. **Add contact.** The person pastes the prompt into their AI (or uses "I have an invite" in the Add contact sheet, UX-WAVE-2 item 1). Their client decodes the link, **checks the domain claim itself** (04 §2.7: DNS-over-HTTPS or the SSRF-safe `/.well-known` fetch; no 4thTech service in the path), and the owner's pairing approval (`contacts.acceptInvites`, default `approval`) shows: "Add **SkiCo** · Verified domain · skico.com · Business". For a business contact the verified domain takes the place of the safety code comparison, which is impractical with a company (§4.2).
3. **See the badge.** In Contacts and Messages the contact carries "Verified domain · skico.com" and a "Business" label. If a later re-check fails, the contact does **not** drop to "Self-declared": no safety code was ever compared, so the domain was its only binding. The contact is **paused** until the domain checks again: its inbound messages are held (not shown to the AI), every commitment with it is blocked, and the person sees "SkiCo's domain could not be checked. This contact is paused until it can." (§4.2).
4. **Ask and negotiate.** "Ask SkiCo's agent what's free from 14 to 21 February for two, under €1,800, then book the one I pick." The person's AI sends a message; SkiCo's agent answers with options; the person picks; SkiCo's agent sends `agentlink_propose_terms` (subject, deliverables "4 nights, Chalet B, 2 adults", price "1650.00 EUR" paid by the customer (`payer: them` from SkiCo's side), deadlines, `validUntil`). Counters work as in J8. Everything SkiCo sends reaches the person's AI only inside the untrusted block (I-5, 06 §4).
5. **Approve.** The person's AI calls `agentlink_respond_to_terms` with `accept`; it returns `pending_approval` (D-31). The approval card shows the exact terms, "From SkiCo · Verified domain · skico.com", and "Accepting terms commits you to these terms. Payment happens on SkiCo's own checkout, not in AgentLink." One passkey or Touch ID approval (04 §3.4.2).
6. **Proof.** SkiCo's agent records its accept or a firm offer with proof (the company pays the $0.10; 12 §2, "Who pays: sender"). The person's ACCEPTED receipt is covered by that fee (D-114), so the person pays nothing. Both sides can export the proof of agreement (F-43).
7. **Pay on the company's site.** SkiCo's agent sends a checkout link as a message. It is untrusted text, shown as plain text, never an active link in our UI (11 §4 principle 3). The person's client shows next to it whether its host is the contact's verified domain or a subdomain of it ("Link to skico.com") or not ("Link to another site: check it before you pay"). The host comes from a WHATWG URL parse; it matches only when it equals the verified registrable domain or ends with "." plus it (so `evilskico.com` does not match); a link with userinfo (`https://skico.com@evil.example/`), a non-https scheme or a lookalike or internationalised host gets the "another site" line. The client never fetches it.
8. **Afterwards.** The business can answer within a conversation the person started; it cannot start new conversations (no marketing), under decision 7. Removing the contact ends it.

### 3.2 The company (paid)

1. **Sign up.** On the AgentLink business page: "Connect your agent to AgentLink". The guide states the cost up front: Cloudflare Workers Paid ($5 a month, D-131 (4)), the AI service they already pay for, and the Business plan (§7).
2. **Deploy.** Deploy to Cloudflare, or `agentlink cloud deploy` (D-131 (3), (9)), into the company's own account. Then `/setup`: setup code, the owner's passkey, recovery code shown once (08 §3.2). The owner is the company's administrator.
3. **Business profile and domain.** The setup wizard on the Worker's own origin (§5.4) asks for the business name and domain, shows the DNS TXT record or the `/.well-known/agentlink.json` file to publish, and checks it. The owner signs the `DomainClaim` with presence (04 §2.7).
4. **Connect the existing agent without code.** Pick the platform, paste what it asks for (an API key and an agent or model ID), press **Send a test message**. Details in §5.4.
5. **Set the rules.** What the agent may agree without asking (for example: only bookings where the customer pays, at least €50, at most 20 a day), and everything else waits for approval on `/approve` (§6.4).
6. **Publish the business link.** Name it ("Website"), set the daily limit and the end date, copy the link, the button snippet and the QR code. A short address `…/b/skico` is part of the Business plan (§4.1).
7. **Monitor.** A business dashboard on the Worker's origin (`/status`, extended): conversations today, waiting for approval, agreements, link use against its limit, invoker errors, and the pulse per conversation (counts and times only, as UX-WAVE-2 item 4). Pause the link or the whole agent with one switch.

## 4. Building blocks

### 4.1 Business links (multi-use invites)

- **Format.** A new invite version (`v: 2`, `kind: "business"`) in the same D-69 encoding, codec and size caps, plus `linkId`, `maxPerDay`, `expiresAt` (required, at most one year) and the `domain` named in the signed card's domain claim. Created and revoked only on the owner pages, with owner presence and an owner signature (new ops `link.create`, `link.revoke` in 04 §2.5.1), never by an MCP tool: a public link that adds contacts at scale is an owner decision (I-4 spirit; `agentlink_create_invite` stays single use).
- **Pairing.** Each person's answer is a normal handshake (04 §3.6) whose `proof` matches the link's `proofKey`; the link's `secret` is public by design, so the proof only shows that the answerer saw the link. The company's agent accepts it while the link is live, under its limits, and marks nothing "used". "A second answer" warnings do not apply to business links.
- **Safety code.** Not compared for business contacts; the verified domain binds the owner key instead. Whether the §3.6.1 commitment can be reused across many answers, or should be left out of `v: 2`, is a protocol question for BIZ-SPEC with a Fable review; it is not settled here.
- **Short address (Business plan).** `<name>` is only ever the verified domain itself (for example `/b/skico.com`), never a free-chosen name, so it cannot borrow another company's name. `https://<invite-host>/b/<domain>` serves the signed link payload from a 4thTech directory. The payload is public data with no secret of value; a compromised directory can swap it, but the swapped link fails the domain check at accept, so the directory can only deny service (I-3).
- **Rate limits and anti-abuse (company side).** Per link: accepts per hour and per day (owner-set, with a plan ceiling) and an end date; per new contact from a link: messages per hour and open negotiations at a time; a cap on link contacts that never wrote (they expire after 30 days); a block button per contact; the requests-queue limits of 07 §3.2 raised for business mode, still bounded. Exact numbers are set by BIZ-SPEC with the pilot's traffic in mind.

### 4.2 Verified business identity

- Reuses 04 §2.7 unchanged in substance: owner-signed `DomainClaim`, published by DNS TXT at `_agentlink.<domain>` or at `/.well-known/agentlink.json`, checked by the **viewing client** (DoH or the SSRF-safe fetch, cache 24 h, re-check downgrades and warns).
- **Decouple from the Registry.** 04 §2.7 says the live check decides the label and the Registry only timestamps a hash. Fixing the `DomainClaim` struct in BIZ-b instead of in the Registry task (M2-4a) lets the badge ship in 0.5.0; recording the hash in OCCRegistry follows with M2-4a.
- **A lapsed claim pauses the contact.** Unlike 04 §2.7 for ordinary contacts, a business contact whose claim fails a re-check (removed record, expired claim, other owner key) never downgrades to "Self-declared", because no safety code was compared. It is paused until re-verified: inbound held, commitments (accepts, firm offers, receipts) blocked; it resumes by itself when a check passes.
- **Public suffixes refused.** A `DomainClaim` for a public suffix (for example `co.uk`, or a shared hosting suffix on the Public Suffix List) is refused; the claim must name a registrable domain or a name under one (BIZ-SPEC fixes the list source and update rule).
- **Shown like a safety code.** At accept, on the contact card and on every approval card for that contact: "Verified domain · skico.com" (punycode shown too for internationalised names, 11 §5.2). A business link whose domain fails the check is refused with "This business link could not be checked for skico.com", never accepted as "Self-declared" (decision 8).
- **What it proves:** whoever controlled skico.com at check time vouched for this agent's owner. Not legal identity (04 §2.7); the copy never says "official" or "verified company".

### 4.3 Hosting many conversations on the cloud agent

- **Same template, business mode.** One deployment, one `AgentDO` (the single publisher, 06 §6), the D-131 store and KeyStore. Business mode adds: link and usage tables, link-contact rate counters, the invoker queue (§5.3), the business dashboard, and the raised limits.
- **Concurrency.** Inbound messages are stored and processed by the DO as today; waking the company's agent happens off the DO through a queue with retries and a per-contact ordering key, so one slow AI call never blocks other customers. The company's AI bill follows its traffic; the dashboard shows invoker errors and a cost hint.
- **Latency.** D-131 (f) decided alarm-only sync every 60 s. A person may then wait up to a minute for each answer, which matches "async, like email" (11 §4 principle 7) but is slow for a booking chat. Decision 9 asks whether business mode may use a shorter interval.
- **Ceiling.** One Durable Object handles the pilot comfortably on paper; BIZ-0 measures it (messages per second, store size per 10 000 contacts, alarm cost). Splitting a business across several objects changes the single-publisher rule and is out of scope for 0.5.x.

## 5. The "Lego" connector

### 5.1 The question

The company already has an agent with its data and tools (availability, prices, CRM). AgentLink must (a) give that agent the AgentLink tools and (b) wake it when a person writes, without the company writing code, without inbound text becoming instructions (I-5), and without plaintext or keys reaching 4thTech (I-1, I-2, I-3).

### 5.2 Options compared

| | A. Remote MCP only | B. Webhooks / HTTP callbacks | C. Native connectors per platform | D. Open agent protocols (A2A) |
|---|---|---|---|---|
| How it works | Their agent adds our `/mcp` as a remote MCP server (API key or OAuth) and polls `agentlink_inbox` | We POST each event to their URL; they call back over HTTP | We call their platform's API (with their key) to run their agent, giving it our MCP tools | We call their agent's A2A endpoint as a client; optionally expose ours as A2A |
| No-code for the company | Partly: adding an MCP server is configuration, but someone must schedule the polling | **No**: they build and host an endpoint | **Yes**: paste a key and an agent ID | Yes, if their platform already serves A2A |
| Wakes their agent on a new message | **No** (MCP has no push to an idle agent) | Yes | Yes | Yes |
| Works with many vendors | **Yes**: remote MCP is widely supported across agent platforms (to confirm per platform in BIZ-0) | Yes | One adapter per vendor; we maintain them | Growing, not universal (to confirm in BIZ-0) |
| Untrusted content (I-5) | Strong: inbound text only inside our wrapped tool results | Weak: we would push raw inbound text into their prompt pipeline | Strong if the wake-up carries no inbound text and the agent reads via MCP | Depends: A2A messages are content; we would send only a fixed wake-up |
| Policy and approvals | All in our core | Their callbacks must still go through our core | All in our core | All in our core, if tools are ours |
| Zero access | Holds (all inside their account) | Holds; plaintext to their URL, which is theirs | Holds; their vendor key sealed in their own Worker; plaintext to their vendor (their processor) | Holds |
| SSRF surface | None | Owner-entered URL (04 §4) | Fixed vendor hosts only | Owner-entered URL (04 §4) |

### 5.3 Recommendation: one tool surface, several ways to wake

**Use A for the tools and C/D/B only to wake the agent.**

1. **Tools: always our remote MCP server.** The company's agent uses exactly the 15 AgentLink tools (06 §2.0: 13 from D-53, two terms tools from D-55) through the business agent's `/mcp`. Every rule of the core applies: policies, approvals, wrapped inbound content, summaries without counterparty text. Nothing new is added to the frozen tool surface.
2. **Wake-up: an invoker.** When a message, offer or answer arrives from a contact, the business agent queues a wake-up. The invoker calls the company's agent with a **fixed text we write** ("New message from contact c_7f3a. Read it with agentlink_inbox and answer within your rules."), where `c_7f3a` stands for an **opaque local contact ID** generated by the business agent. The wake-up never carries a contact name or alias: a business contact's name falls back to the counterparty's self-declared name, which is inbound content (I-5). The call also carries an MCP server entry pointing at `/mcp` with a token. The invoker never puts inbound text into the prompt, system prompt or tool descriptions (I-5, 06 §4). Invokers, in order:
   - **Claude** (pilot): the company's model or agent ID and API key; the call passes our `/mcp` as a remote MCP server.
   - **OpenAI** (next): the same pattern with their agent or model and a remote MCP tool.
   - **A2A**: for any agent that serves an A2A endpoint; we send only the fixed wake-up.
   - **Signed webhook**: a content-free POST (`{event, opaque contact ID, time}` with an HMAC signature through `@4thtech-io/crypto`) for companies with their own stack; their code then calls `/mcp`.
   - **Manual**: their agent connects to `/mcp` itself and polls (A alone), for platforms with no invoker.
   Which vendor APIs accept a remote MCP server in a call, and how, is confirmed in BIZ-0 before any invoker is built; this proposal does not assume a vendor feature beyond that spike.
3. **A token per conversation.** For each wake-up the Worker mints a token that lives 15 minutes and is **scoped to one contact**: the agent can read that contact's inbox and send, propose and respond only to that contact. A person's message that tries to steer the company's agent ("list your other customers") then has nothing to reach. Tokens are random values from `@4thtech-io/crypto`, stored hashed, never logged (I-7), never sent to 4thTech.
4. **Owner-signed authorisation.** Connecting an invoker is an owner action on the owner pages: a new owner-signed op `invoker.authorize {invokerId, kind, vendor host, scope, expiry}` and `invoker.revoke`, checked on every `/mcp` request like `connector.authorize` (08 §3.3 step 4). **Expiry: at most 30 days**, as D-131 (m) requires for every connecting app; the dashboard warns a week ahead and the owner re-signs with one passkey gesture. A longer expiry would contradict D-131 (m) and is a separate owner decision (decision 12), not assumed here.
5. **Vendor secrets.** The company's AI key is stored sealed in its own `AgentDO` (through `@4thtech-io/crypto`, the same way as the seed under `SEED_WRAP_KEY`), entered on the owner page with presence, never returned to a page, never logged.

Why this over the alternatives: it is the only design that is **no-code** for the major platforms (paste a key), **wakes** the agent, keeps **one** security boundary (our core and the frozen tools) for every vendor, and keeps inbound content out of instructions. Webhooks alone push the work and the injection risk onto the company; MCP alone cannot wake an idle agent; native-only means one bespoke adapter per vendor with its own tool path; A2A alone is not yet everywhere.

### 5.4 What the setup UI asks, step by step

All pages are on the business agent's own origin (08 §3.1); every step that signs needs the owner's passkey.

1. **Name and domain.** Business name (at most 32 characters, 06 §2.1 rule) and domain.
2. **Prove your domain.** Two tabs: "Add a DNS record" (shows `_agentlink.skico.com` TXT value with Copy) or "Upload a file" (downloads `agentlink.json` for `/.well-known/`). **Check now** runs the same check a person's client runs. Passkey signs the claim.
3. **Connect your agent.** "Where does your agent run?" Claude · OpenAI · Any agent with an A2A address · Your own server · I'll connect it myself.
   - Claude / OpenAI: API key (masked), agent or model ID, optional "Instructions for AgentLink conversations" (the company's own text, kept with their agent configuration, never mixed with inbound text).
   - A2A: the agent's address (https only, checked by the 04 §4 rules at entry and at every call).
   - Own server: the webhook URL (same checks) and the signing secret shown once.
   - Myself: the `/mcp` address and a key under `invoker.authorize` (at most 30 days, D-131 (m)). The key itself never calls tools: their code exchanges it at a token endpoint for the same 15-minute tokens scoped to one contact that the invokers use, so the manual path has no wider reach than the others.
4. **Test.** "Send a test message": a built-in test contact sends "What is free next weekend?"; the page shows that the agent woke, read it and answered, with the invoker's timing. No real contact is involved.
5. **Rules.** "Agree without asking when": the customer pays (`payer: them` only); at least / at most an amount; up to N agreements a day and M per customer; only through the business link. This covers accepting a customer's terms **and** sending a firm offer (an offer with proof, which is a commitment, 04 §3.4.2). "Everything else waits for: you" (the owner's passkey on `/approve`). Proof is always on for agreements made without asking. Setting or raising any limit opens the D-132 confirmation sheet and shows the existing 06 §3 sell warning (setting `autoAcceptMinUSD`).
6. **Business link.** Name, daily limit, end date → link, button snippet, QR code, short address (Business plan).
7. **Go live.** A summary and one switch. The dashboard follows.

## 6. Security and zero access

### 6.1 Key custody

- The business agent's seed is generated on the company's computer or in the company's own Worker (D-131 (3), (9)); the owner seed exists only in the owner's browser (08 §3.2). 4thTech holds neither. I-1…I-3 unchanged.
- **Conflict flagged.** "Cloud version" in the owner's intent could be read as 4thTech hosting the company agents. That would put agent seeds and plaintext in a 4thTech system, which conflicts with I-1, I-2, I-3 and D-37 ("4thTech hosts nothing that holds a key"). This proposal does not recommend it (decision 1). A partner-hosted option (a hosting partner the company contracts directly) can be revisited later without changing the invariants.
- The company's AI vendor processes the conversation text, as every person's AI service does today (11 §4 principle 6). The business link page and the contact card say so in one line.
- **Conflict flagged: grant lifetime.** Server-side invokers would be easier with long grants, but D-131 (m) limits every connecting app to 30 days. This proposal keeps 30 days (including the "connect it myself" key) and asks the owner in decision 12.

### 6.2 Untrusted content (I-5)

- On the person's side: everything from the business is untrusted, including offers, names of rooms, prices in deliverables and checkout links. Summaries name only the contact, action, version and dates (06 §2.2a). Offers are data; only the person's own instructions move their agent.
- On the company's side: the person's text never enters the invoker's prompt, and the wake-up carries only an opaque local contact ID, never a name (§5.3). The agent reads the text through `agentlink_inbox` inside the untrusted block, with a token that reaches only that conversation.
- **What this does not protect.** Once the company's agent reads a person's message, that agent and every tool the company gave it (availability, CRM, its own checkout) can still be steered by the text: wrapping labels it, it does not stop a model from following it. The per-contact token only bounds what the agent can do **through AgentLink**. The company is responsible for its own agent's tools and data; the setup guide says so and recommends read-only tools for availability and a human check on anything else.

### 6.3 Owner presence on the person's side

Unchanged: accepting terms is a commitment that needs the owner (D-31, D-55, 04 §3.4.2). A person may allow auto-accept for a business contact within limits, as for any contact; the default stays "Ask me every time".

### 6.4 Company-side approval policy

- A new policy rule keyed by **business link** rather than contact ID (extends 06 §3 `commitments`, D-31), covering **every commitment** of 04 §3.4.2: an `accept` and its receipt, and a **firm offer** (`agentlink_propose_terms` or a counter with `notarize`). It applies only when:
  - the terms are sell-only: `payer: them` (the customer pays) and every deliverable is ours; mixed or buy terms always wait;
  - the amount is at least X and at most a **hard cap** Y, with hard caps per day (N commitments) and per contact (M commitments and an amount per contact per day), counted in the budget ledger (07 §3.5) so retries cannot exceed them;
  - the contact came through link L, and its domain-checked state is not paused (§4.2).
  Proof is always on for commitments made under this rule, so every one has a record. Setting or raising a limit is an owner policy change confirmed on the D-132 sheet (04 §2.5.3), and shows the existing 06 §3 sell warning. Everything outside the rule waits for the owner.
- One owner per agent in 0.5.x; several staff approvers need multi-owner support, which is later (as M2-UX-DEVICE-LINK).

### 6.5 SSRF for connector URLs

Webhook and A2A addresses are owner-entered but still follow 04 §4: https only, no private, loopback or link-local addresses, at most 2 re-checked redirects, size and time caps, checked at entry and on every call. Against DNS rebinding the call connects to the address that was checked, as the 04 §4 relay rule does, and in the Worker it also uses the platform's public-internet-only fetch setting where available; BIZ-SPEC fixes how both apply in Workers. Native invokers call only fixed vendor hosts from a built-in list. The person's client never fetches anything a business sends.

### 6.6 Abuse and spam

- Toward the company: the link limits of §4.1, per-contact rates, the raised but bounded requests queue, the pause switch, and the plan ceiling on contacts. 4thTech's relay and drop keep their own limits (ciphertext only).
- Toward the person: a business contact may answer only in a conversation the person started, within a window (decision 7); anything else is dropped silently on the person's side. No business can find a person: pairing always starts from the person.

### 6.7 Impersonation

- A business link without a valid domain claim is refused (decision 8). Names are always shown with the domain; lookalike and internationalised domains are shown in punycode too (04 §2.7, 11 §5.2).
- The directory's short address can only deny service (§4.1).
- The approval card shows the verified domain on every commitment, so a swapped contact cannot borrow a name at the moment that matters.

Threat rows for 04 §7 and the full threat note are written in BIZ-SPEC and reviewed by a Fable audit; this public proposal lists none beyond the design-level points above.

## 7. Pricing and packaging (companies pay, users free)

The template is open source (MIT), so a company can run it without paying us; what we sell is what 4thTech operates and supports.

| Option | What the company pays for | For | Against |
|---|---|---|---|
| **A. Business plan, monthly per business agent (recommended)** | Short business addresses and the business directory listing; raised relay and drop limits for the business; onboarding, the setup review and support; later an uptime commitment. Proofs at the standard $0.10 each | Simple; no metering of conversations; fits zero access | Value depends on the operated services being worth it |
| B. Proof fees only | Nothing beyond $0.10 per proof (and integrator fees, 12 §5) | Already built | Little revenue; no support relationship |
| C. Per conversation or per contact | Counted conversations | Scales with value | We cannot count without metadata we do not want (I-3 spirit, D-109); rejected |
| D. Managed hosting fee | We host the agent | Easiest for companies | Conflicts with I-1, I-3, D-37 (§6.1); rejected for now |

Illustrative tiers for the owner to set (placeholders, not proposed prices): **Pilot** free; **Starter** one business agent, one link and a directory listing; **Growth** several links, higher limits, priority support; **Enterprise** custom. Users never pay: the company records the proof and the person's receipt is covered (D-114).

**Charging rails.** D-47 keeps beta charging in crypto; companies expect invoices and cards. Recommend: the pilot is free, and the Business plan is billed once the card path (D-111) and the operating entity (D-15) exist; counsel's VAT view (M3-7) applies to business customers too. Raising drop limits for a business ties its drop key to a billing profile, which D-48 keeps unlinkable for persons; for a paying business this needs its consent and is recorded in the decision.

## 8. Spec impact

| Doc | Change (proposed; written by BIZ-SPEC after the decisions) |
|---|---|
| 00 | New decision **D-136** (number assigned at merge), text below |
| 02 | Users: Business; journey J10 (§3); new features for business links, business mode, invokers |
| 03 | Business mode components; invoker data flow; trust boundary with the company's AI vendor |
| 04 | §2.5.1 ops `link.create`, `link.revoke`, `invoker.authorize`, `invoker.revoke`; §2.7 `DomainClaim` struct fixed here, decoupled from the Registry; §3.6 invite `v: 2` business links and the safety-code rule for them; §4 connector URLs; §7 threat rows |
| 06 | §3 policy rule per business link and the "answer only in conversations the person started" rule; per-conversation token scope for `/mcp`; §5 server instructions for business mode; no new tool |
| 07 | §3 link and usage tables, link-contact counters, invoker queue; §3.2 business-mode limits |
| 08 | §3 business mode, §3.4 autonomy for business mode in 0.5.x, setup wizard and dashboard; §4 business link page and short address; §6 the directory in the hosting table |
| 10, `versioning.md` | 0.5.0 pilot switch and 0.5.x general availability |
| 11 §5 | "Business link", "Business" label, checkout-link line, the vendor note; no "official" or "verified company" |
| 12 | A Business plan section; who pays proofs for business agreements |
| backlog | The BIZ cards (§9) |

**D-136 text (accepted by the owner 2026-10-28; number assigned at merge):** *Business agents (Decision 20).* Companies connect the agents they already run to AgentLink through a business agent: the D-131 cloud agent in the company's own Cloudflare account, in business mode. People add it through a multi-use business link that requires a verified domain (04 §2.7), negotiate with typed terms, approve with owner presence, and get a proof the company pays for. The company's agent uses the AgentLink tools through the business agent's remote MCP server and is woken by an invoker (Claude, then OpenAI, A2A, or a signed webhook) with a fixed wake-up text that carries only an opaque local contact ID and a token scoped to one conversation; inbound content, including contact names, never enters its instructions. Invoker grants follow D-131 (m) (at most 30 days). Auto-agreed commitments (accepts and firm offers) are sell-only, hard-capped and always recorded with proof. A business contact whose domain check lapses is paused, never downgraded to self-declared. 4thTech hosts nothing that holds a key (D-37). No payments between agents; payment stays on the company's checkout. Companies pay a Business plan for operated services; users stay free. 0.5.0 carries it behind a pilot switch; general availability in 0.5.x.

## 9. Cards (proposed)

Classes per `audit-rules.md` §2 (path defaults: `packages/core`, `apps/cloud-agent`, `docs/foundation/04` are S2). Sizes S/M/L. "Fable" marks a Fable audit (keys, owner presence, money).

| Card | What | Class | Depends on | Size |
|---|---|---|---|---|
| **BIZ-0** | Spikes: which vendor APIs accept a remote MCP server per call (Claude, OpenAI), A2A support, one-DO throughput and store size at 10 000 contacts, alarm cost at shorter intervals | S0 (spike notes) | M2-3a, M2-3b | M |
| **BIZ-SPEC** | Spec text for §8 and D-136; threat rows; the Workers form of the DNS-rebinding rule and public-only fetch (§6.5); the public-suffix list source (§4.2); the checkout-host matching rules and their tests (§3.1) | S2 (04) | decisions §10, BIZ-0 | L |
| **BIZ-a** | Business link `v: 2`: codec, pairing at the inviter, limits, `link.create`/`link.revoke`, vectors | S2, Fable | BIZ-SPEC, M1-7c | L |
| **BIZ-b** | `DomainClaim` struct, sign on owner pages, client check at accept (DoH and SSRF-safe fetch), public-suffix refusal, badge rules and the pause on a lapsed claim; covers the core of M2-12 without the Registry | S2, Fable | BIZ-SPEC, M1-15 | L |
| **BIZ-c** | Business link page and short address on the invite host; directory store (public payloads only) | S1 | BIZ-a, BIZ-DESIGN | M |
| **BIZ-d** | Cloud agent business mode: tables, raised limits, link-contact counters, pause switch | S2 | M2-3a, BIZ-a | M |
| **BIZ-e** | Policy: per-link rule for accepts and firm offers (sell-only, hard caps, proof on, D-132 sheet for limits) and "answer only in person-started conversations" | S2, Fable | BIZ-SPEC | M |
| **BIZ-f** | Invoker framework: queue, retries, fixed wake-up text, per-conversation token, `invoker.authorize`/`revoke`, sealed vendor secret | S2, Fable | M2-3b, M2-3c, BIZ-d | L |
| **BIZ-g** | Claude invoker (pilot) | S2 | BIZ-f, BIZ-0 | M |
| **BIZ-h** | OpenAI invoker | S2 | BIZ-f, BIZ-0 | M |
| **BIZ-i** | Signed wake-up webhook and A2A invoker, with the 04 §4 URL rules | S2 | BIZ-f | M |
| **BIZ-DESIGN** | Design brief and screens for the setup wizard, dashboard and business link page (D-116: styled from approved screens) | S0 | decisions §10 | M |
| **BIZ-j** | Setup wizard on the Worker origin (§5.4), with the test conversation | S2, Fable | M2-3f-1, BIZ-b, BIZ-f, BIZ-DESIGN | L |
| **BIZ-k** | Business dashboard (extends `/status`, M2-3f-2) | S2 | M2-3f-2, BIZ-d, BIZ-DESIGN | M |
| **BIZ-l** | Person side: business badge and label, approval-card domain line, checkout-link host line, local app and CLI copy | S1 (S2 where `packages/core`) | BIZ-b, BIZ-e | M |
| **BIZ-m** | Business plan: quotas on relay and drop for a business key, directory entitlement; billing hook when D-111 lands | S2 (`apps/drop`), Fable | decision 5, 6 | M |
| **BIZ-DOCS** | Company guide "Connect your agent to AgentLink", person guide, README status | S0 | BIZ-j | S |
| **BIZ-AUDIT** | Independent Fable audit of the business slice | S2 | BIZ-a…BIZ-l, AUDIT-CLOUD | M |
| **BIZ-PILOT** | Pilot with one travel or booking company (below) | S0 | BIZ-AUDIT, M2-3d, M2-3e | M |

**Order.** BIZ-0 runs alongside the remaining cloud cards (M2-3b, M2-3c). After the decisions: BIZ-SPEC → BIZ-a, BIZ-b, BIZ-e in parallel → BIZ-d → BIZ-f → BIZ-g and BIZ-j → BIZ-c, BIZ-k, BIZ-l → BIZ-AUDIT → pilot. BIZ-h, BIZ-i and BIZ-m can follow in 0.5.x. Nothing here blocks the person-facing 0.5.0 cloud release; the business slice ships behind the pilot switch.

**Pilot plan (one travel or booking company, to be named by the owner).**
1. Week 0: agreement with the company (free pilot, their Claude agent with their availability data, one person to own the setup); the company deploys to its own Cloudflare account with our help on a call.
2. Week 1: domain verified, Claude invoker connected, rules set conservatively (every agreement waits for their approval), business link on a hidden page.
3. Weeks 2–3: 10–20 invited testers run the full journey (§3.1) with real availability and the company's real checkout; we record time to first answer, how many agreements reach checkout, approval delays, invoker errors and the AI cost per conversation.
4. Week 4: review with the company, adjust limits and copy, decide on the public link. Success: at least 80% of testers complete find → agreement → checkout without help; no I-5 or zero-access finding open in BIZ-AUDIT.

## 10. Owner decisions (recommended option first)

**Accepted by Tali in chat, 2026-10-28:** every recommended option (option 1) of decisions 1 to 10 and 12. Decision 11 stays open. Each decision below names the option chosen.

1. **Who hosts a business agent**: **accepted, option 1 (Tali, 2026-10-28)**
   1. The company, in its own Cloudflare account, with our template and wizard; 4thTech hosts no keys (recommended).
   2. 4thTech hosts it (needs an exception to I-1, I-3 and D-37; not recommended).
   3. The company now; a partner-hosted option reviewed later.
2. **Connector design**: **accepted, option 1 (Tali, 2026-10-28)**
   1. One tool surface (our remote MCP) plus invokers to wake the agent, with a 15-minute token per conversation (recommended).
   2. Remote MCP only (the company schedules polling).
   3. Webhooks carrying the message content.
3. **First invokers**: **accepted, option 1 (Tali, 2026-10-28)**
   1. Claude for the pilot, then OpenAI, then webhook and A2A (recommended).
   2. Claude and OpenAI together for the pilot.
   3. Webhook first (vendor-neutral, but code for the company).
4. **Release**: **accepted, option 1 (Tali, 2026-10-28)**
   1. 0.5.0 ships the business foundations behind a pilot switch; general availability in 0.5.x after the pilot (recommended).
   2. Everything in 0.5.0 before it ships (delays the person-facing cloud release).
   3. A separate 0.6.0.
5. **Pricing**: **accepted, option 1 (Tali, 2026-10-28)**
   1. A monthly Business plan for operated services and support; proofs at the standard fee paid by the company; users free (recommended).
   2. Proof fees only.
   3. Per-conversation metering (needs metadata we do not want).
6. **When billing starts**: **accepted, option 1 (Tali, 2026-10-28)**
   1. Pilot free; billing when the card path (D-111) and the entity (D-15) exist (recommended).
   2. Charge in stablecoins during beta (D-47).
7. **What a business may send to a person**: **accepted, option 1 (Tali, 2026-10-28)**
   1. Only answers within a conversation the person started, for 14 days after the person's last message (recommended).
   2. Anything, once the person added the contact.
   3. A per-contact switch, off by default.
8. **Verified domain for business links**: **accepted, option 1 (Tali, 2026-10-28)**
   1. Required: a link that fails the check is refused (recommended).
   2. Optional, with "Self-declared" shown.
9. **Answer speed in business mode**: **accepted, option 1 (Tali, 2026-10-28)**
   1. Keep 60-second sync for the pilot and measure (recommended).
   2. A shorter interval for business mode (higher Cloudflare cost for the company).
   3. An open relay connection during business hours (changes D-131 (f)).
10. **Autonomy**: **accepted, option 1 (Tali, 2026-10-28)**
    1. Allow invoker-driven answers in business mode only; person agents stay non-autonomous (amends 08 §3.4) (recommended).
    2. Keep autonomy off until after the pilot (the pilot then needs a human in the loop for every answer).
11. **Pilot company**: open, to be named by the owner (one travel or booking company).
12. **Invoker grant lifetime (conflict with D-131 (m))**: **accepted, option 1 (Tali, 2026-10-28)**
    1. At most 30 days, as D-131 (m) requires for every app; the owner re-signs monthly with one gesture, warned a week ahead (recommended).
    2. Up to one year for server-side invokers (amends D-131 (m) for invokers only; a stolen key or token stays useful longer).
