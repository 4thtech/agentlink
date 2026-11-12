---
section: Changed
---

- One source for the docs (DOCS-UNIFY, S1): docs-site is the only source of the AgentLink pages on 4thTech Docs (wiki.4thtech.io); `tools/docs/wiki-sync.mjs` generates that copy from each release tag, a daily workflow opens the wiki pull request, and a preflight check fails a docs change that would break there. New user guide page "Your IDs and your people": you, your IDs and the people each ID talks to, with a diagram, three examples and answers to common questions.
