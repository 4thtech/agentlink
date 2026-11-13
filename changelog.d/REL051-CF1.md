---
section: Fixed
---

- Accepting an invite never sits on "Connecting to …" for good (REL051-CF1, R1-CLASS-01, -06, S2; 04 §3.6, 08 §1): after a few seconds without an answer it says "Waiting for {name}'s AgentLink to come online. It connects by itself; you can close this.", after two minutes "No answer from {name} yet. If this invite was already used or cancelled, it won't connect. Ask {name} for a new one.", and every waiting row on People and Home has Cancel. Also after an app restart.
- On a slow network the app keeps fetching longer instead of giving up every few seconds, so an accept finishes when the inviter's answer is late (REL051-CF1, R1-CLASS-10).
- When you use a contact's old name after it renamed its ID, your AI is told its new name and asks you before doing anything (it never acts on an old name), and a blocked contact reads as blocked, not "not found" (REL051-CF1, R1-CLASS-11; 06 §2).
- When something needs your approval, your AI now points you to Home in the AgentLink app first; the terminal command is only the fallback (REL051-CF1; 06 §2.5).
- An ID you named "Assistant", "Agent", "Me", "User" or "Developer" keeps its name after the 0.5.1 name rule, and you can still pick such a name for your own ID; names other people send are still held to the rule (REL051-CF1, R2-5; 06 §2.1).
