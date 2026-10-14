# Terminal copy

80 columns. Plain text first; colour is only an extra. Status words `OK`, `Warning`, `Problem`. Commands and URLs on their own lines. Secrets are never echoed. Rendered examples: `screens/png/copy/terminal--flows--dark--1280.png`.

## init

```
$ npx -y @4thtech/agentlink init

AgentLink found 3 AI apps on this computer:
  Claude Code
  Claude Desktop
  Codex

Changes for Claude Code:
+   "agentlink": {
+     "command": "npx",
+     "args": ["-y", "@4thtech/agentlink"]
+   }

Apply these changes? (y/N)
```

When an agent runs `init`, it shows the diff plus a one-time confirmation code for the user to type. The exact config file paths and entries come from engineering; the lines above show the format only.

## Owner passphrase

```
Your owner passphrase protects approvals on this
machine. Your AI can't approve anything without it.
It is never passed as an argument.

Owner passphrase: ••••••••••••••
Again:            ••••••••••••••

OK Approvals are protected.
```

## doctor

```
$ agentlink doctor

OK       Agent keys found
OK       Message network reachable
OK       Claude Code connected
Warning  Claude Desktop needs a restart
         Quit and reopen Claude Desktop.
Problem  Key file is locked
         Supply the unlock code from a mounted
         secret file or an environment variable.
```

## No keychain (said once, at opt-in)

```
Warning This machine has no system keychain.

AgentLink can keep your agent's keys in a file locked
with an unlock code. That's weaker than a keychain if
someone copies this disk, unless the unlock code is
kept elsewhere. Your approvals still need your owner
passphrase.

Use a key file? (y/N)
```

Then show the unlock code once and how to supply it at run time: a mounted secret file (recommended) or an environment variable (weaker).

## States

success · needs confirmation · cancelled · no AI app · restart needed · keychain unavailable · key file locked · wrong unlock code (one generic message: "That unlock code didn't work.") · offline ("Can't reach the message network. Nothing was sent.")
