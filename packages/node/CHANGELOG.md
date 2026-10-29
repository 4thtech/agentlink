# @4thtech-io/node

## 0.4.4

### Patch Changes

- d29a65d: The local app opens on Home (U3-a, D-138): `agentlink ui` opens Home instead of Activity (`openHome()` replaces `openActivity()` on the approval server), and the end of first run, and of switching to Touch ID, offers **Go to Home**. First run still opens the first-run page while no owner exists.
- c338a75: U3-c: `agentlink ui` becomes the app host (D-138, 08 §1). It serves one agent at a time and switches to another of your agents in the same window, port and session (`POST /api/ui/agents/switch`, a new named route kind `switch` with no owner presence that signs nothing and writes only `~/.agentlink/app.json`). `GET /api/ui/agents` lists every agent on this computer, including ones made by older versions, with its label, contact count, whether an AI app is running it and whether its removal is unfinished. Every answer carries a generation number and the open agent's label; every change the page sends carries the generation and is refused with `agent_changed` when another agent was opened meanwhile, so the page reloads for the agent that is open. Every process that opens an agent now holds a shared lock on its folder. The other U3 routes are registered as stubs answering `not_available` until their cards land.
- 5981942: U3-d-b: an agent created in the app (first run or Add an agent) now signs its card with the name the owner typed, so contacts and invites show that name instead of the folder name (`default`). With no name typed, first run uses "My agent". Renaming later stays local and does not change what contacts see (06 §6).
- c3e523c: U3-d: create an agent and rename one from the local app, and name your agent at first run (D-138, 08 §1, 04 §2.5.1, §2.8). New local owner actions `agent.label`, `app.connect` and `app.disconnect` (schemas; `params.agent` must be the body's `agent`, 600 s, never in an envelope). Core applies `agent.label` (label in its own restricted form, else `label_invalid`), stores it sealed with its nonce row in the new `local_owner_actions` table (store schema 7, a forward migration) and re-verifies it on every load. `POST /api/ui/agents {label}` creates a keychain agent in a folder named from the label and signs its first card, first policy and first label with one Touch ID, all or nothing; `POST /api/ui/agents/label {name, label}` renames the open agent with Touch ID; `GET /api/ui/agents/label-check` checks a label first. First run `begin`/`finish` also take `{label}` and never write an AI app config. The open agent is now named by its verified label (or its folder name), never by the unsigned label in config.json.
- 6d5b6aa: U3-e: remove an agent from the app (D-138, 08 §1, 04 §2.5). `POST /api/ui/agents/remove {name, typedLabel, anyway?}` is a new named route kind `remove`: it is refused with `in_use` while any process has the agent open (the shared folder lock), checks the typed label, and with one owner gesture always signs `agent.revoke {reason: "retired"}` for the agent, records it in the owner's revoked list (`~/.agentlink/revoked/<agentId>.json`, re-verified as the signed object), marks the agent `removing`, tells its contacts with owner-signed `revoke` envelopes (bounded wait; `undeliverable` asks before going on), erases its keys through the new KeyStore erase API (`KeyEraseControl` in `@4thtech-io/crypto`, keychain and file backends in `@4thtech-io/node`; never an owner item) and deletes its folder, inside the exclusive folder lock. `backup restore` refuses an agent that is in the revoked list.
- 0af8fb0: U3-f: connect, move and disconnect AI apps from the local app (D-138; 08 §1, 04 §2.5, §2.5.1, 06 §7). `GET /api/ui/apps` lists the detected AI apps and the agent each one runs (entry-only; also on the first-run page, before an owner exists) and whether Claude Desktop runs; `GET /api/ui/apps/preview?app=&agent=` shows the exact `agentlink` entry change and its `changeId`; `POST /api/ui/apps/apply` and `/disconnect {changeId}` sign `app.connect` / `app.disconnect` with Touch ID, recompute the change after the gesture (refused with `changed` on any difference, the file's device and inode included), and only then write. Core prepares and applies both ops (stored with their nonce row, one record per app). The CLI passes its harness code in as the one writer (`LocalUiOptions.aiApps`): fixed paths and fixed content only, realpath and no links, atomic write with a backup that keeps the original file mode, Claude Desktop never written while it runs, and the agent folder the entry runs must record the signed agentId. `GET /api/ui/agents` now fills `apps`.
- 0a54944: U3-flow: `GET /api/ui/flow?since=<cursor>` answers the live connections map's metadata for the open agent (`{now, cursor, items: [{contactId, direction, kind, state, at}], partial}`), through a new read-only core view `MessagesView.flowEvents`. Never content, names, links, keys, hashes or envelope IDs; at most 200 items and 20 000 bytes; no byte progress (the store records none).
- 2eb812b: U3-g-b: `agentlink ui` with no agent at all opens the app on Welcome instead of stopping at "isn't set up here yet" (08 §1). The app host can start with no agent open (`AppHostOptions.initial` is optional, `firstRun` new): it then serves only the first-run page and the setup-time reads, and refuses every other route and the approval API with `409 no_agent`. First run's `begin`/`finish {label}` create the first agent (folder `default`, as `init` names it, with the label you typed) and the owner with one gesture, all or nothing, and open that agent in the same window without a restart. Run by an AI, `ui` still prints its fixed line and opens nothing. The successful first-run `finish` answer is marked `X-AgentLink-Generation-Adopted: 1`; the page's generation guard adopts the new generation on that answer only (no reload, so the backup code stays on screen). `GET /api/ui/first-run` answers the real owner state while no agent is open.
- e84e187: U3-g-c: Welcome's "Pick your AI app" lists the AI apps on a computer with no agent yet. The no-agent app host now gets the CLI's AI apps reader (the U3-f harness desk), list only (`AppHostOptions.aiAppsList`), so `GET /api/ui/apps` answers with the detected apps, entry-only, before the first agent exists. Preview, apply and disconnect still answer `409 no_agent` until first run's `finish` opens the first agent; that agent's own full desk then answers every AI apps route.
- 5901726: The local app keeps the open agent up to date when no AI app is running (U3-invite-b, Decision 37; 06 §6, 08 §4): while the app is open and no other process holds the agent's publisher lease, it takes the lease for one short pass (fetch, process, deliver due rows) and releases it. Passes run every 5 s while a pairing is pending on either side (the join screen, sent invites, Contacts-page accepts) and every 15 s otherwise while a page is visible, so pairings finish and messages arrive. An AI app's AgentLink server holding the lease always wins. New in core: `pairing.waiting()`.
- 276b400: Join from an invite link (U3-invite, 08 §4, 06 §8, b11 §33): `agentlink join '<invite link>'` checks the invite on this computer and opens the AgentLink app with it waiting; after setup (or at once when AgentLink is already set up) the app asks "Accept {name}'s invite?" and accepts only with Touch ID (or the backup code). When the app is already open, `join` hands the invite to it with one local request. A bad or incomplete link gets one fixed line and exit code 2, and the link is never printed, logged or saved.
- b2f3aa0: U3-map: the Agents page has a Map view, "Live connections". Your agents are boxes with their AI app, the open agent's contacts sit on the right in a fixed two-column layout sorted by activity, and a line shows who exchanged something in the last 24 hours. A short dash travels the line while a message or file is moving, and the row says "Sending" or "Receiving". Names and words only: no message content and no hover preview. Clicking a box or line opens that conversation in Messages.
- Updated dependencies [c3e523c]
- Updated dependencies [6d5b6aa]
- Updated dependencies [0af8fb0]
- Updated dependencies [0a54944]
- Updated dependencies [5901726]
- Updated dependencies [276b400]
  - @4thtech-io/core@0.4.4
  - @4thtech-io/crypto@0.4.4
  - @4thtech-io/transport-nostr@0.4.4

## 0.4.3

### Patch Changes

- 64d9338: UX2-d1: the local app's API can create an invite (`POST /api/ui/invites`) and check a pasted one (`POST /api/ui/invites/check`) with no owner presence, as a new named route kind `invite` (owner decision 1.1; session, CSRF, Origin and fetch-metadata gate; create limited to 10 per 10 minutes), and accept one (`POST /api/ui/invites/accept`) behind owner presence, which signs the `contacts.acceptInvites` approval before core pairs. The accept approval action, its summary and the invite share text move to core, so the MCP tool, the CLI and the app build the same action and text; `@4thtech-io/mcp-tools/accept-action.js` re-exports them. One core summary, `acceptInviteSummary` (name, label and short owner fingerprint, 04 §3.6 Accept step 2), is used by the MCP tool, `agentlink accept` and the app, and check refuses any invite the accept input cannot carry.
- 29660b0: The local app's server can now show how active each contact has been (UX2-f1): one read-only route, `GET /api/ui/messages/pulse`, for the owner's browser session only. Per contact it returns message counts in twelve two-hour buckets over the last 24 hours, the last exchange time and an activity word (Active now, Today or Quiet). Counts and times only: never message text, a subject, a file name or size. At most 1 000 contacts per answer, and core's new `messages.pulseTimes` reads only contact IDs and times in one bounded store read. Nothing is written and no AI tool changes.
- Updated dependencies [64d9338]
- Updated dependencies [29660b0]
  - @4thtech-io/core@0.4.3
  - @4thtech-io/crypto@0.4.3
  - @4thtech-io/transport-nostr@0.4.3

## 0.4.2

### Patch Changes

- @4thtech-io/core@0.4.2
  - @4thtech-io/crypto@0.4.2
  - @4thtech-io/transport-nostr@0.4.2

## 0.4.1

### Patch Changes

- 5ee314c: M1-11b-2: with the local app bundled, the approval server serves the app for `/` and `/approve/<id>` too, so Approvals and one request render inside the app (its sidebar, status bar and paid-action sheet). The session, CSRF, Origin, fetch-metadata and presence checks and the approval decision logic are unchanged; without the bundle the server-rendered approval page stays.
- 68e25ae: M1-11b-2c: the server-rendered approval page is removed. `/app.js` and `/app.css` are gone (404); Approvals live only in the local app, which the approval server serves on `/` and `/approve/<id>`. A server without the app bundle answers those two with a fixed page (503, no script, no CSRF token) that points to `approve` in the owner's own terminal. The session, CSRF, Origin, fetch-metadata and presence checks and the approval decision logic are unchanged. `@4thtech-io/ui`: a comment in the confirmation sheet no longer points to the removed page.
- 276951a: UI-REFRESH-f: the app shell. A top bar (page title; the Under the hood switch, a live status chip and the theme control), the sidebar, top bar, status bar and Settings sub-navigation on the chrome material on a Mac only (`data-os` is set at start-up; Windows, Linux and reduced transparency stay solid), one sliding nav highlight, a bottom bar at 360 px, route changes through the View Transitions API (instant with reduced motion or where missing), Home (at `/settings/home` for now) and Appearance in the menu and router, and an inert background behind every Sheet and dialog. The chrome material opacity is raised from 72 % to 85 % so the chrome text meets WCAG 2.1 AA over the worst content under it. The old approval page copies the new Home entry in its fixed sidebar list.
- @4thtech-io/core@0.4.1
  - @4thtech-io/crypto@0.4.1
  - @4thtech-io/transport-nostr@0.4.1

## 0.4.0

### Minor Changes

- 7bab3f5: M1-11s-a-d: the local app's health read, `GET /api/ui/health`, answering a fixed shape (agent running, paused, not running or needs setup; relay counts; last sync time; app version), cached for 3 s and bounded, behind the owner's browser session. The app's status bar polls it (with backoff, paused while hidden) and shows Connected, Paused, Not running or Needs setup in a polite live region, instead of "Checking…" forever. `AppShell` gains the `not-running` and `needs-setup` states.
- 662785b: M1-PAY-CONFIRM-a: confirming paid actions with the computer's own verification (04 §2.5.3, D-132). Core builds the confirmation statement and the challenge from stored data (`buildPayConfirmFlow`, `payConfirmChallenge`, `spendingChanges`) and refuses a paid item in `approval.decideBatch` (`paid_item_in_batch`). The local approval server adds `POST /api/ui/pay-confirm/begin` and `/finish`: user verification required, single use, bound to the page session, 120 s; the passkey's own signature is verified with the credential key kept at registration (crypto `verifyWebauthnSignature`, ES256 and EdDSA); the backup code keeps the three-tries rule. Approving a paid proof or changing a spending limit through an ordinary owner route now answers `confirm_required`; `agentlink approve` with no ID lists a paid request but sends it to `approve <id>` on its own.
- 08f35cb: M1-PAY-CONFIRM-b: the confirmation sheet for paid actions (b11 §19, §20; 04 §2.5.3; D-132). The approval page opens it for a request that costs credits (its card has its own Approve; it is never a list item), and the app's Rules page for a change to a spending limit: one modal sheet with the amount and what it is for, built only from the statement the server returned, the platform's check ("Confirm with Touch ID", "Windows Hello", "your passkey"), the backup code as a small link, every state with a reduced-motion version, and an automatic close about 1.2 s after Done. `POST /api/ui/pay-confirm/begin` takes `remember: true` for "Remember for this contact" (both bodies in one challenge; `rememberOffered` says when core offers it; `not_offered` otherwise). Approval views carry `paid`. A passkey whose PRF works only on use now sends the `create()` authenticator data with its registration, so its credential key is kept for paid actions (#581 audit).
- be3d7dd: MSG-FILES-IO-c: the local app's Messages reads, `GET /api/ui/messages` (conversations) and `GET /api/ui/messages/:contactId?box=in|out&limit=&cursor=` (one contact's Inbox or Sent). Read-only, behind the owner's browser session; allowlisted fields only, fixed error codes, never a read mark for the AI.
- a6846b5: MSG-FILES-IO-h: Show in Finder for a saved received file in the local app ("Show in folder" on Windows and Linux), with no Touch ID (D-134). The page sends only the item's ID; the local server reads the saved name from the store (core `filesIo.savedName`), opens the file once inside the Inbox folder without following a link, checks it, and asks the OS file manager to show it (no shell). New route kind `presence: 'reveal'` for `POST /api/ui/files/received/reveal` only. The Received and Sent tabs now read the real file lists: other people's file names sit in the untrusted-content box, a malformed item is skipped instead of hiding the list, and a file that was not delivered says so.

### Patch Changes

- 867a9f6: Show in Finder on Windows: a dangling link with the saved name is refused rather than reported missing, and Explorer gets the file path as one quoted argument so names with commas select the right file (CHORE-MAIN-NODEOS-040).
- 75407d8: The approvals page now shows the same sidebar as the other pages of the local app (Approvals, Activity, Contacts, Files, Proofs & credits, Rules, Settings), so the owner can get back from Approvals. Navigation only: how approvals are confirmed is unchanged.
- 5dfda6f: Owners who set up AgentLink before 0.3.0 can now switch to Touch ID (or Windows Hello, or a passkey) in the local app (M1-UX-FIRSTRUN-V2-c): every page shows "Switch to Touch ID" until it is done; the switch asks for the backup code once, then one touch. The owner stays the same and the backup code keeps working.
- d157039: M1-UX3-DUP-CONTACTS: the local app's contact list (`GET /api/ui/contacts`) marks a newer active contact that has the same owner as an older active one with `olderSameOwner` (the older contact's ID, which the list already shows; the owner fingerprint itself never leaves). The Contacts page uses it to suggest removing the older connection; removal is the existing owner-confirmed Remove.
- f4d0c03: When your AI fetches a received file, the local store now remembers the name it was saved under in your Inbox folder, encrypted like the file's other details (MSG-FILES-IO-b), so the local app can show which received files are saved. Store schema version 6 adds `files.saved_name`; the SQLite store migrates automatically and existing files read "not saved yet". Migrations are forward-only: once a store is at version 6, an older AgentLink refuses to open it (`store_schema_newer` / `store_too_new`), so you cannot roll the package back after upgrading.
- c5425de: The local app's server can now list the files you received and sent (MSG-FILES-IO-d): two read-only routes, `GET /api/ui/files/received` and `GET /api/ui/files/sent`, for the owner's browser session only. Each item shows who, when, the file name, size and state; a received file you saved shows only the single name it was saved under. No file key, link, storage location, hash or folder path is ever returned, nothing is written, and no AI tool changes. Core's `client.filesIo` now reads that saved name; a saved name that cannot be read shows that one file without it instead of hiding the list.
- d5464ed: MSG-FILES-IO-e: the sidebar on the approval page lists Messages between Activity and Contacts, like the local app.
- 59d3801: PRE-031-FIXES: the paid approval card says "This costs credits. Approve it on its own." without an amount of its own, so it can never differ from the signed amount the confirmation sheet shows; a passkey registration body with bytes after its optional fifth field (the creation authenticator data) is refused explicitly (`presence_required`).
- Updated dependencies [662785b]
- Updated dependencies [64dab44]
- Updated dependencies [f4d0c03]
- Updated dependencies [c5425de]
- Updated dependencies [a6846b5]
  - @4thtech-io/crypto@0.4.0
  - @4thtech-io/core@0.4.0
  - @4thtech-io/transport-nostr@0.4.0

## 0.3.0

### Minor Changes

- 807bb98: The local web app's Contacts page (M1-11c-a2): three read routes (`GET /api/ui/contacts`, `GET /api/ui/contacts/:ref/safety-code`, `GET /api/ui/contacts/:ref/rename-check`) and three owner routes behind the central presence gate (`POST /api/ui/contacts/:ref/check`, `…/rename`, `…/remove`), plus the page itself. The owner routes build the unsigned `contact.check`, `contact.rename` and `contact.remove` with core's prepare helpers, sign them once with the presence the request carried and apply them through core; "They match" signs only when the code recomputed now is the code the page showed. The read-only client view that handlers get now also has `contacts` (the list, the safety code and the three prepare helpers). No key, card, raw name, pairing digest or error text leaves the server for this page. The page routes share fixed answers: 409 `not_set_up`, 400 `invalid_query`, 503 `unavailable`.
- 297f10b: The local web app's Files page (M1-11c-a3): `GET /api/ui/files` (the folders your AI can send files from, with their real locations), `GET /api/ui/files/review` (checks a folder to allow or remove against the 04 §4 rules, follows links to the real folder, and prepares the change without signing it) and `POST /api/ui/files/folders` (behind the owner presence gate: signs exactly the reviewed change). D-119: the server signs only when every warning returned for that exact change is acknowledged; the acknowledgement is bound to the change's hash and each review is used once. The read-only client view that handlers get now also has `files.resolvedFolders` and `files.preparePolicyEdit` (both write nothing). The page routes share fixed answers: 409 `not_set_up`, 400 `invalid_query`, 503 `unavailable`.
- 639f174: The local web app's Proofs and credits page (M1-11c-a4): two read routes, `GET /api/ui/proofs` (your proofs, newest first, paged) and `GET /api/ui/proofs/credits` (proofs left and the dollar balance), and the page itself. The read-only client view that handlers get now also has `proofs.list` and `proofs.creditsBalance`. No network, token, address or ID leaves the server for this page; Add credits stays hidden until the pay page is live. Core exports `PROOF_PRICE_USD_MICROS`, the price of one proof from the chain package's fee schedule, and the credits route returns it formatted. The page routes share fixed answers: 409 `not_set_up`, 400 `invalid_query`, 503 `unavailable`.
- b3b8782: Add credits by QR on the Gnosis test network, and Withdraw credits, in the local UI (M1-11c-a4c, D-122, D-123). New owner actions `credits.deposit` and `credits.withdraw` (strict params, 600 s lifetime). Core adds a read of where funds can be sent (`proofs.receiveOptions()`), `proofs.addReceivedFunds(signed)` and `proofs.withdrawCredits(signed)`: the agent's own `deposit` or `withdraw` in direct mode, signed by its KeyStore, only after a fresh owner-signed action, keeping a 0.01 xDAI gas reserve, Chiado only, never a mainnet; a withdrawal goes to the agent's own account only. The local UI server adds `GET /api/ui/proofs/top-up` and the presence-gated `POST /api/ui/proofs/top-up` and `POST /api/ui/proofs/withdraw`. The CLI wires direct mode per testnet.
- cc47e3c: The local web app's Rules page (M1-11c-a5): `GET /api/ui/rules` (the rules in force as the page shows them: values and counts, no agent IDs, folder paths or proof network), `GET /api/ui/rules/review?edit=` (core's `preparePolicyEdit` for an edit of the page's own fields; answers the prepared body's SHA-256 and its warning codes) and `POST /api/ui/rules` behind the central presence gate. D-119: the server signs only a body it prepared, named by its hash, once and before it expires, and only when the owner acknowledged exactly that body's warning codes; otherwise it signs nothing and the gate answers 409 `refused`. The read-only client view that handlers get now also has `policy.load`, `policy.prepareEdit` and `policy.recordReceiptsKept`.

### Patch Changes

- b96582e: `agentlink init` opens the local app's first-run page for a new owner (M1-11b-6, D-120): in your own terminal, the browser opens the setup page with a one-time link, you protect approvals with a passkey, and the settings pages work while the window stays open (at most 30 minutes). Run by an AI, `init` never opens or prints the link; it tells you to run `init` yourself, named the way AgentLink was started. The setup page is offered only while no owner exists anywhere on this computer: no owner key, no passphrase-file owner, and no other agent (including one restored from a recovery kit before its owner). The CLI build now always includes the local app.
- 03bb125: New `agentlink ui` command (M1-11b-9, 08 §1): in your own terminal it opens your AgentLink activity page in the browser with a one-time link (or the setup page while no owner exists), and stops on Ctrl+C or after 30 minutes. Run by an AI, it only tells you to run it yourself, named the way AgentLink was started. No MCP tool opens the page.
- 859f81e: New `agentlink policy allow-send-folder` (run it yourself): sets up the empty `AgentLink/Send` folder in your home folder and allows your AI to send files from it, for an agent set up before AgentLink did this on its own. Only that folder is added to your rules. `policy allow-folder` with a differently spelled path now offers the exact path instead of refusing (M1-36b-2-c).
- 909cbc9: An allowed folder now stays where you allowed it: if it (or a folder above it) is later replaced by a link, it is no longer used for sending until you allow it again. `policy allow-send-folder` checks the Send folder again after you type your owner code, and recognises `~/AgentLink/Send` in your rules as already allowed (M1-36b-2-d).
- c109936: First run, `owner init` and `owner add-agent`: the first rule applies only to the Send folder that was checked, re-checked before and after the owner approves; a setup started right after an earlier one ended keeps its folders (M1-UX-FIRSTRUN-V2-b).
- 76d69a1: First run v2 (M1-UX-FIRSTRUN-V2): one Touch ID (or Windows Hello, or a passkey) on the setup page now protects approvals, sets up this agent and lets your AI send files you put in `~/AgentLink/Send`. The page shows the folders first, then "Your backup code" once with "Save in my password manager" and "I saved it". A Send folder that is a link, a file or already holds files is refused before you touch the sensor.
- f1cff39: M2-3a: the SQLite DDL of the logical store schema moved unchanged from `@4thtech-io/node` (`sqlite-schema.ts`) to `@4thtech-io/core` (`store/sql-schema.ts`, exported as `createSqlSchemaStatements` and its helpers), so the cloud agent's Durable Object store runs exactly the Node store's statements. The Node store re-exports them under their earlier names; its pinned statement digests are unchanged. No behaviour change.
- Updated dependencies [639f174]
- Updated dependencies [b3b8782]
- Updated dependencies [f1cff39]
  - @4thtech-io/core@0.3.0
  - @4thtech-io/transport-nostr@0.3.0
  - @4thtech-io/crypto@0.3.0

## 0.2.0

### Minor Changes

- 66d6279: The local web app's Activity page (M1-11c-a1): `GET /api/ui/activity` returns one page of the activity feed (approvals decided, including those approved by your rules, proofs, blocked senders and contacts, rules updated) through the read-only client view, with only the display fields each kind needs, and the page shows it newest first with "Show more", an empty state and clear loading and error states.
- 342d345: The local approval server can serve the local web app (D-118): an in-memory bundle of its built files under `/assets/`, its page at `/first-run` and `/settings`, and a `/api/ui/` route registry in which every change needs owner presence, checked centrally before the route runs. `/` and `/approve/<id>` keep the approval page. The CLI embeds the app's build when present.
- 76ad5c5: The local approval server can set up the owner from the first-run page (M1-11s-c, D-120 (1)): two setup routes, behind their own setup gate and only while no owner exists anywhere, create the owner key with one passkey gesture, a backup owner code shown once, and the agent's first card, all or nothing. The owner seed is held in memory for at most two minutes between the two steps, for one session, and wiped after. When an owner is set up from the page, the CLI logs a fixed line with the owner fingerprint to compare with `agentlink doctor`.
- eacf0bc: `agentlink owner init` and `agentlink owner add-agent` now also allow an empty `AgentLink/Send` folder in your home folder for sending files, in the same owner code entry as the agent's card. Nothing else changes in your rules.
- 8095c0c: M1-8f (D-54, 04 §2.8): the passphrase-locked file KeyStore for headless machines, opt-in only. `createFileKeyStoreAgent` creates an agent in `~/.agentlink/keystore/<agentId>.alks` only when the OS keychain probe fails, from an interactive terminal with no AI-app marker set, with a generated unlock code by default. `unlockFileKeyStoreAgent` reads the unlock secret from `AGENTLINK_KEYSTORE_PASSPHRASE_FILE`, then `AGENTLINK_KEYSTORE_PASSPHRASE` (both removed from the environment), then an optional prompt, and keeps only the derived key in memory. `changeFileKeyStorePassphrase` re-wraps the file under a new secret. `openAgentKeyStore` and `openAgentStore` take the unlocked handle as `fileAgent` for the recorded backend `file`. The policy-version mark and the receipts-kept marker are `ALKS` entries written with the 04 §2.8 write protocol. Nothing changes for keychain agents.

### Patch Changes

- 55d5b9d: The local app's first-run page (M1-11b-1, D-120): protect approvals with one passkey, see your owner fingerprint and a backup owner code (collapsed), put the recovery kit off with "Later", and go back to your AI with a prompt to copy. A new read route, `GET /api/ui/first-run`, says only whether approvals are protected yet. The shared page states (link expired, AgentLink not running, setup unfinished, recovery kit reminder, network, empty, loading and error) follow the d1 design. The page is included but not yet opened or connected by the CLI, so it is usable from the next release (M1-11b-6).
- 458c32c: Owner setup on the first-run page refuses, before anything is read or written, a held seed that is not the owner the page was shown (M1-11s-c-b). Tests: the setup canary now covers the seed and the PRF output in every encoding, using a canary seed that is never a real seed.
- 0e5fef3: Delete after receipt now applies only to files sent while it was on: turning it on later never deletes files sent earlier, and files sent before this update are kept until they expire (M1-1g-i).
- 52c8fe8: M1-33a (D-109): delivery receipts are off by default. `@4thtech-io/types`: the 06 §3 default `receipts.autoDelivered` is `false`; a `ContactRule` may carry `receipts: {autoDelivered}` (strict) with or without `proofs`, and needs at least one of the two. `@4thtech-io/core`: an automatic DELIVERED receipt uses the record signer's contact rule when that contact is paired and not blocked or revoked, else the global value; under failing rules none is signed. OPENED, ACCEPTED and REJECTED are unchanged. `@4thtech-io/core` also adds `receiptsOnFromOlderDefault` and `recordReceiptsKept` on `OwnerActions` and the `receiptsKept` client option (a `ReceiptsKeptMark`). `@4thtech-io/node`: the receipts-kept marker as the keychain item `<agentId>:receipts-kept`, on `AgentStore.receiptsKept`. `@4thtech-io/agentlink`: the rules review lists a contact's delivery-receipt rule; a policy signed earlier keeps its value until the owner next signs their rules, which then asks "Keep delivery receipts on?" and turns them off unless the owner types y (a yes is remembered); until then `agentlink doctor` shows the older-default line.
- 76b7e47: M1-36a-b: every "run this" line in `init`, `doctor`, the owner commands, the not-set-up message, the approval page and the owner setup steps now starts with a command that works on your computer: `agentlink` only after a global install, otherwise `npx -y @4thtech-io/agentlink`. The approval page no longer points to `agentlink ui`, which does not exist; it names `approve` instead. When your AI checks AgentLink on a computer that has no owner yet, it now tells you to run `owner init` instead of `owner add-agent`.
- 40e73bb: M1-36e: the last "run this" lines that still started with the bare `agentlink` (`doctor`, `policy`, `requests`, `credits`, `contacts`, the not-set-up and error messages, the tool hints for your AI, and the key, keychain, add-agent and change-code messages) now start with a command that works on your computer: `agentlink` only after a global install, otherwise `npx -y @4thtech-io/agentlink`. `doctor` and `status` say "message network" instead of "relays". A vocabulary check now keeps terminal text, tool hints, the approval page and the user guide free of technical words such as wallet, gas, transaction and chain.
- 3a3837b: `KeyStore.signTransaction` signs one direct-mode transaction with the agent's EVM key, on the launch testnets only: EIP-1559, to the AgentLink Notary, fee vault or an offered fee token, with a direct-mode call (`notarizeDirect`, `notarizeBatch`, `acknowledge`, `acknowledgeBatch`, `deposit`, `withdraw` to the agent's own address, `approve` of the vault), bounded value, calldata, gas and fees. Everything else is refused with `transaction_refused` before any key is read. The keychain KeyStore implements it. `@4thtech-io/chain` adds `keyStoreDirectSigner`, `createDirectMode` (testnets of the KeyStore allowlist only), the typed `buildWithdraw` and `sendWithdraw`, and the ChainError code `signing_refused`.
- f8c4440: The SQLite agent store opens with `secure_delete = ON` (M1-7f-2; 04 §4 crypto-shredding), so deleted rows, sealed file keys among them, are zeroed on disk. `SqliteStore.readSetting` also reads `secure_delete`.
- 1d10f83: Owner-signed own storage and recovery-kit export (M1-9i-a, D-115). `@4thtech-io/types` adds the `storage.set`, `storage.remove` and `backup.export` owner actions with strict params (L(op) = 600 s), `STORAGE_PROVIDERS`, `BACKUP_KIT_CONTENTS` and `isCanonicalS3Endpoint`. `@4thtech-io/core` applies them (nonce row and the one `own_storage` row in one transaction, then the KeyStore `storage-mark`), adds `ownStorage.load()` (`none`, `ready` or `broken`, re-verified on every load, never by expiry), the `OwnStorageKeys` interface and the `storage-mark` codec, and the `brokenOwnStorageAdapter` stub: a broken own storage makes a stored file send `needs_setup` `storage_broken`, never the drop. Store schema version 5 adds `own_storage`; `@4thtech-io/node` migrates SQLite stores to it.
- 25d121c: Groundwork for backup and restore, with no user commands yet (M1-9i-c): the keychain and file backends implement the recovery-kit export and import controls and the storage credential control, with the restore quarantine and its snapshot checks, the own-storage items on the agent store, and a refusal of a nested inter-process lock in the same flow. Not reachable from the package entry yet; the CLI owner commands wire them (M1-9i).
- Updated dependencies [b5c51e6]
- Updated dependencies [27437fc]
- Updated dependencies [be16e36]
- Updated dependencies [8928493]
- Updated dependencies [cf800d0]
- Updated dependencies [0e5fef3]
- Updated dependencies [cb4a63a]
- Updated dependencies [52c8fe8]
- Updated dependencies [bc8d9f3]
- Updated dependencies [16f692e]
- Updated dependencies [70e362b]
- Updated dependencies [320bc9e]
- Updated dependencies [19c8626]
- Updated dependencies [3a3837b]
- Updated dependencies [068d989]
- Updated dependencies [068d989]
- Updated dependencies [ec598ee]
- Updated dependencies [d311d76]
- Updated dependencies [ca60f25]
- Updated dependencies [f8c4440]
- Updated dependencies [0f13f71]
- Updated dependencies [8621ff4]
- Updated dependencies [4be1e27]
- Updated dependencies [e7ac634]
- Updated dependencies [31957b7]
- Updated dependencies [3a08533]
- Updated dependencies [6055f38]
- Updated dependencies [1d10f83]
- Updated dependencies [0ece43e]
- Updated dependencies [c6aa21f]
- Updated dependencies [821ac87]
- Updated dependencies [8565521]
- Updated dependencies [529a0f6]
- Updated dependencies [9dbaa44]
- Updated dependencies [c6546b9]
  - @4thtech-io/core@0.2.0
  - @4thtech-io/crypto@0.2.0
  - @4thtech-io/transport-nostr@0.2.0

## 0.1.2

### Patch Changes

- dd9650b: M1-1g-e: `KeyStore.signDropRequest(request, createdAt)` signs one encrypted-drop request with the agent's separate drop key at the current epoch and returns the `Authorization` header (07 §5.4). It is the `DropSigner` the drop adapter takes. The KeyStore fixes the event kind (27235) and the `domain` tag, signs only POST and DELETE to an https URL in serialised form over the drop's signed JSON body with `createdAt` equal to its `ts`, and refuses anything else with one fixed error before reading any key. Implemented by `MemoryKeyStore` and the keychain KeyStore (and its facade). `dropRequestSnapshot` and `DROP_REQUEST_REFUSED` are in the main entry; the raw-key `signDropRequest` is in the restricted `@4thtech-io/crypto/keystore` entry.
- 4d7d3e4: M1-1g-f: `KeyStore.signDropRequest(request, createdAt, options?)` takes an optional `{epoch}` for a DELETE, so an object uploaded under an older key epoch stays deletable after a rotation (04 §2.1). It is accepted only with DELETE and never above the current epoch (`epoch_unavailable`); a POST with an epoch or a malformed epoch gets the same fixed refusal, and every check runs before a key is read. Implemented by `MemoryKeyStore` and the keychain KeyStore (and its facade). `dropRequestEpoch` joins `dropRequestSnapshot` in the main entry.
- bc3bfe4: M1-4a: the chain client foundation. A supported-chain registry composed from the shipped network entries and the pinned `@4thtech-io/occ-v2-abi` release (Base Sepolia today), automatic testnet-only chain selection, an RPC URL rule (04 §4: https, public host name, no key), a read-only viem client per chain with a fallback transport, timeouts and retries, calls encoded only from the client-safe ABIs, `Record`, `Receipt` and `AgentCard` builders with EIP-712 vector parity and signing through `KeyStore.sign712`, a fresh CSPRNG salt and nonce for every Record, and the Notary's record ID derivation. Read-client errors are fixed-code `ChainError`s with no RPC URL. `@4thtech-io/node` adds `nodeRpcFetch`, the RPC fetch that refuses private and loopback addresses at resolve time and pins the checked address per request (04 §4).
- 5a9ee7d: M1-4b: fee quotes in USD (`quoteFee`: the vault's `quote` with the protocol and integrator parts, 1:1 for the stablecoin fee tokens, fail-closed when the parts do not add up), credits per chain and across chains (`readCredits`, `readCreditsAcrossChains`), the direct-mode deposit helper (`buildDeposit`: exact-amount approve, then deposit; sends nothing) and the credit event filter (`filterCreditEvents`, `readCreditHistory`: canonical vault only, zero-amount events ignored). Only offered allowlisted fee tokens are priced, shown or deposited. The read client is now a frozen view of the viem client: `extend` stays wrapped, namespaced actions and `onError` callbacks get URL-free `ChainError`s, and the transport exposes no RPC URL. `createReadClient` accepts only the address-checked fetch; `@4thtech-io/node` `nodeRpcFetch` carries that brand.
- 2e6b70e: M1-4d-d-b: the agent card's proof of possession (04 §2.9, D-102). `TAGS.cardPop` (`agentlink/card-pop/v1`), `verifyCardPop`, `verifyCardPossession` and `cardPopSnapshot` are in the crypto main entry; the raw-key `signCardPop` is in the restricted `@4thtech-io/crypto/keystore` entry. `KeyStore.signCardPop(card)` signs only the store's own card at its current key epoch and refuses anything else with one fixed error; implemented by `MemoryKeyStore` and the keychain KeyStore (and its facade). The `handshake` and `handshake-ack` bodies take an optional `cardPop`, and `card-update` optional `cardAgentSig` and `cardPop`, together or not at all. The core makes `cardPop` with every own card (init, so also `owner add-agent`, and rotation once the KeyStore is at the new epoch; a card stored before this change gets one on first use), sends it in `handshake` and `handshake-ack`, verifies a received pair in `handshake`, `handshake-ack` and `card-update` (a present signature that does not verify drops the whole body), and stores a contact's verified pair. `proofSigner(from)` returns the signer block with the pair for the upcoming `exportProofPack` (M1-7g); the core does not yet send `card-update` itself. `verifyProofPack` uses the crypto check instead of its own composition (no behaviour change).
- Updated dependencies [b63fd4e]
- Updated dependencies [dd9650b]
- Updated dependencies [4d7d3e4]
- Updated dependencies [84bda36]
- Updated dependencies [2e6b70e]
- Updated dependencies [bdf5da6]
- Updated dependencies [19e234d]
- Updated dependencies [49eb7be]
- Updated dependencies [c6eb603]
  - @4thtech-io/core@0.1.2
  - @4thtech-io/crypto@0.1.2
  - @4thtech-io/transport-nostr@0.1.2

## 0.1.1

### Patch Changes

- 8a3f76e: Local approval page (not opened by the CLI yet): review your waiting approvals together and confirm the list with one passkey or owner code entry (terms are still approved one at a time); each page link opens once; repeated wrong owner codes make you wait before the next try.
- 5773ac4: M1-15-b: Windows path-guard fixes: tests run on Windows with no skip; a folder swap is refused check→open on every OS, and post-open where the OS allows it.
- 053a2cb: M1-15: SSRF-safe download (DNS-pinned, at most 2 re-checked redirects, byte cap, deadline), allowed-folder path guard with realpath on both sides, and a download file-name sanitiser. Not wired into any tool yet.
- e3b9df1: The local approval page now opens at `http://localhost:<port>` (listening on 127.0.0.1 and ::1 on the same port), so a browser passkey can be used for approvals later.
- 42497b7: Adds the local approval server (not wired into the CLI yet): it runs on 127.0.0.1, shows pending approvals, and every approve or deny needs your owner code or owner passphrase.
- c00bc2f: Adds the localhost passkey to the local approval server (not wired into the CLI yet): set up a passkey with your owner code once, then approve or deny with it; the owner code keeps working.
- e768cd1: `owner add-agent` recovers an owner with no attached agent: the owner keys come from the saved owner itself after the owner code, and the owner confirms the fingerprint (M1-9x).
- 1ba92cb: Add `agentlink owner change-code` to replace an exposed owner code without changing the owner
- 58df129: M1-9za: owner commands `contacts rename` and `contacts remove`, signed as the new owner actions `contact.rename` and `contact.remove`; `contacts` lists each contact's ID.
- Updated dependencies [088b5fd]
- Updated dependencies [053a2cb]
- Updated dependencies [4dcc340]
- Updated dependencies [af00aaa]
- Updated dependencies [b26ef46]
- Updated dependencies [2a6716d]
- Updated dependencies [e768cd1]
- Updated dependencies [58df129]
  - @agentlink/core@0.1.1
  - @agentlink/transport-nostr@0.1.1
  - @agentlink/crypto@0.1.1

## 0.1.0

### Minor Changes

- 832fc4f: Add the Node relay connector, host resolver and NIP-11 fetcher for the relay pool of `@agentlink/transport-nostr`. Each relay connection goes to the address the pool checked, never to a second lookup of the name, with TLS and the `Host` header on the relay's host name; redirects are refused and proxy settings are ignored, for the WebSocket and for the NIP-11 read. Inbound messages over 131 072 bytes close the socket before they reach the pool, compression is not negotiated, and the NIP-11 read is capped at 65 536 bytes with its own 5-second deadline. New dependency: `ws` 8.22.0 (no dependencies, no install script).
- af1ce64: Add the owner's answers to requests from unknown senders and refused-row retention to the core (M1-7e-2, D-72). `client.requests` gains `accept(requestId)` (flags that one request row readable; it still counts toward the limits, and no contact or pairing is written), `ignore(fromKey)` (now also removes the key's refusals), `ignoreAll()`, `block(requestId)` (adds the key to `blocked_keys` and removes its requests, refusals and held envelopes in one transaction), `unblock(fromKey)` (by key, never by the sender-chosen envelope ID) and `listBlocked()`; `list()` entries carry `acceptedAt`. Envelopes from a blocked key are dropped at the start of 04 §3.1.1 step 5, before any decryption, with the new fixed reason `sender_blocked`; a contact's card-update from a blocked new epoch key still applies and removes the block, and a pairing message from a blocked key is always dropped. Refusals from unknown keys stop counting 7 days after the local `refused_at` (or when `refused_at` is more than 300 s ahead) and are pruned at the start of each processing pass. `requestsFullTx` now takes `now`. The idempotency `begin` refuses a `clientRequestId` outside 1 to 256 UTF-8 bytes and a tool name outside the 06 §2.0 set with `idempotency_args_invalid`. Store schema version 2: `envelopes.refused_at`, `envelopes.request_accepted_at` and the `blocked_keys` table; the Node SQLite store migrates a version 1 file forward.
- 065d02d: Add the OS keychain KeyStore: the agent's keys on macOS Keychain, Windows Credential Manager and the Linux Secret Service, under service `agentlink` and one account per agent, so several agents share a machine. The agent's identity is read from the keychain for each operation, checked against the agent ID, used and wiped; a missing or mismatched item is an error with a fix and never creates a new identity. Includes creating an agent in the keychain (never overwriting), the keychain probe and the backend choice at setup: without a usable keychain the answer is `needs_setup` unless the user opted in to the passphrase-locked file, which lands later.
- e02996f: Add the agent's local store on SQLite: every table of the store schema, with its keys, unique constraints, value types and row limits enforced by SQLite itself, forward-only migrations (a store written by a newer version is refused, never downgraded), WAL mode and write transactions that several processes can share for one agent, and an inter-process lock for longer critical sections. Sensitive columns are encrypted at rest with AES-256-GCM under the agent's store key from the keychain, bound to their table, column and row, and keyed digests use an index key derived from the store key. `@agentlink/crypto/keystore` gains the store column cipher.
- b4b340c: Add owner presence at a terminal prompt (M1-8c, D-67, D-68). `initOwner` creates the owner key on a keychain machine as the `agentlink`/`owner` keychain item in its locked `ALKO` form, under a generated owner code (or a chosen owner passphrase of at least 12 characters after an explicit opt-in), and never replaces an existing owner. `performOwnerOperation` signs one owner action or one piece of typed data, and `decideReviewedApprovals` signs reviewed approvals as one `approval.decide` or one `approval.decideBatch` (2 to 20 items, commitments never batched). Each asks for the owner code once at an interactive terminal, never from an environment variable, file, argument or pipe, and closes the owner session and wipes the code and the unlocked key when it returns. New error codes on `NodeKeyStoreError`: `owner_missing`, `owner_exists`, `owner_mismatch`, `owner_prompt_unavailable`, `owner_prompt_cancelled`, `owner_secret_refused`, `harness_detected` and `owner_operation_invalid`.
- 5844fea: Add the policy-version mark that protects an owner-signed policy from being rolled back. It is kept as a keychain item next to the agent's keys, rises only, under the agent's inter-process lock, and is read back after each update; a damaged item locks the policy instead of counting as "no policy yet". `openAgentStore` now returns it as `policyMark`, so a Node client passes it to the core and can apply owner-signed policies.

### Patch Changes

- e1f2ba0: Adds the per-agent publisher lease (`client.publisherLease()`, store schema version 3 with the `publisher_lease` table) and bounds staged pairing messages: one still unsent after 24 h is marked not delivered, and one that keeps failing no longer blocks newer ones (`outbox_staged`).
- Updated dependencies [0baa0a5]
- Updated dependencies [c887320]
- Updated dependencies [f805b00]
- Updated dependencies [7121fa2]
- Updated dependencies [2172526]
- Updated dependencies [9c27388]
- Updated dependencies [32b70f5]
- Updated dependencies [cb7c956]
- Updated dependencies [fecd9a3]
- Updated dependencies [4287032]
- Updated dependencies [1feb21c]
- Updated dependencies [2d2e13f]
- Updated dependencies [39b1d8c]
- Updated dependencies [714f2ff]
- Updated dependencies [d440819]
- Updated dependencies [1548d6c]
- Updated dependencies [e46e352]
- Updated dependencies [7355a84]
- Updated dependencies [8efcc8e]
- Updated dependencies [2b46ba4]
- Updated dependencies [716365b]
- Updated dependencies [ebc37c1]
- Updated dependencies [d25bcbf]
- Updated dependencies [6963164]
- Updated dependencies [3e86521]
- Updated dependencies [f17fbf4]
- Updated dependencies [ab59425]
- Updated dependencies [af1ce64]
- Updated dependencies [66e997c]
- Updated dependencies [05fc15a]
- Updated dependencies [2e25c52]
- Updated dependencies [df0dc36]
- Updated dependencies [e1f2ba0]
- Updated dependencies [a96e852]
- Updated dependencies [e02996f]
- Updated dependencies [0cc4ff3]
- Updated dependencies [a1465a6]
- Updated dependencies [d9e2711]
  - @agentlink/crypto@0.1.0
  - @agentlink/core@0.1.0
  - @agentlink/transport-nostr@0.1.0
