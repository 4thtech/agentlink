---
'@4thtech-io/agentlink': patch
'@4thtech-io/local-ui': patch
---

N7: native notifications in the desktop app. The core sends fixed codes over its private pipe (`notify {kind, count, name}`: approvals, messages, files, update); the app shows "Approval waiting", "New message", "File received" or "Update ready" as a real AgentLink notification, at most one per kind every 30 seconds, and a click opens that page. The dock badge shows the approvals waiting; on Windows the app sets its AppUserModelID for toasts. While the desktop app runs, `agentlink mcp` shows no osascript or notify-send alert. Settings › Notifications in the desktop app has five switches (approvals on; new messages, files received, updates and Show names off); a name is only one you gave the contact. The browser app keeps its one switch.
