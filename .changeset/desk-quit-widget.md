---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

DESK-QUIT-ORDER, DESK-WIDGET-OPEN, DESK-WIDGET-TARGET: quitting the desktop app hides its windows before the core stops, so no stray screen flashes; the menu bar widget opens reliably on every desktop and over full-screen apps; clicking a message in the widget or in a notification opens that conversation. The local app gains a desktop-aware "stopped" screen with Try again.
