### Fixed

- Installing the AgentLink app after starting in the browser now continues where you left off (APP-CONTINUITY, S2, 08 §1): same owner, IDs, contacts and folders, with no new setup. Inside the app, approvals and every other confirmation use the app's own Touch ID or Windows Hello once it is on, otherwise your master code. The app never asks for a browser passkey it can't use.
- The app and `agentlink ui` no longer run side by side by accident (APP-CONTINUITY, 08 §1). Opening the app closes a running `agentlink ui` cleanly, and its window says the app took over. Running `agentlink ui` while the app is open brings the app's window to the front instead of starting a second copy. A note left behind by a crashed copy is cleared.
- Connecting an AI app from inside the app now works on a computer with only the app, with no Node or npx needed (APP-CONTINUITY, 06 §7). AI apps connected from the browser keep working unchanged.
- After "Approvals are already protected on this computer" in first run, "Skip to Home" is there (APP-CONTINUITY).

### Changed

- In the app, Home and Approvals offer "Turn on Touch ID" (or Windows Hello) when it isn't on yet. You enter your master code once, then touch the sensor (APP-CONTINUITY, 08 §1).
