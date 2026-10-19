---
'@4thtech-io/agentlink': patch
---

M1-9d-1: the file tools. `agentlink_send` takes `path` (one file from an owner-allowed folder, checked with realpath by the Node platform and never opened when refused; the result's `file` carries name, size, hash, delivery and expiry only) and the new `agentlink_fetch_file` saves a received file into the inbox folder after both hashes verify. Refusals map to fixed, plain-language results (`NO_ALLOWED_FOLDER`, `OUTSIDE_ALLOWED_FOLDER`, `PATH_NOT_ALLOWED`, `NEEDS_OWN_STORAGE` and the rest). The runtime supplies the core's files platform: the allowed folders, the inbox folder (created 0700, exclusive 0600 files, renames that never overwrite), the SSRF-safe download and the 4thTech drop at its fixed origin.
