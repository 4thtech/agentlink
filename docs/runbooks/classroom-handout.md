# Classroom handout: AgentLink in one page

For students and the teacher. Mac and Windows. About 10 minutes.

> Where to link it: the user guide in `docs-site/guide/` (next to `quick-guide.md`) when it is published. Not linked there yet.

## Students

1. **Install.** Open Terminal (Mac) or PowerShell (Windows) and paste one line.

   Mac or Linux:

   ```bash
   curl -fsSL https://agentlink.4thtech.io/install.sh | sh
   ```

   Windows (PowerShell):

   ```powershell
   irm https://agentlink.4thtech.io/install.ps1 | iex
   ```

2. **Set up.** The app opens in your browser. On Windows, if it does not, press Enter in the terminal. Pick your AI app (Claude Code, Claude Desktop, Cursor, Codex, OpenCode, Antigravity and more), name your ID, then confirm with Touch ID or Windows Hello.

3. **Save your backup code.**

   > ## SAVE YOUR BACKUP CODE
   >
   > **Write it down or put it in your password manager now.** You will need it once, later, to approve with Touch ID or Windows Hello. Without it you cannot approve removing or renaming an ID.

4. **Restart your AI app completely.** Quit it and open it again. Do this after every AgentLink update too.

5. **Invite a classmate.** In the app choose **Invite someone**, press **Copy**, and send the link. Your classmate opens it, picks their ID and approves. You both see "You're connected".

6. **Talk through your AI.** Try:

   ```text
   Send Ana: hello
   ```

   ```text
   Check my AgentLink inbox
   ```

   Use your classmate's name in place of Ana.

7. **Read the dot.** Green dot: your AI app is connected. Grey ring: your AI app is closed.

### If something goes wrong

- Run this in a new terminal, then show the result to your teacher:

  ```bash
  agentlink doctor
  ```

- "command not found": open a new terminal window and try again.
- The browser did not open: press Enter in the terminal.
- After an update, restart your AI app.

### Known limits this week

- Your contacts may see your ID's internal name instead of your display name.
- Renames do not reach your contacts yet.

## Teacher

### Before class

1. Install on one Mac and one Windows machine with the commands above.
2. Create an ID on each and check that the two IDs can chat both ways ("You're connected", send, read the inbox).
3. Confirm the classroom network lets students reach `agentlink.4thtech.io`.

### In class

1. Pair students up. Each pair invites each other: one invites, the other accepts.
2. Ask everyone to say "backup code saved" before step 4.
3. Walk the room at step 4: most problems are an AI app that was not fully restarted.

### A student is stuck

1. Ask for the output of `agentlink doctor` and read the first line that is not OK.
2. Restart the AI app completely, then check for the green dot.
3. If they lost the backup code, do not guess: they cannot approve removals or renames. Make a new ID and re-invite.
4. Still stuck: pair them with a working student and move on.
