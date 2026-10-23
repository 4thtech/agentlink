---
'@4thtech-io/storage': patch
---

M1-6b-d: `apply()` on the lifecycle helper now returns `{ abortIncomplete, warning }`; when the provider drops the abort-incomplete-upload element it reports `dropped` with a plain-words warning (still a success).
