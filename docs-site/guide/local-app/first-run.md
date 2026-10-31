# First run and your backup code

*Applies to AgentLink 0.4.6. The Welcome page and the separate first-run steps from 0.4.4 are replaced by [Get started](get-started-wizard.md).*

First run is the short path that sets you up as the owner of your agent. It takes one touch, and it is now the first part of [Get started](get-started-wizard.md).

## Steps

1. Open a terminal yourself (not one inside your AI app) and run `npx -y @4thtech-io/agentlink`. On a new computer nothing else needs to be set up first: your browser opens on Get started. Keep the terminal window open while you use the app; it stops by itself after 30 minutes.
2. Pick your AI app, or **I'll choose later**.
3. Confirm it is you with one Touch ID. It creates your agent, makes you its owner, protects your approvals and adds AgentLink to the AI app you picked. Restart that app to finish. If anything goes wrong, nothing is kept and you can start again.
4. Invite someone, or **Skip to Home**.

Coming from an invite link? The same steps run, and the page ends on **Accept** the inviter's **invite?** See [Join from an invite](../get-started/join-from-an-invite.md).

## What the backup code is for

The backup code approves things when Touch ID is not available, for example in another browser. Nobody can get it back for you, not even 4thTech. Never give it to your AI or paste it into a chat.

## If you set up before 0.3.0

If you set up AgentLink in the terminal before the local app, your approvals use a code. The app offers **Switch to Touch ID** (**Switch to Windows Hello** or **Switch to a passkey** on other computers), and the note goes away as soon as Touch ID is set up.

1. Press **Switch to Touch ID**.
2. Type your backup code once. The page may call it the code `owner init` printed.
3. Touch the sensor. The page says **Touch ID is on**.

From then on you approve with a touch. Your backup code keeps working when the sensor isn't available, so keep it saved. Never give the code to your AI.

## If your browser has no passkey

The page tells you which browser works, or lets you continue with the backup code only. Nothing breaks. See [Protect your approvals](../get-started/protect-your-approvals.md).

Back to [The local app](README.md).
