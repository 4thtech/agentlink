---
section: Added
---

- `agentlink owner servers` (NET-CLI, S2, D-158, 06 §8, 04 §2.6, 11 §5.14): the terminal twin of "Use your own servers". `list` and `test <wss://…>…` are read-only, need no master code and take `--json`; `set <wss://…>… [--no-automatic] [--no-announce]` and `reset` run only in a terminal you opened yourself (piped input and an AI app's terminal are refused), show the review first (the servers and their roles, the old servers and until when they are still read, the contacts told and any warning), then ask for your master code and change the servers exactly as the app does. A change that would keep more than 16 old servers is refused with the date from which it fits. `--no-announce` works only with `--no-automatic`. AI apps cannot reach it.
