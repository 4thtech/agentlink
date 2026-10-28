---
'@4thtech-io/types': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

U3-d: create an agent and rename one from the local app, and name your agent at first run (D-138, 08 §1, 04 §2.5.1, §2.8). New local owner actions `agent.label`, `app.connect` and `app.disconnect` (schemas; `params.agent` must be the body's `agent`, 600 s, never in an envelope). Core applies `agent.label` (label in its own restricted form, else `label_invalid`), stores it sealed with its nonce row in the new `local_owner_actions` table (store schema 7, a forward migration) and re-verifies it on every load. `POST /api/ui/agents {label}` creates a keychain agent in a folder named from the label and signs its first card, first policy and first label with one Touch ID, all or nothing; `POST /api/ui/agents/label {name, label}` renames the open agent with Touch ID; `GET /api/ui/agents/label-check` checks a label first. First run `begin`/`finish` also take `{label}` and never write an AI app config. The open agent is now named by its verified label (or its folder name), never by the unsigned label in config.json.
