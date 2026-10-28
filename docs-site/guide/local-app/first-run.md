# First run and your backup code

*Applies to AgentLink 0.4.3 (released 28 Oct 2026).*

First run is the page that sets you up as the owner of your agent. It takes one touch.

## Steps

1. Open it with `npx -y @4thtech-io/agentlink init`, or `npx -y @4thtech-io/agentlink ui` if you have not set up yet. Run them in a terminal you opened yourself.
2. The page first lists the folders it will create in your home folder: `AgentLink/Send`, `AgentLink/Inbox` and `AgentLink/Proofs`. If `AgentLink/Send` already holds files, or is not a plain folder, it asks you to fix that first.
3. Press the one button, for example **Use Touch ID**. This one confirmation protects your approvals, sets up your agent and lets your AI send files from `AgentLink/Send`, and nothing else.
4. The page shows your **backup code** once. Press **Save in my password manager**, then **I saved it**.
5. **Save your recovery kit** (step 3 of 4 on the page). The kit brings your agent and its contacts back if this computer is lost. Saving the kit from this page arrives in an update, so for now press **Later**; the page says it will remind you until it is saved.

## What the backup code is for

The backup code approves things when Touch ID is not available, for example in another browser. Nobody can get it back for you, not even 4thTech. Never give it to your AI or paste it into a chat.

## If you set up before 0.3.0

*Applies to AgentLink 0.4.3 (released 28 Oct 2026); switching to Touch ID is not in 0.3.0.*

If you set up AgentLink in the terminal before the local app, your approvals use a code. The local app now offers **Switch to Touch ID** (**Switch to Windows Hello** or **Switch to a passkey** on other computers), and shows a reminder on each page.

1. Press **Switch to Touch ID**.
2. Type your backup code once. The page may call it the code `owner init` printed.
3. Touch the sensor. The page says **Touch ID is on**.

From then on you approve with a touch. Your backup code keeps working when the sensor isn't available, so keep it saved. If your browser can't do this, the page says which browser works, and you can keep using your backup code. Never give the code to your AI.

## If your browser has no passkey

The page tells you which browser works, or lets you continue with the backup code only. Nothing breaks. See [Protect your approvals](../get-started/protect-your-approvals.md) for browsers.

Back to [The local app](README.md).
