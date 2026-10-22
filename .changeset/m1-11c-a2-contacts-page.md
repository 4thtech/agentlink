---
'@4thtech-io/node': minor
'@4thtech-io/agentlink': minor
---

The local web app's Contacts page (M1-11c-a2): three read routes (`GET /api/ui/contacts`, `GET /api/ui/contacts/:ref/safety-code`, `GET /api/ui/contacts/:ref/rename-check`) and three owner routes behind the central presence gate (`POST /api/ui/contacts/:ref/check`, `…/rename`, `…/remove`), plus the page itself. The owner routes build the unsigned `contact.check`, `contact.rename` and `contact.remove` with core's prepare helpers, sign them once with the presence the request carried and apply them through core; "They match" signs only when the code recomputed now is the code the page showed. The read-only client view that handlers get now also has `contacts` (the list, the safety code and the three prepare helpers). No key, card, raw name, pairing digest or error text leaves the server for this page. The page routes share fixed answers: 409 `not_set_up`, 400 `invalid_query`, 503 `unavailable`.
