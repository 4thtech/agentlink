---
'@4thtech-io/agentlink': patch
'@4thtech-io/local-ui': patch
'@4thtech-io/desktop': patch
---

UPD-BUTTON-FIX: Settings › Updates "Update now" and "Restart now" work in the Mac app. The page's API client now sends a POST with no body as an empty `application/octet-stream` request, the one form the server's gate takes for routes with no input (it used to answer 415 before the update desk ran, and the page redrew the same card in silence). The same fix makes the recovery kit's Show in Finder reach its route. A refused or failed Update now or Restart now now shows one plain line on the card.
