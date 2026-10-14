---
'@agentlink/types': patch
---

Download URLs in file entries now need a lower-case host and a port between 1 and 65535, as relay URLs already do. The package tests now run in Node, Chromium, Firefox, WebKit and Cloudflare Workers.
