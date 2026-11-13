---
section: Changed
---

- A recovery kit now carries each ID's own name, so restoring on a new computer lists your IDs by the names you gave them (KIT-NAMES, S2, 04 §2.3.3, 07 §9.4, R2-UI-04): the kit format is version 2, and the names are only inside the encrypted kit, never readable without its recovery code. Kits saved earlier still restore as before (their IDs show by folder until restored). An older AgentLink given a new kit refuses it before asking for the code and says it was made by a newer version. Spec change proposed, owner confirms at merge.
