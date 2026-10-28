---
section: Added
---

- U3-flow: the local app can ask for the live connections map's metadata for the open agent (`GET /api/ui/flow?since=<cursor>`), through a new read-only core view. It never carries content, names, links, keys, hashes or envelope IDs, and has no byte progress (U3-flow, S2).
