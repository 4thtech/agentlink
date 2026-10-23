---
'@4thtech-io/node': patch
---

Owner setup on the first-run page refuses, before anything is read or written, a held seed that is not the owner the page was shown (M1-11s-c-b). Tests: the setup canary now covers the seed and the PRF output in every encoding, using a canary seed that is never a real seed.
