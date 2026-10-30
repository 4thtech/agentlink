---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

W4-SHELL-LIVE (U1-b; D-143, 08 §1): the local app follows `GET /api/ui/events` instead of reading the agents every 5 s. One shared subscription per page reads the stream with `fetch` (the CSRF header, `Accept: text/event-stream`, `Last-Event-ID` on reconnect), reconnects with backoff (1 s doubling to 30 s, with jitter) and falls back to the 5 s read while the tab is visible after three failures within a minute, a refusal or a browser without a streamed body, trying the stream again every 60 s. The agent chip, its dropdown and the Under the hood strip show the words of 08 §1 (Working with the pulse, Ready, Ready in {app} and {n} more, Idle, Not running · last seen {time}, Offline · last seen {time}, Not set up, Another AI app). The shell waits for the app's Under the hood and menu values (at most 300 ms) and keeps the chip and strip in place, so the page no longer shifts when they arrive (CLS ≤ 0.01).
