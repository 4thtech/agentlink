---
'@4thtech-io/agentlink': patch
---

W8-F40-WIN-OPEN: on Windows the browser opener runs `System32\rundll32.exe url.dll,FileProtocolHandler` (absolute path, no shell) and falls back to explorer.exe, which exits 1 even when it worked. The CLI says "Opening AgentLink in your browser…", and when no one-shot link is used within 15 seconds it says "Your browser didn't open AgentLink. Press Enter here to try again."; Enter opens a fresh one-shot link. The link is never printed. F41: the first-run line names Touch ID, Windows Hello or a passkey instead of "setup page".
