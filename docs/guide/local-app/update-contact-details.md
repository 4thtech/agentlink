# Update your contact details

<!-- ai-knowledge: summary
summary: How to move an earlier ID to AgentLink's new default message servers with one approval, on Home or with agentlink owner update-contact-details, and what happens to your contacts. -->

*New in 0.5.13.*

AgentLink moved to more reliable message servers. An ID you made before that still lists the old ones on its contact details. Update your contact details moves it to the new ones. It takes one approval from you, and then your contacts learn your new details by themselves.

## Do it in the app

1. Open **Home**. If your ID needs it, a notice says "Update your contact details" and "AgentLink moved to more reliable servers. Your contacts need your new details once."
2. Press Update with Touch ID (the button names the sensor your computer has), or Update with your master code.
3. The notice says Contact details updated. Your contacts get your new details.

## Do it in the terminal

Open a terminal yourself and run:

```
agentlink owner update-contact-details
```

It asks for your master code, then prints Contact details updated. Your contacts get your new details. If there is nothing to do, it says Your contact details are up to date. Nothing to do. To update one ID when you have several, add `--id <name>`. `agentlink doctor` mentions it as a notice while the update is still open.

## Good to know

- Only you can do it. It needs Touch ID or your master code. Your AI cannot do it for you, and no AI tool can.
- Your contacts do nothing. They receive your new details automatically.
- Nothing breaks if you wait. For now AgentLink still reads from the old servers too, so nothing waiting there is lost, and it still reaches contacts whose invite lists them. New invites list only the new servers.
- If it fails. Your contact details stay as they were. The notice says That didn't go through. Your contact details didn't change. Try again. If an earlier change of this ID is still finishing, try again in a minute. If it says to quit and open AgentLink again, do that and try once more.

Back to [Home](home.md) or [The local app](README.md).
