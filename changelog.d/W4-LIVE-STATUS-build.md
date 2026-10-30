---
section: Added
---

- Live AI app status (W4-LIVE-STATUS, S2, D-143, 06 §6, 08 §1): the app now knows which AI app runs which agent while it runs. Each AI app's AgentLink connection reports in every 15 seconds, so an app that quits or crashes drops off within seconds, a second AI app on the same agent shows too, and each app reads as Working, Ready, Idle, Not running (with when it was last seen) or Not set up. The app gets these changes through a new live update stream on this computer only; it carries only agent names, labels, app names, states and times. The screens switch to it in a follow-up.
