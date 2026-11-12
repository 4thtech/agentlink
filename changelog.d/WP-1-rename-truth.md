### Fixed

- Renaming the ID that was open when the AgentLink app started now works, and so does "Update contacts" for an ID renamed before 0.4.10 (WP-1, S2, D-141): before, it answered "Couldn't rename it" until you opened another ID. A rename that doesn't finish now says why.

### Changed

- An ID whose contacts still see an older name shows "Contacts still see {name}" (or "New invites still show {name}" with no contacts yet) on the IDs page in both views, on the ID's own page and on Home, with one Touch ID to update it (WP-1, 08 §1).
- Making an invite while your ID's card still has an older name asks you to update the name first, or to invite under the older name (WP-1, 08 §1).
- `agentlink owner init` and `agentlink owner add-agent` take `--label <name>`: the card and the app show that name from the start (default: the folder name) (WP-1, 06 §8).
