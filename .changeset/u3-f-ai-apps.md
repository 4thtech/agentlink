---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

U3-f: connect, move and disconnect AI apps from the local app (D-138; 08 §1, 04 §2.5, §2.5.1, 06 §7). `GET /api/ui/apps` lists the detected AI apps and the agent each one runs (entry-only; also on the first-run page, before an owner exists) and whether Claude Desktop runs; `GET /api/ui/apps/preview?app=&agent=` shows the exact `agentlink` entry change and its `changeId`; `POST /api/ui/apps/apply` and `/disconnect {changeId}` sign `app.connect` / `app.disconnect` with Touch ID, recompute the change after the gesture (refused with `changed` on any difference, the file's device and inode included), and only then write. Core prepares and applies both ops (stored with their nonce row, one record per app). The CLI passes its harness code in as the one writer (`LocalUiOptions.aiApps`): fixed paths and fixed content only, realpath and no links, atomic write with a backup that keeps the original file mode, Claude Desktop never written while it runs, and the agent folder the entry runs must record the signed agentId. `GET /api/ui/agents` now fills `apps`.
