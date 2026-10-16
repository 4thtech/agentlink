---
'@4thtech-io/agentlink': minor
---

Add the everyday `agentlink` commands: `invite`, `accept <url>` (under the default policy it asks for approval and prints the `agentlink approve <id>` command, then proceeds once with `--approval <id>`), `contacts`, `status [--brief]` (read-only: a fetch-only catch-up, nothing processed), `doctor`, and `requests` (list, accept, ignore, ignore --all, block, blocked, unblock). Every printed value another party chose is sanitized, and a request's content is shown only inside the marked untrusted region.
