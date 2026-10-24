---
'@4thtech-io/core': minor
---

Storage page reads for the local UI (M1-11r-c): `client.files.dropUsage()` (this agent's drop bytes in the rolling 7 days against the weekly quota, with a within, near or reached level and the reset time) and `client.ownStorage.status()` with `ownStorage.recordTest({ok, code})` (none, ready or broken, the provider and the last test result). New optional `DropConfig.weeklyQuotaBytes` for a staging or self-hosted drop. Numbers, fixed codes and the provider only: never an endpoint, bucket, credential, locator or URL.
