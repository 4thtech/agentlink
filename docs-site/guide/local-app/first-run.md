# First run and your backup code

*Applies to AgentLink 0.4.4. In 0.4.3 this was one page with a single setup button and no Welcome or AI app steps.*

First run is the short path that sets you up as the owner of your agent. It takes one touch.

## Steps

1. Open a terminal yourself (not one inside your AI app) and run `npx -y @4thtech-io/agentlink`. On a new computer nothing else needs to be set up first: your browser opens on **Welcome**. (`npx -y @4thtech-io/agentlink ui` does the same.) Keep the terminal window open while you use the app; it stops by itself after 30 minutes.
2. **Welcome.** Press **Get started**.
3. **Which AI app will you use?** AgentLink looks in the usual places on your computer for the AI apps it can connect to. Pick yours, or **I'll choose later**. The list is there before your agent exists. If it finds none or can't look, press **Continue**: you connect one afterwards from [AI apps](ai-apps.md). Nothing is written here; the choice only suggests a name.
4. **Set up your agent.** Give it a name you will recognise. It is suggested from your AI app, for example **Claude Code agent**, and you can change it. Your contacts see this name (with none typed, **My agent**), not the name of its folder. The page lists the folders it will create in your home folder: `AgentLink/Send`, `AgentLink/Inbox` and `AgentLink/Proofs`. If `AgentLink/Send` already holds files, or is not a plain folder, it asks you to fix that first.
5. Press the one button, for example **Use Touch ID**. This one confirmation creates your agent, makes you its owner, protects your approvals and lets your AI send files from `AgentLink/Send`, and nothing else. If anything goes wrong, nothing is kept and you can start again.
6. **Your backup code** is shown once. Press **Save in my password manager**, then **I saved it**.
7. If you picked an AI app, **Connect** it to your agent. The page shows the exact entry it will add to the app's settings, saves a backup of the file first, and asks for Touch ID (**Apply with Touch ID**). Restart the AI app afterwards. Press **Later** to skip it; you can do it any time from [AI apps](ai-apps.md). Setting up never changes an AI app's settings by itself.
8. The page ends on [Home](home.md), where [Start here](home.md#start-here) shows what is left. Your recovery kit, which brings your agent and its contacts back if this computer is lost, is put off until you save it from there.

Coming from an invite link? The same steps run, and the page ends on **Accept** the inviter's **invite?** See [Join from an invite](../get-started/join-from-an-invite.md).

## What the backup code is for

The backup code approves things when Touch ID is not available, for example in another browser. Nobody can get it back for you, not even 4thTech. Never give it to your AI or paste it into a chat.

## If you set up before 0.3.0

*Applies to AgentLink 0.4.3 (released 28 Oct 2026) and later; switching to Touch ID is not in 0.3.0.*

If you set up AgentLink in the terminal before the local app, your approvals use a code. The local app now offers **Switch to Touch ID** (**Switch to Windows Hello** or **Switch to a passkey** on other computers), and shows a reminder on each page.

1. Press **Switch to Touch ID**.
2. Type your backup code once. The page may call it the code `owner init` printed.
3. Touch the sensor. The page says **Touch ID is on**.

From then on you approve with a touch. Your backup code keeps working when the sensor isn't available, so keep it saved. If your browser can't do this, the page says which browser works, and you can keep using your backup code. Never give the code to your AI.

## If your browser has no passkey

The page tells you which browser works, or lets you continue with the backup code only. Nothing breaks. See [Protect your approvals](../get-started/protect-your-approvals.md) for browsers.

Back to [The local app](README.md).
