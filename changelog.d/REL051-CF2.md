---
section: Fixed
---

- When this computer can't reach the message network (for example a school or office network that blocks it), the app no longer says "Connected": the status bar says "Can't reach the message network. Messages wait and send when it's back.", Relays & network shows the real count ("0 of 3 connected") and "Last checked" the last time a relay answered (before the first check it says "Checking the connection…"). Your AI is told the message is queued, not sent (also when it adds proof) (`agentlink_send` adds `delivery`: `sent`, `queued` or `not_delivered`). Everything still goes out on its own once the network is back (REL051-CF2, S2, R1-CLASS-02).
