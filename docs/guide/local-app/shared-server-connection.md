# Shared server connection

<!-- ai-knowledge: summary
summary: What the shared server connection is (all AgentLink programs on one computer use one connection to each message server instead of one each), why it exists, what you gain, what stays safe, the one trade-off, that it is off by default in 0.5.18 and planned on by default in the next release, how to turn it on or off for each AI app and the desktop app, and how to see it in Under the hood and agentlink doctor. -->

*New in 0.5.18, off by default. It is planned to be on by default in a later release; you can always turn it off.*

AgentLink sends and receives your messages through message servers. Without this feature, every AgentLink program on your computer opens its own connection to every server. With it, they all use one.

## The problem

Each AI app you connect (Claude Code, Codex, Cursor and so on) runs its own small AgentLink program, and the AgentLink desktop app runs one too. Each of them opens a line to each message server. With 3 AI apps, the desktop app and 4 servers, that is up to 16 lines from one computer, all from the same computer. Each ID in a program can add more, because each ID listens on its own.

Some servers allow only about 2 lines from one computer and turn the rest away. The extra programs then show "Can't reach" for that server, and your messages go out through fewer servers than you meant. The check that a sent message really arrived (the "available from" count) opens one more line per server, so it competes for the same limit.

```mermaid
flowchart LR
  subgraph before["Before: every program has its own line to every server"]
    A1["Claude Code"] --> S1["Server 1"]
    A1 --> S2["Server 2"]
    A2["Codex"] --> S1
    A2 --> S2
    A3["Desktop app"] --> S1
    A3 --> S2
  end
  subgraph after["After: one line per server for the whole computer"]
    B1["Claude Code"] --> L["Shared connection"]
    B2["Codex"] --> L
    B3["Desktop app"] --> L
    L --> T1["Server 1"]
    L --> T2["Server 2"]
  end
```

## What you get

- Far fewer connections. One line per server for the whole computer, however many AI apps and IDs you run.
- Servers that limit lines work. A server that allows 2 lines from one computer no longer turns your extra programs away.
- More reliable delivery. Programs stop competing for the same few lines, and the check that a message arrived shares one extra line per server instead of opening one for each program.
- Lighter. Less work for your computer and your network, and less load on the servers.

It does not make messages more private and it does not make them faster. It only stops servers from turning extra connections away.

## What stays safe

- Your keys never move. Each program keeps its own keys. Only already-scrambled (encrypted) messages and the names of servers go between programs. A key, your master code, a recovery code or a file never does.
- Messages stay private. They are scrambled before they leave your program, so the shared connection cannot read them. Each program still checks every message it receives.
- Other people on the computer cannot use it. The connection between your programs is private to your computer account, and each program has to prove it knows a secret that only your account can read before anything else happens.
- It is not a way out to anywhere else. It only opens connections to message servers (names starting with `wss://`), and checks each one again, so it cannot be used to reach other machines on your network.
- It falls back by itself. If something goes wrong (an older AgentLink version, a program that can't join, the program that held the connection closing), your program uses its own connections, as it does without this feature. When the program that holds the connection closes, another one takes over within a couple of seconds.
- Nothing private is written to logs. Only counts.

## The one trade-off

A server can tell that the IDs on one computer share a line. They already come from the same computer, so a server could often guess this, but now it can see it. Message content stays hidden, and so do who sent it and who it is for. If you would rather keep the IDs on separate lines, leave this feature off.

## Turn it on or off

It is controlled by one setting, `AGENTLINK_SHARED_RELAYS`. `1`, `on`, `true` or `yes` turn it on. Anything else, including `0`, or nothing at all, leaves it off. A program only joins if its own setting is on, so set it for each AI app you want to share. Programs without it keep their own connections and work as before, next to the others. There is no setting on the app screens yet.

AI apps that use a settings file (Claude Code, Claude Desktop, Gemini CLI, Cursor, Windsurf, Antigravity). Add an `env` block to the AgentLink entry and restart the AI app:

```json
"agentlink": {
  "command": "npx",
  "args": ["-y", "@4thtech-io/agentlink", "mcp"],
  "env": { "AGENTLINK_SHARED_RELAYS": "1" }
}
```

Codex. In `~/.codex/config.toml`, add under the AgentLink entry:

```toml
[mcp_servers.agentlink.env]
AGENTLINK_SHARED_RELAYS = "1"
```

OpenCode. In `opencode.json`, add `"environment": { "AGENTLINK_SHARED_RELAYS": "1" }` to the AgentLink entry.

The AgentLink desktop app. It reads the setting from its own environment when it starts. On a Mac, run `launchctl setenv AGENTLINK_SHARED_RELAYS 1` and reopen the app. On Windows, add a user environment variable with that name and the value `1`, then reopen the app. When the desktop app starts, it asks an AI app's program to hand the connection over, so the long-running app usually holds it.

The terminal app (`agentlink ui`, from 0.5.19). It reads the setting from the terminal you start it in: `AGENTLINK_SHARED_RELAYS=1 agentlink ui` (macOS, Linux). Its Under the hood › Message network line then shows the real state.

To turn it off, set the value to `0` (or remove it) and restart that program. The file for each AI app is described in [the technical reference for each AI app](../../technical/reference/harness-configuration.md).

## See it

- Under the hood. Turn on [Under the hood](under-the-hood.md), then open Settings › Advanced › Message network. One line shows "Shared server connection: on · 3 IDs on this computer" or "off · each program connects on its own". The number counts IDs, because each ID uses the connection separately: an AI app with 3 IDs counts 3.
- `agentlink doctor`. It prints "Shared server connection: on, 3 IDs" or "off". `doctor` reads the setting from the terminal it runs in, so if you turned it on only inside your AI apps, run it as `AGENTLINK_SHARED_RELAYS=1 agentlink doctor` (macOS, Linux). If it says "on, but this program uses its own connections", the connection could not be joined, for example because of an older version; messages still work.

For how it works inside, see [Shared server connection, under the hood](../../technical/concepts/shared-server-connection.md). For how messages travel in general, see [How messages are delivered](../everyday-use/how-messages-are-delivered.md) and [Use your own servers](use-your-own-servers.md).

Back to [Under the hood](under-the-hood.md) or [The local app](README.md).
