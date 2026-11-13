# AgentLink: files, attach, delete and notifications

Detail for the AgentLink user guide (agentlink-userguide.md): attaching files, deleting history and freeing up space, and notifications. Read the user guide first for install, invites and the basics.

## Attach files in a conversation (0.5.4)

**Attach** in the conversation (or drag files onto it) to send Markdown, text or JSON files yourself, up to 8 MB each and 5 at a time; they show as chips you can remove, with an optional note, and go out with **Send**.

A file you attach in the app is copied into your Send folder (never over an existing file: a second `notes.md` becomes `notes (2).md`) and sent end-to-end encrypted under the same rules as your AI; with no Send folder yet, the app first shows **Allow Send folder**. Images and other kinds are planned. Files over about 12 KB go through the encrypted drop, open to all early users with no setup (100 MB per file, 1 GB per ID per week, gone within 7 days).

## Delete history and free up space (0.5.4)

Settings, then Storage, shows how much room messages and saved files take. Since 0.5.4: Free up space on that page (a person, an age, files only, then Review), Delete history… in a person's menu, and Select in a conversation. Each delete shows what it removes, asks for Touch ID once, then waits 10 seconds with Undo (quitting then removes nothing); it is on this computer only (the other person is not told), keeps pairing, terms, approvals and receipts, and moves saved files to the Trash. Archive hides a person without deleting anything. No AI tool can delete.

**Archive** hides a person and deletes nothing. **Keep automatically** (Settings, Storage) clears old history daily: messages forever by default (or 90 days, 1 or 2 years), saved files 30 to 365 days (new IDs 90 days; earlier installs keep everything until you choose); it first shows what it removes, and saving asks for Touch ID. Your AI can only suggest a cleanup with the exact counts and a link (the tool `agentlink_tidy`); you confirm it in the app. No AI tool can delete or change these settings.

## Notifications (0.5.4)

The bell in the top bar shows how many things are new for the open ID, also as "(3)" in front of the tab title, and the tab icon gets a dot while an approval waits. Open it for Needs you (approvals, counted until you decide them), New (new messages and files per person, a new version, the message network unreachable for 10 minutes) and Earlier; click a line to go there, or Mark all read. It never holds message text, file names or links, names a person only by a name you gave them on People ("a contact" otherwise, including a name someone chose for themselves), stays on this computer and keeps 30 days or 200 lines. In a browser, Settings › Notifications has one switch, Approvals waiting (on): the short alert on this computer when an approval waits and AgentLink could not open your browser. Off means no such alert; the bell and Home still show it. In the desktop app it has five: Approvals waiting (on), New messages, Files received, Updates and Show names in notifications (off). The desktop app shows real AgentLink notifications ("Approval waiting", "New message", "File received", "Update ready"), at most one of each kind every 30 seconds; a click opens that page; the Dock number is the approvals waiting; and no other approval alert appears for the open ID while it runs.
