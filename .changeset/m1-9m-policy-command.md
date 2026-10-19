---
'@4thtech-io/agentlink': patch
---

`agentlink policy show`, `agentlink policy allow-folder <path>` and `agentlink policy remove-folder <path>` (owner operations): the owner's allowed folders for sending files, stored as the folder's canonical realpath in a new owner-signed `policy.set` built from the current verified policy. Symbolic links, relative paths, the root, the home folder or a folder above it, and hidden or protected folders are refused before the owner code is asked; no MCP tool can reach the command.
