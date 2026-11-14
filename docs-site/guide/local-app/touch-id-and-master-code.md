# Touch ID & master code

*Applies to AgentLink 0.5.5. This page is new in 0.5.0. On Windows it is called **Windows Hello & master code**, and on Linux **Your passkey & master code**.*

Open **Settings** › **Touch ID & master code** (in the **Safety** group). It is about how you confirm that it is you: *"AgentLink asks before anything that changes who can act for you, spends credits or commits you. Your AI can never confirm for you."*

<figure><img src="../../assets/screens/touch-id-master-code.webp" alt="Touch ID and master code: Touch ID is on, with Test Touch ID. Master code, Set, with Check my master code, Replace master code and I lost my master code. What asks for Touch ID: approving what your AI asks for, changing your rules, renaming or removing an ID, connecting an AI app, saving or restoring a recovery kit. Reading messages and looking around never asks. Three things to keep: Touch ID every day, master code when Touch ID can't be used, recovery kit and recovery code when this computer is gone."><figcaption><p>Touch ID, your master code, and what asks for them.</p></figcaption></figure>

## Touch ID

The first card says **Touch ID is on** or **Touch ID is off**.

- **Test Touch ID** asks for your fingerprint and says **Touch ID works.** It approves nothing and changes nothing.
- When it is off, **Turn on Touch ID** asks for your master code once, then your fingerprint. Your master code keeps working.

Since 0.5.1 each Touch ID (or Windows Hello or passkey) confirmation can be used once. It answers a fresh question the app asks for that one action, in this browser window, and it is good for two minutes. A confirmation can't be used again, and can't be used for another action. Your master code works as before. If you set up your passkey before this version, it may ask for your master code until you set it up again. A double click on a Touch ID button asks once. Since 0.5.4 the button of the action is the Touch ID: for example **Approve with Touch ID**, **Save with Touch ID**, **Rename** or **Remove**, with no second box. **Use your master code instead** is a link next to it. In the Mac app this is the Mac's own Touch ID; the Windows app uses Windows Hello.

## Your master code

Your 24-character backup for when Touch ID can't be used. You saved it when you set up AgentLink (see [Your master code and recovery kit](first-run.md)).

- **Check my master code.** Type it to see **That's the right code.** or **That doesn't match.** Wrong tries count towards the same wait as everywhere else.
- **Replace master code.** Confirm with Touch ID or your current master code. AgentLink shows a new code once (**Copy**); save it, for example in your password manager. Then type or paste the new code back and press **Finish**. Until you finish, your current master code keeps working; after that, the old one stops working. **Cancel** changes nothing.
- **I lost my master code.** If Touch ID still works, replace the code now. If neither works, restore from your recovery kit on this computer (see [Backup & restore](backup-and-restore.md)).

Never type your master code into a chat or let your AI see it. No AI tool can reach this page.

## Windows Hello in the Windows app

In the Windows app, Windows Hello is what Touch ID is on a Mac: **Turn on Windows Hello** asks for your master code once, then the Windows Hello prompt opens in front of the AgentLink window. If your PC can't use it, the page says why and keeps your master code working, never a security-key prompt:

- **No Windows Hello PIN:** "Windows Hello isn't set up on this computer. To use it, open Settings, then Accounts, then Sign-in options, and set up a PIN (Windows Hello). Then come back here. For now, use your master code."
- **No security chip:** "This computer doesn't have the security chip Windows Hello needs for approvals. Use your master code."

## What asks for Touch ID

- Approving what your AI asks for: a file, a proof, accepting terms.
- Changing your rules, renaming or removing an ID, connecting an AI app.
- Saving or restoring a recovery kit.

Reading messages and looking around never asks.

**Three things to keep, and what each is for:** Touch ID, every day; your master code, when Touch ID can't be used; your recovery kit and its recovery code, when this computer is gone.

## Start over on this computer

*New in 0.5.5.* For when you lost your master code and have no recovery kit. Your AI can't start this, and it never needs your master code.

1. Choose **Forgot your master code?** under any master code field. The screen **Start over on this computer?** says what is lost: your IDs on this computer stop working and people need a new invite from you; messages and files of those IDs can't be opened in AgentLink; your AI apps lose their ID until you set up a new one.
2. If you have your recovery kit, press **Restore from recovery kit** instead: you keep your IDs, people and history. Otherwise press **Start over instead** (**Back** changes nothing).
3. Type `start over` (the field is **Type start over**) and press **Start over with Touch ID** (or **Start over with Windows Hello**). In a browser, the browser asks you to confirm with Touch ID, Windows Hello or a passkey. On a computer with none of them, press **Continue** and type `start over` once more in **Type start over again**, then press **Start over**.
4. When it says **You can start fresh**, quit and reopen your AI apps: until you do, they keep using the old ID and keep writing into the backup folder. Press **Set up AgentLink** to make a new master code.

AgentLink moves its folder to a dated backup (`~/.agentlink.backup-` and the date and time), and deletes nothing in it. It removes only its own items from the Keychain (Mac) or Credential Manager (Windows). Passkeys named AgentLink stay in your browser or system settings; you can delete them there. If a step fails, the screen says which one, and **Try again** is safe.

Back to [Settings](settings.md) or [The local app](README.md).
