---
section: Changed
---

- MCP: a test now renders every approval and retry hint at its longest case (32-character agent name, port 65535, longest IDs) and fails if one passes 500 code points, so a copy edit cannot turn a pending approval into an error. Over-long link text already falls back to the shorter terminal-only text (M1-36d-c, S1).
