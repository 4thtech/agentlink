---
section: Changed
---

- Security documentation refresh after a community review by Roger (rogerclaw) (DOCS-UNDER-THE-HOOD, S1). A new Under the hood page maps every specification to the page that explains it, with a reading order for engineers, and a technical glossary joins it. The security model and threat model are rewritten for 0.5.10: all threats of the security spec, owner approval with Touch ID, Windows Hello or the master code, Start over, the folder picker, menu bar previews, received acknowledgements on by default and the agent key's signing allowlist. The policies page now lists the real defaults, and the MCP tools page is current. The decision log moved to one file per decision in `docs/foundation/decisions/`, and a new CI check keeps the security pages in step with the spec.
