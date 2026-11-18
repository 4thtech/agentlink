# Notices

One notice system for the local app (owner feedback, 12 Nov 2026). Three kinds, one look, one way to close. Components are in `packages/ui` (`Toast` and `ToastStack`, `Banner`, `PageNotice`); the local app's helpers are in `apps/local-ui/src/notices/` (`notify()`, `useDismissed()`, `useArchived()`). Style comes from the D1 states sheet (`d1/screens/local/shared-states--all`) and the first-run side card (`first-run--protect-approvals`); tokens only, classes only (08 §4 CSP). Copy follows 11 §5.

## Pick the kind

| Kind | Use it for | Where | Closes | A11y |
|---|---|---|---|---|
| **Toast** | The outcome of something that just happened: "Renamed. Your contacts will see Home next time they're online.", "Denis removed.", "{name} accepted your invite" | One stack, bottom right above the status bar (centred under 900 px); raised with `notify()` from any page | By itself after 6 s (10 s with an action); hover or focus holds it; always a close button | Each toast is `role="status"` (polite) inside a labelled region; never takes focus; never approves anything |
| **Inline banner** (`Banner`) | Something about the thing next to it: offline, a load that failed, "Approved: …", "Renamed.", a removed connection's one line | Right beside what it is about | Optional close (`onDismiss`); `compact` for one line | `role="status"`; `role="alert"` only for warning and danger |
| **Page notice** (`PageNotice`) | A state that stays until it is resolved, with its action: Protect your approvals, Finish setup, Save your recovery kit, Switch to Touch ID, Finish removing, Contacts still see {old name}, {ID} is paused, Tidy up | Top of the page, at most two at once | Only when it may be put off: the close is remembered (`useDismissed`) | A labelled region (`aria-labelledby` its title); not a live region, so it is not read again on every update |

## Rules

- **Tone.** `info` by default; `success` for done; `warning` when something needs the owner (paused, unfinished removal, recovery kit after a first contact); `danger` only for integrity or signature failures; `neutral` when nothing needs the owner (removed connection, Tidy up, approvals that use the master code).
- **Calm by default.** A state the owner can't change (a contact removed the connection) is a quiet `neutral` line, never an expanded warning. The full explanation lives on the thing's own page (the contact's panel), one link away.
- **One action.** A notice has at most one primary action. A second way out is the close, not a second button.
- **Remembered closes.** A page notice that may be put off is closed per ID: `noticeKey('protect-approvals', idName)`. Kept in this browser only (`agentlink.notices.dismissed.v1`), fixed keys, never a name, code or link. Notices that must be resolved (setup unfinished, unfinished removal, owner not set up) have no close.
- **Archive, don't delete.** A removed connection can be archived on Home (row or opened part): it moves to "Archived (n)" under People, per ID (`agentlink.home.archived.v1`, contact refs only), with its conversation and files kept, and Restore brings it back. A contact that is active again shows in People whatever was archived.
- **Where it runs.** The desktop app (user agent `AgentLinkDesktop/1`) is never "this browser" and never told the desktop app is stronger. Protect your approvals there says the master code confirms approvals, or offers "Turn on {sensor} for approvals" when the desktop build passes its native presence (`nativePresence` slot on `ApprovalsPage` / `OwnerPanel`).
- **Text only.** Names and other parties' words are React text (I-5). No link, invite, code, key or message text in a toast or notice.
- **Not notices.** A form field's error stays under its field (`role="alert"` on the line); the approval card's own status lines and the Start here card are their own components.
