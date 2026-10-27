# MSG-FILES-IO plan: Messages and Files In/Out in the local app

| | |
|---|---|
| **Status** | Plan. The feature is **decided** by the owner (Tali, 27 Oct 2026, in chat): B-11 §18 decisions 1 (a), 4 (a), 5 (a) and 6 (a). The cards are in `backlog.md` (Local approval UI, MSG-FILES-IO-a to -h). Specs win on conflict; MSG-FILES-IO-g writes the spec text. |
| **Design** | `docs/design/b11-local-app.md` §17 (merged in #567) |
| **Replaces** | The 0.3.1 plan items M1-UX3-FILES-EXPLAIN (Files explainer line and Received tab) and the Sent list of M1-UX3-FILES-SEND. Neither was carded; both are now covered by MSG-FILES-IO-d and -f. The folder picker of M1-UX3-FILES-SEND stays a separate later card. |
| **Date** | 27 Oct 2026 |

## 1. What the owner decided

People see what their AI did, in the local app, without asking the AI.

- New sidebar item **Messages**: contacts on the left; for the chosen contact, two tabs **Inbox** and **Sent**, each a list with a detail view.
- **Files** gets three tabs: **Received · Sent · Send folders** (Received first).
- **Read-only.** No compose box; the footer says "To reply, ask your AI." No new MCP tool, no new AI authority (I-4).
- **Reading in the app does not mark a message read for the AI.** The app keeps its own "seen" marker.
- **Decrypted only on this computer.** Nothing new goes to any 4thTech service (zero access).
- **Inbound content is untrusted plain text** (I-5): no Markdown, no HTML, no images, no previews, no active links (a link is an inert chip showing only its domain, as `UntrustedContent` already does).
- **Under the hood** shows metadata only: message ID, size, proof status. Never keys, codes, tokens, drop links or presigned URLs.

## 2. What the code has today (checked 27 Oct, main at 74be6508)

| Need | Where it is | Gap |
|---|---|---|
| Received messages | `envelopes` rows, `direction = 'in'`, `state = 'ok'`; body in `payload_json`, sealed under the store key (`packages/core/src/store/schema.ts`, `envelopes.ts`) | None |
| Sent messages | Also kept: `outboundRow()` in `envelopes.ts` stores every sent envelope with its payload sealed (`direction = 'out'`, `delivery` queued / sent / not_delivered). `outbox.ts` holds only the relay copies and retries | **None: no new store is needed** |
| A message list without URLs or keys | `inbox-page.ts` already builds inbound and sent items (`includeSent`) and drops file URLs and file keys (`baseOf`) | It always sets `read_at` on inbound rows (the AI's read state), so the app cannot call it as is |
| Received files | `files` rows written at ingest (`files/received.ts`): name, URL and file key sealed; size, expiry | Where the AI saved a fetched file is not recorded: `fetchFile` returns `savedTo` and forgets it (`files/incoming.ts`) |
| Sent files | `files` rows for outbound envelopes (`files/records.ts`): name, locator, URL and key sealed; retention via `delete_after` | None |
| Protection at rest | Every sealed column: AES-256-GCM under the agent's store key, AAD bound to table, column and row key (`packages/node/src/store-cipher.ts`, `@4thtech-io/crypto/keystore`); the store key lives in the `KeyStore` | None |
| Browser session | `approval-server.ts`: one-shot session link → HttpOnly SameSite=Strict cookie; every `/api/ui/` route also needs the CSRF header, same-origin fetch metadata and the exact `Host`; a mutating route must declare `presence: true` (`local-ui/routes.ts`) | A "seen" write from the page would need presence each time, so the seen marker stays in the browser (§4) |
| The AI's reach | MCP tools in `packages/mcp-tools`; the local UI API is only on the approval server's HTTP port | None: nothing here adds a tool |

## 3. Data sources and retention

- **No new store and no new copies.** Messages come from `envelopes` (in and out); files from `files`. Sent bodies are already kept, sealed, for as long as their envelope row exists (today: not pruned, except refused and request rows, D-72).
- One small schema addition (MSG-FILES-IO-b): `files.saved_name` (`enc`, sealed like `name`), the single file name `fetchFile` placed in the Inbox folder. Store schema version 5 → 6; old rows read `null` ("not saved yet").
- Retention is unchanged: file rows follow `delete_after` (04 §4); after a shred the app shows "Expired". A removed contact's conversation is hidden, as in the AI's inbox. Owner question 2 asks whether message history should get a limit.
- Only types in `INBOX_TYPES` from a contact that is not removed are listed. Unknown senders (requests), refused, held and protocol envelopes are never listed (11 §5: requests stay in Contacts).

## 4. Local API (read-only, owner browser session only)

All routes are `GET`, `presence: false`, under `/api/ui/`, registered in `local-ui/routes.ts`, behind the same cookie, CSRF, Host and fetch-metadata gate as every page. They never write to the store; in particular they never touch `read_at`. They are not MCP tools and are not reachable from the MCP server's tool surface. Every item is built from an allowlist with an exact-key-set test (as `ui-reads`), so no URL, file key, `envelope_json`, salt, wrap or sealed value can ride along.

| Route | Returns (allowlist) |
|---|---|
| `GET /api/ui/messages` | `conversations[]`: `contactId` (route key only, never shown), `name` (owner alias or restricted name, as outside the untrusted block), `lastAt`, `lastInAt` |
| `GET /api/ui/messages/:contactId?box=in\|out&cursor=&limit=` | `items[]`: `id`, `at`, `type`, `text` (plain string; a JSON body as indented JSON text; terms types show their note), `files[]` (`name`, `size`), `status` (Sent only: `queued`, `sent`, `not_delivered`), `receipt` (boolean), `proof` (boolean), `size`; `next` cursor |
| `GET /api/ui/files/received?cursor=&limit=` | `items[]`: `id` (`<envelopeId>.<idx>`), `from` (name), `at`, `name`, `size`, `state` (`saved`, `not_saved`, `expired`), `savedName` (only when saved), `proof` |
| `GET /api/ui/files/sent?cursor=&limit=` | `items[]`: `id`, `to` (name), `at`, `name`, `size`, `status`, `receipt`, `state` (`available`, `expired`, `deleted`), `expiresAt` |

Limits: `limit` 1–100 (default 20), cursor ≤ 256 characters, `contactId` matches the route parameter rule. Errors are fixed codes (`not_found`, `bad_request`, `unavailable`), never message text.

**Seen marker (owner decision 5 (a)).** Kept by the page in `localStorage`: per contact, the time of the newest inbound message the person has looked at. No message text, no server write, no presence. It is per browser; the AI's `read_at` is never changed. The Messages badge counts inbound messages newer than that time.

## 5. Pages (apps/local-ui)

Built from existing components and D1 styling (D-116): the contact list styling of Contacts, `UntrustedContent` for every inbound text and inbound file name, the existing tabs and status chips. When the B-11 screens are approved, the motion and depth pass restyles them (no new visual design is invented here).

- **Messages** (`/settings/messages` until M1-11b-2 moves the app to `/`; then `/messages`), between Activity and Contacts. Contacts list with time and a dot for new; Inbox and Sent tabs; long messages clamped with "Show all"; **Copy text**; footer "To reply, ask your AI."; empty, nothing-yet and offline ("as of 14:02") states; Under the hood: message ID, size, proof.
- **Files**: top line "You don't upload here. Put files in your Send folder or ask your AI to send them; files you receive appear under Received." Tabs Received (from, when, size, proof badge, saved state, the one-time untrusted-file note), Sent (file, to whom, when, status chips, receipt) and Send folders (today's page). The app never opens a received file.
- **Show in Finder** is a separate card (MSG-FILES-IO-h) because it needs a new kind of route (owner question 1).

## 6. Threat notes (04)

- **I-5, inbound content.** Message text and other people's file names are untrusted. Only inside `UntrustedContent`, as plain text; never in the page title, notifications, toasts, Activity rows, Home tiles or the OS passkey prompt ("New message from Marko" only). File names may hold control, bidi or look-alike characters: rendered as text in the untrusted container, never used as a path by the page. A test feeds a body with HTML, Markdown, a `javascript:` link and an image tag and asserts the DOM has no element, attribute or link from it.
- **I-4, no new authority.** GET only; no store write; no MCP tool (the tool-list snapshot test stays unchanged); no compose. Reading never marks a message read for the AI (a test asserts `read_at` is unchanged after every route).
- **I-7 and zero access.** The server reads the local store only: no relay, drop or chain request (a test with a failing transport and storage still answers). No URL, file key, drop link, `envelope_json` or sealed value in any response (exact-key-set tests, and a test that scans responses for the stored URL and key). Logs carry counts only; error responses never carry message text.
- **Session.** Same gate as every `/api/ui/` route. Residual risk (`approval-server.ts`, G-1, D-67): cookies are not isolated by port, so another local server the owner's browser visits could receive the cookie, and "viewing only" now includes message text. Owner question 3.
- **SSRF and realpath (04 §4).** No URL is fetched. `saved_name` is the single checked segment `fetchFile` already chose; it is stored as a name, never as a path. Show in Finder (card h) resolves the Inbox folder's realpath again, refuses links (`lstat`), checks the file is a direct child, and passes it to the OS opener as an argument, never through a shell.
- **Crypto.** Sealing and opening only through core's `seal`/`open` (the store cipher from `@4thtech-io/crypto`, key in the `KeyStore`). No new primitive, no new key.

## 7. Cards and order

| Card | What | Class | Tier | Depends on |
|---|---|---|---|---|
| MSG-FILES-IO-a | core: read-only messages and files views, no read mark | S2 | Opus, Fable audit | — |
| MSG-FILES-IO-b | core + node: record a fetched file's saved name (schema 6) | S2 | Opus, Opus review | — |
| MSG-FILES-IO-c | node: Messages API routes | S2 | Opus, Opus review | a |
| MSG-FILES-IO-d | node: Files Received and Sent API routes | S2 | Opus, Opus review | a, b |
| MSG-FILES-IO-e | local-ui: Messages page | S1 | Sonnet, Opus review | c (builds against §4 with a mocked API) |
| MSG-FILES-IO-f | local-ui: Files tabs Received · Sent · Send folders | S1 | Sonnet, Opus review | d (same) |
| MSG-FILES-IO-g | spec: 08 §1 pages and routes, 11 §5 strings, decision log | S1 | Opus | — |
| MSG-FILES-IO-h | Show in Finder for a saved received file | S2 (sensitive: route registry) | Opus, Fable audit | b, f; owner question 1 |

Order: **a, b, g in parallel**; then **c and d** in parallel (both add one line to `routes.ts` and `context.ts`: merge main before review); **e and f** can start with a, b (mocked API, disjoint folders) and merge after c and d. h waits for the owner.

## 8. Owner questions (recommended first)

1. **Show in Finder.** (a) A new route kind for local OS actions: POST, no presence, no signing, no store write, one fixed action; changes the registry rule "every POST needs presence" (recommended, card h); (b) no button: show the Inbox folder path with Copy; (c) presence (Touch ID) on each click.
2. **Message history retention.** (a) Keep as today (until the contact is removed), the app changes nothing (recommended); (b) a limit such as 90 days, as a new rule (a later card).
3. **Message text and the session cookie.** (a) Accept the documented residual for 0.3.x and revisit before M3 (recommended); (b) require presence once per session before Messages shows any text.
